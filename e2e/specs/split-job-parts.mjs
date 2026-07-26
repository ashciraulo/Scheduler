/* Issue #18: parts from "Split job into two parts" (job.parts — the JobModal
   feature, not the WIP-import-time row split covered by import-and-modals.mjs)
   need independently editable names, not a label recomputed from the parent's
   name at render time. */

import { modalSel, clearToast } from '../lib/harness.mjs';

export default async function run({ page, check, errors, baseUrl }) {
  const modal = () => page.locator(modalSel);

  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.click('nav >> text=Job Backlog');
  await page.waitForTimeout(400);

  const jobRow = page.locator('table tbody tr').first();
  const jobName = await jobRow.locator('td').nth(1).innerText();
  await jobRow.locator('button[title="Edit"]').click();
  await page.waitForSelector(modalSel);

  await modal().locator('button:has-text("Split job into two parts")').click();
  await page.waitForTimeout(300);
  await modal().getByRole('button', { name: 'Split', exact: true }).click();
  await page.waitForTimeout(700);

  // reopen — the parts editor should now show one Name field per part,
  // pre-filled with the old computed label so a freshly split job still
  // reads sensibly before anyone touches it
  await page.locator('table tbody tr', { hasText: jobName.trim() }).first()
    .locator('button[title="Edit"]').click();
  await page.waitForSelector(modalSel);

  const nameInputs = modal().locator('label:has-text("Name") input[type=text]');
  check('#18 the split produces one Name field per part', (await nameInputs.count()) === 2,
        `${await nameInputs.count()} field(s)`);

  const default1 = await nameInputs.nth(0).inputValue();
  const default2 = await nameInputs.nth(1).inputValue();
  check('#18 defaults are pre-filled and distinct',
        default1 !== default2 && /Part 1/.test(default1) && /Part 2/.test(default2),
        `"${default1}" / "${default2}"`);

  // rename both independently, save, and confirm the names actually stuck —
  // not just recomputed labels that happen to look editable
  await nameInputs.nth(0).fill('Rough Machining');
  await nameInputs.nth(1).fill('Final Finishing');
  await modal().getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForTimeout(700);
  await clearToast(page);

  await page.locator('table tbody tr', { hasText: jobName.trim() }).first()
    .locator('button[title="Edit"]').click();
  await page.waitForSelector(modalSel);
  const reopened = modal().locator('label:has-text("Name") input[type=text]');
  check('#18 renamed parts survive save + reopen',
        (await reopened.nth(0).inputValue()) === 'Rough Machining'
        && (await reopened.nth(1).inputValue()) === 'Final Finishing',
        `"${await reopened.nth(0).inputValue()}" / "${await reopened.nth(1).inputValue()}"`);
  await page.mouse.click(5, 5);
  await page.waitForTimeout(300);

  // #18 (the actual bug): a name has to survive the scheduler's flatten/
  // collapse round trip, which runs on nearly every action — not just this
  // one save. A full reload forces the strictest version of that path (a
  // fresh load-time recompute from storage), so it's the strongest check
  // that the name isn't quietly recomputed back to a generic label.
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.click('nav >> text=Job Backlog');
  await page.waitForTimeout(400);
  await page.locator('table tbody tr', { hasText: jobName.trim() }).first()
    .locator('button[title="Edit"]').click();
  await page.waitForSelector(modalSel);
  const afterReload = modal().locator('label:has-text("Name") input[type=text]');
  check('#18 names survive a full reload (fresh scheduler recompute)',
        (await afterReload.nth(0).inputValue()) === 'Rough Machining'
        && (await afterReload.nth(1).inputValue()) === 'Final Finishing',
        `"${await afterReload.nth(0).inputValue()}" / "${await afterReload.nth(1).inputValue()}"`);
  await page.mouse.click(5, 5);
  await page.waitForTimeout(300);

  // and the custom names should show up where the parts are actually
  // rendered, not just inside the editor
  await page.click('nav >> text=Schedule');
  await page.waitForTimeout(800);
  const scheduleText = await page.locator('body').innerText();
  check('#18 custom part names render on the Schedule view',
        scheduleText.includes('Rough Machining') && scheduleText.includes('Final Finishing'));
  check('#18 the stale computed "(Part N)" label is gone from the Schedule view',
        !scheduleText.includes('(Part 1)') && !scheduleText.includes('(Part 2)'));

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

run.suiteName = 'split-job-parts';
