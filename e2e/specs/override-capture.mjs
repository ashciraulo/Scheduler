/* Override capture: recording where the user overruled the scheduler, so a
   later pass can ask which scoring terms are systematically mis-weighted.
   See scheduler/src/overrides.js.

   This is browser-level on purpose. The pure logic is unit-tested already;
   what can only break here is the WIRING, and it did: the first version
   traced only inside `recompute`, which silently missed the initial page load,
   so on a freshly opened page the very first correction of a session — the one
   most worth having — recorded nothing at all. Unit tests cannot see that.

   The invariant that matters most: capture is pure observation. A correction
   must be recorded WITHOUT changing where the job actually lands. */

import { modalSel } from '../lib/harness.mjs';

const OVERRIDES = 'wf::wf_overrides';

export default async function run({ page, check, errors, baseUrl }) {
  const modal = () => page.locator(modalSel);
  const overrides = () => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || '[]'), OVERRIDES);

  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.waitForTimeout(500);

  check('capture starts empty on a fresh install', (await overrides()).length === 0);

  const target = await page.evaluate(() => {
    const j = JSON.parse(localStorage.getItem('wf::wf_jobs') || '[]')
      .find((x) => x.assignment && !x.assignment.pinned && !x.parts);
    return j && { name: j.name, eq: j.assignment.equipmentId, start: j.assignment.startDate };
  });
  check('found an auto-placed job to override', !!target, JSON.stringify(target));

  // ---- opening and saving a job unchanged is not a correction ----
  await page.click('nav >> text=Job Backlog');
  await page.waitForTimeout(400);
  const openJob = async () => {
    await page.locator('tr', { hasText: target.name }).first().locator('button[title="Edit"]').click();
    await page.waitForSelector(modalSel);
    await page.waitForTimeout(300);
  };
  await openJob();
  await modal().getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForTimeout(600);
  check('opening and saving a job unchanged records nothing',
        (await overrides()).length === 0,
        'confirming a placement is not a correction — logging it would flood the history with zero-signal records');

  // ---- locking to another machine IS a correction ----
  await openJob();
  const lockSel = modal().locator('label:has(span:text-is("Locked equipment (optional)")) select');
  const otherEq = await lockSel.locator('option').evaluateAll(
    (os, eq) => os.map((o) => o.value).find((v) => v && v !== eq), target.eq);
  await lockSel.selectOption(otherEq);
  await modal().getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForTimeout(700);

  const afterLock = await overrides();
  check('locking a job to a different machine is recorded', afterLock.length === 1, `${afterLock.length}`);
  const rec = afterLock[afterLock.length - 1] || {};
  check('the record names the source', rec.source === 'lock', rec.source);
  check('a lock names a machine but no day, so only equipment is flagged as changed',
        JSON.stringify(rec.changed) === '["equipment"]', JSON.stringify(rec.changed));
  check('it pairs the scheduler’s choice with the user’s',
        rec.scheduler?.equipmentId === target.eq && rec.user?.equipmentId === otherEq,
        `${rec.scheduler?.equipmentId} -> ${rec.user?.equipmentId}`);
  check('the job name is denormalised so the record outlives the job',
        rec.jobName === target.name, rec.jobName);
  check('both picks were evaluated, so a comparable delta is stored',
        rec.comparable === true && !!rec.delta, JSON.stringify({ comparable: rec.comparable, delta: rec.delta }));

  // The whole point of capture is that it observes without interfering.
  const landed = await page.evaluate((n) => JSON.parse(localStorage.getItem('wf::wf_jobs') || '[]')
    .find((j) => j.name === n)?.assignment, target.name);
  check('capture did not disturb the placement — the lock was still honoured',
        landed?.equipmentId === otherEq, JSON.stringify(landed));
  check('and the job is NOT pinned — a lock still lets the scheduler pick the day',
        landed?.pinned === false, `pinned=${landed?.pinned}`);

  // ---- a drag onto a day the scheduler never evaluated ----
  // runScheduler only ever evaluates one placement per machine (its earliest
  // slot), so a different day has no feature vector. The record is kept, but
  // the delta must be refused rather than computed against the wrong row.
  //
  // Deliberately does NOT clear the store first: wiping localStorage wouldn't
  // clear the component's own state, so the next append would just write both
  // records back and the "new" one wouldn't be at index 0. Appending to the
  // existing history and reading the LAST record is what actually holds.
  const beforeDrag = (await overrides()).length;
  await page.click('nav >> text=Schedule');
  await page.waitForTimeout(600);

  const nameCell = page.locator('div', { hasText: target.name })
    .filter({ has: page.locator('span.font-mono') }).last();
  const eqHeader = page.locator('span.font-semibold', { hasText: 'Weld Robot 3' });
  await eqHeader.scrollIntoViewIfNeeded();
  const box = await eqHeader.boundingBox();
  if (box) {
    await nameCell.hover();
    await page.mouse.down();
    await page.mouse.move(box.x + 500, box.y + 40, { steps: 10 });
    await page.mouse.move(box.x + 500, box.y + 40, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(700);

    const dragRecs = await overrides();
    const d = dragRecs[dragRecs.length - 1] || {};
    check('a drag is recorded too, appended with its own source',
          dragRecs.length === beforeDrag + 1 && d.source === 'drag',
          JSON.stringify(dragRecs.map((r) => r.source)));
    check('the history accumulates rather than being replaced',
          dragRecs.length > 1 && dragRecs[0].source === 'lock',
          JSON.stringify(dragRecs.map((r) => r.source)));
    if (d.user && d.user.atCandidateStart === false) {
      check('a move to an unevaluated day is kept but yields no delta',
            d.comparable === false && d.delta === null,
            'a delta computed against the wrong day would drag learned weights sideways with nothing to show for it');
    }
  }

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

run.suiteName = 'override-capture';
