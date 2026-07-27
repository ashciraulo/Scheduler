/* Issue #47: a batch of same-process jobs should run back to back on the
   same equipment instead of being scattered across whichever machine has
   room first. */

import { modalSel } from '../lib/harness.mjs';

export default async function run({ page, check, errors, baseUrl }) {
  const modal = () => page.locator(modalSel);

  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');

  await page.click('nav >> text=Job Backlog');
  await page.waitForTimeout(400);

  async function addJob(name, hours) {
    await page.click('button:has-text("New job")');
    await page.waitForSelector(modalSel);
    await page.waitForTimeout(300);
    const link = modal().locator('text=Set up a custom (one-off) job instead');
    if (await link.count()) await link.click();
    await page.waitForTimeout(200);
    await modal().getByLabel(/job name/i).fill(name);
    await modal().locator('label:has-text("Quantity") input').fill('1');
    await modal().locator('label:has-text("Hours per unit") input').fill(String(hours));
    await modal().getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForTimeout(400);
  }

  // All three use the seed default process (Robotic MIG Welding via the
  // first template), so they're all batch-compatible with each other.
  await addJob('Batch Widget A', 4);
  await addJob('Batch Widget B', 4);
  await addJob('Batch Widget C', 4);
  await page.waitForTimeout(300);

  for (const n of ['A', 'B', 'C']) {
    await page.locator('tr', { hasText: `Batch Widget ${n}` }).locator('input[type=checkbox]').check();
  }
  const batchBtn = page.locator('button:has-text("Batch 3 jobs")');
  check('#47 the batch button is enabled for 3 same-process jobs', await batchBtn.isEnabled());
  await batchBtn.click();
  await page.waitForTimeout(500);

  check('#47 a toast confirms the batch', (await page.locator('text=Batched 3 jobs').count()) === 1);
  check('#47 each row shows its position in the batch',
        (await page.locator('text=batch #1').count()) === 1
        && (await page.locator('text=batch #2').count()) === 1
        && (await page.locator('text=batch #3').count()) === 1);

  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_jobs') || '[]')
    .filter((j) => j.name.startsWith('Batch Widget'))
    .sort((a, b) => a.batchOrder - b.batchOrder));
  const sameEquip = new Set(stored.map((j) => j.assignment?.equipmentId));
  check('#47 all three members land on the same equipment', sameEquip.size === 1, JSON.stringify([...sameEquip]));
  check('#47 all three are actually placed (no partial placement)', stored.every((j) => j.assignment), JSON.stringify(stored.map((j) => j.assignment)));
  // 4h + 4h fits one 8h day; the third spills to the next working day rather
  // than any of them landing on a different machine.
  check('#47 members run back to back — the day-total for the group never exceeds the 8h shift',
        stored[0].assignment.startDate === stored[1].assignment.startDate
        && stored[2].assignment.startDate > stored[0].assignment.startDate,
        JSON.stringify(stored.map((j) => j.assignment.startDate)));

  // Leaving the batch removes just that one job's membership.
  await page.locator('tr', { hasText: 'Batch Widget B' }).locator('button[title="Remove from batch"]').click();
  await page.waitForTimeout(400);
  const afterLeave = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_jobs') || '[]')
    .filter((j) => j.name.startsWith('Batch Widget'))
    .map((j) => ({ name: j.name, batchId: j.batchId })));
  const b = afterLeave.find((j) => j.name === 'Batch Widget B');
  const others = afterLeave.filter((j) => j.name !== 'Batch Widget B');
  check('#47 leaving the batch clears batchId on just that job', b.batchId === null, JSON.stringify(afterLeave));
  check('#47 the rest of the batch is untouched', others.every((j) => !!j.batchId), JSON.stringify(afterLeave));

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

run.suiteName = 'batching';
