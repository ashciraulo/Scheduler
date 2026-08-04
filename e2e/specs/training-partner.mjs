/* A second person riding along on a job — most often a trainee shadowing
   whoever's actually doing the work (job.secondStaffId, alongside the
   existing hard-lock job.staffId). See "Two-person jobs" in
   scheduler/CLAUDE.md.

   Deliberately lightweight: no sign-off required for the second person, and
   it's a pure post-check on the placement the primary already gets, not a
   second slot the scheduler searches for. What's worth guarding at browser
   level rather than only in scheduler.test.js:
   - the field is genuinely gated on a primary being picked first, in both
     the whole-job and per-part editors
   - the option list excludes the primary
   - a successful pairing round-trips through save/reload with both people
     stamped on every day of the plan
   - the tile/tooltip correctly shows the pairing
   - an unmet pairing (second person never actually free) surfaces its own
     review panel rather than silently vanishing or reading as a conflict */

import { modalSel } from '../lib/harness.mjs';

export default async function run({ page, check, errors, baseUrl }) {
  const modal = () => page.locator(modalSel);

  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.click('nav >> text=Job Backlog');
  await page.waitForTimeout(400);

  await page.locator('table tbody tr').first().locator('button[title="Edit"]').click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);

  check('Training partner is not offered before a primary is assigned',
        (await modal().locator('label:has-text("Training partner")').count()) === 0);

  const assignedSel = modal().locator('label:has(span:text-is("Assigned to")) select');
  const primaryOpts = await assignedSel.locator('option').evaluateAll((os) => os.map((o) => o.value).filter(Boolean));
  await assignedSel.selectOption(primaryOpts[0]);
  await page.waitForTimeout(200);

  const trainingField = modal().locator('label:has-text("Training partner")');
  check('Training partner appears once a primary is assigned', (await trainingField.count()) === 1);

  const trainingSel = trainingField.locator('select');
  const trainingOpts = await trainingSel.locator('option').evaluateAll((os) => os.map((o) => o.value).filter(Boolean));
  check('the primary is not offered as their own training partner',
        !trainingOpts.includes(primaryOpts[0]), JSON.stringify(trainingOpts));

  await trainingSel.selectOption(trainingOpts[0]);
  await modal().getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForTimeout(700);

  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_jobs') || '[]')
    .find((j) => j.secondStaffId));
  check('the pairing is saved on the job', !!saved, JSON.stringify(saved && { staffId: saved.staffId, secondStaffId: saved.secondStaffId }));
  check('a successful pairing is not flagged unmet', saved?.assignment?.secondStaffUnmet === false);
  check('every day of the plan carries both people, not just the primary',
        (saved?.assignment?.days || []).length > 0
        && saved.assignment.days.every((d) => d.staffId === saved.staffId && d.secondStaffId === saved.secondStaffId),
        JSON.stringify(saved?.assignment?.days));

  await page.click('nav >> text=Schedule');
  await page.waitForTimeout(700);
  const tileTitle = await page.locator(`[title*="${saved.name}"]`).first().getAttribute('title');
  const secondName = await page.evaluate((id) => JSON.parse(localStorage.getItem('wf::wf_staff') || '[]')
    .find((s) => s.id === id)?.name, saved.secondStaffId);
  check('the tile tooltip names both people, same as any other two-person handoff',
        !!secondName && tileTitle?.includes(secondName), `${tileTitle} (expected to include ${secondName})`);

  // ---- unmet pairing: the second person is never actually free ----
  await page.evaluate(() => {
    const jobs = JSON.parse(localStorage.getItem('wf::wf_jobs') || '[]');
    const staff = JSON.parse(localStorage.getItem('wf::wf_staff') || '[]');
    const target = jobs.find((j) => !j.parts && !j.secondStaffId);
    target.staffId = staff[0].id;
    target.secondStaffId = staff[1].id;
    staff[1].leavePeriods = [{ id: 'lv_perma', kind: 'leave', startDate: '2000-01-01', endDate: '2100-01-01' }];
    localStorage.setItem('wf::wf_jobs', JSON.stringify(jobs));
    localStorage.setItem('wf::wf_staff', JSON.stringify(staff));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.click('nav >> text=Schedule');
  await page.waitForTimeout(700);

  check('an unmet pairing gets its own review panel',
        (await page.locator('text=Training partner not paired').count()) > 0);
  const mainText = await page.locator('main').innerText();
  check('the panel explains the job is still scheduled fine — this is not an overbooking',
        /scheduled fine, just missing/i.test(mainText));

  const unmetJob = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_jobs') || '[]')
    .find((j) => j.assignment?.secondStaffUnmet));
  check('an unmet pairing is not flagged as a conflict', unmetJob?.assignment?.conflict === false);
  check('nothing was stamped on any day when the pairing could not be honoured',
        (unmetJob?.assignment?.days || []).every((d) => !d.secondStaffId));

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

run.suiteName = 'training-partner';
