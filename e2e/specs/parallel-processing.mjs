/* Issue #30: parallel processing. By default the scheduler never
   double-books an operator. But a manual placement (via the job modal's
   Equipment/Planned start date fields, or a drag on the Schedule view) that
   creates a genuine operator conflict should prompt — rather than silently
   leaving one job unassigned and flagged overbooked — offering to tag one of
   the two jobs as parallel-processing-capable, a tag that then travels with
   that job to any future pairing, not just this one. */

import { modalSel, clearToast } from '../lib/harness.mjs';

export default async function run({ page, check, errors, baseUrl }) {
  const modal = () => page.locator(modalSel);

  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.click('nav >> text=Job Backlog');
  await page.waitForTimeout(400);

  // The last day of the 150-day forward horizon: a pinned job with nowhere
  // left to spill forward into is what turns "same operator, same day" into
  // a genuine, unavoidable conflict rather than the second job quietly
  // landing on the next day the operator's free (which is what a pin
  // normally does when its exact day doesn't work out). Alex's default
  // roster is Mon-Fri only, so day 149 has to actually be a day Alex works —
  // otherwise the pin fails outright before either job's own conflict logic
  // is ever exercised (this used to hardcode +149 with no such check, so it
  // flaked roughly two days out of every seven, whenever day 149 happened to
  // land on a weekend). Stepping back onto the nearest weekday keeps this at
  // (or one/two days short of) the true edge of the horizon either way,
  // since the weekend day(s) skipped over were never usable by Alex anyway.
  const lastDay = new Date();
  lastDay.setDate(lastDay.getDate() + 149);
  while (lastDay.getDay() === 0 || lastDay.getDay() === 6) lastDay.setDate(lastDay.getDate() - 1);
  const lastDayIso = lastDay.toISOString().slice(0, 10);

  async function makeJob(name, equipLabel, dateIso = lastDayIso) {
    await page.click('button:has-text("New job")');
    await page.waitForSelector(modalSel);
    await page.waitForTimeout(200);
    await modal().locator('button:has-text("Set up a custom")').click();
    await modal().getByLabel(/job name/i).fill(name);
    await modal().locator('label:has-text("Quantity") input').fill('8');
    await modal().locator('label:has-text("Hours per unit") input').fill('1');
    await modal().locator('label:has-text("Assigned to") select').selectOption({ label: 'Alex' });
    // Exact match, not has-text: "Preferred equipment (optional)" also
    // contains the substring "Equipment" and would make this ambiguous.
    await modal().locator('label:has(span:text-is("Equipment")) select').selectOption({ label: equipLabel });
    await modal().locator('label:has-text("Planned start date") input[type=date]').fill(dateIso);
    await modal().getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForTimeout(700);
  }

  await makeJob('Parallel Test A', 'Weld Robot 1');
  check('#30 the first job pins cleanly, no conflict dialog yet', (await modal().count()) === 0);

  await makeJob('Parallel Test B', 'Weld Robot 2');
  // .count() doesn't auto-wait like an action/assertion locator does — give
  // the post-recompute dialog a real chance to mount before asserting on it,
  // or this races the state update and reads a false "not there yet".
  await modal().locator('h3:has-text("Overbooked")').waitFor({ state: 'visible', timeout: 4000 }).catch(() => {});
  check('#30 pinning a second job needing the same operator opens the overbooked prompt',
        (await modal().count()) === 1 && (await modal().locator('h3:has-text("Overbooked")').count()) === 1);

  const dialogText = await modal().innerText();
  check('#30 the prompt names the operator and both jobs',
        /Alex/.test(dialogText) && /Parallel Test A/.test(dialogText) && /Parallel Test B/.test(dialogText),
        dialogText.slice(0, 200));

  // "Leave overbooked" just dismisses it — nothing granted, still conflicted.
  await modal().locator('button:has-text("Leave overbooked")').click();
  await page.waitForTimeout(300);
  check('#30 "Leave overbooked" dismisses the prompt without changing anything',
        (await modal().count()) === 0);
  let jobs = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_jobs') || '[]'));
  let a = jobs.find((j) => j.name === 'Parallel Test A');
  check('#30 declining leaves it genuinely overbooked, not silently resolved',
        a.assignment.conflict === true && !a.parallelProcessing);

  // Re-trigger the same conflict and this time grant parallel processing.
  await page.locator('tr:has-text("Parallel Test A")').first().locator('button[title="Edit"]').click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(200);
  await modal().getByRole('button', { name: 'Save', exact: true }).click();
  await modal().locator('h3:has-text("Overbooked")').waitFor({ state: 'visible', timeout: 4000 }).catch(() => {});
  check('#30 the prompt reappears on the next manual save of the losing job',
        (await modal().locator('h3:has-text("Overbooked")').count()) === 1);
  await modal().locator('button:has-text("Allow parallel processing on Parallel Test A")').click();
  await page.waitForTimeout(700);
  check('#30 picking a job closes the prompt', (await modal().count()) === 0);
  await clearToast(page);

  jobs = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_jobs') || '[]'));
  a = jobs.find((j) => j.name === 'Parallel Test A');
  const b = jobs.find((j) => j.name === 'Parallel Test B');
  check('#30 the tagged job is flagged and no longer conflicted',
        a.parallelProcessing === true && a.assignment.conflict === false,
        JSON.stringify({ tag: a.parallelProcessing, conflict: a.assignment.conflict }));
  check('#30 the other job is unaffected and also clean', b.assignment.conflict === false && !b.parallelProcessing);
  const aStaff = a.assignment.days.map((d) => d.staffId);
  const bStaff = b.assignment.days.map((d) => d.staffId);
  check('#30 the same operator genuinely covers both at once',
        aStaff.includes('st_1') && bStaff.includes('st_1'), JSON.stringify({ aStaff, bStaff }));

  // Reopening shows the checkbox already checked — it's a real, visible,
  // editable job property, not something only the prompt can set.
  await page.locator('tr:has-text("Parallel Test A")').first().locator('button[title="Edit"]').click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(200);
  const checkbox = modal().locator('label:has-text("Allow parallel processing") input[type=checkbox]');
  check('#30 the job modal shows the tag as checked', await checkbox.isChecked());
  await page.mouse.click(5, 5);
  await page.waitForTimeout(300);

  // The tag survives a move onto a day it's never contended for before,
  // against a job it's never met — it's a property of the job, not the
  // pairing it happened to be granted from. Moved off lastDayIso entirely
  // (leaving B there alone, uncontended) so this is a clean two-job check,
  // not entangled with B's own claim on lastDayIso. Derived from `lastDay`
  // itself (one weekday earlier), not a second independent +148 offset from
  // today — hardcoding both separately meant that once `lastDay` above got
  // adjusted to skip a weekend, the two could land on the very same day,
  // collapsing the "clean two-job" separation this comment relies on.
  const secondLastDay = new Date(lastDay);
  secondLastDay.setDate(secondLastDay.getDate() - 1);
  while (secondLastDay.getDay() === 0 || secondLastDay.getDay() === 6) secondLastDay.setDate(secondLastDay.getDate() - 1);
  const secondLastDayIso = secondLastDay.toISOString().slice(0, 10);

  await page.locator('tr:has-text("Parallel Test A")').first().locator('button[title="Edit"]').click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(200);
  await modal().locator('label:has-text("Planned start date") input[type=date]').fill(secondLastDayIso);
  await modal().getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForTimeout(700);
  check('#30 moving the tagged job onto an empty day triggers no prompt (nothing to contend with yet)',
        (await modal().count()) === 0);

  // Pinned straight onto secondLastDayIso (not the default lastDayIso), so
  // this only ever contends with the now-moved, still-tagged A — not with B,
  // which is left alone on lastDayIso.
  await makeJob('Parallel Test C', 'Weld Robot 3', secondLastDayIso);
  check('#30 a brand-new job pinned against the moved, still-tagged job triggers no prompt',
        (await modal().count()) === 0);

  jobs = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_jobs') || '[]'));
  const a2 = jobs.find((j) => j.name === 'Parallel Test A');
  const c = jobs.find((j) => j.name === 'Parallel Test C');
  check('#30 both land cleanly, sharing the operator, with no re-grant needed',
        a2.assignment.conflict === false && c.assignment.conflict === false
        && a2.assignment.days.map((d) => d.staffId).includes('st_1')
        && c.assignment.days.map((d) => d.staffId).includes('st_1'),
        JSON.stringify({ aConflict: a2.assignment.conflict, cConflict: c.assignment.conflict }));

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

run.suiteName = 'parallel-processing';
