/* Issue #32: a person rostered for more than the default 8h shift was
   getting capped at 8h on whichever job they were doing, with the scheduler
   handing the rest of their rostered day to an unrelated job on different
   equipment. The equipment-side shift capacity now scales to whoever's
   actually rostered onto it (scheduler.js's shiftCapacity), not a fixed
   constant — this drives it end-to-end through the real UI: roster someone
   for a 12h day, pin a 12h job to them, confirm they get the whole day. */

import { modalSel } from '../lib/harness.mjs';

export default async function run({ page, check, errors, baseUrl }) {
  const modal = () => page.locator(modalSel);

  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');

  // Roster Alex for a 12h Monday.
  await page.click('nav >> text=Staff');
  await page.waitForTimeout(400);
  const alexRow = page.locator('tr', { hasText: 'Alex' }).first();
  const monHoursInput = alexRow.locator('td').nth(1).locator('input[type=number]');
  await monHoursInput.fill('12');
  await monHoursInput.blur();
  await page.waitForTimeout(500);

  const staffAfter = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('wf::wf_staff') || '[]').find((s) => s.name === 'Alex'));
  check('#32 the roster editor saved the 12h Monday', staffAfter?.weeklyRoster?.mon?.hours === 12,
        JSON.stringify(staffAfter?.weeklyRoster?.mon));

  // Pin a 12h job to Alex on the coming Monday.
  await page.click('nav >> text=Job Backlog');
  await page.waitForTimeout(400);
  await page.click('button:has-text("New job")');
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(200);
  await modal().locator('button:has-text("Set up a custom")').click();
  await modal().getByLabel(/job name/i).fill('Long Shift Test');
  await modal().locator('label:has-text("Quantity") input').fill('12');
  await modal().locator('label:has-text("Hours per unit") input').fill('1');
  await modal().locator('label:has-text("Assigned to") select').selectOption({ label: 'Alex' });
  const equipSelect = modal().locator('label:has-text("Equipment") select');
  const firstEquipVal = await equipSelect.locator('option').nth(1).getAttribute('value');
  await equipSelect.selectOption(firstEquipVal);
  const readyVal = await modal().locator('label:has-text("Ready for processing") input[type=date]').inputValue();
  await modal().locator('label:has-text("Planned start date") input[type=date]').fill(readyVal);
  await modal().getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForTimeout(700);

  const jobs = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_jobs') || '[]'));
  const j = jobs.find((x) => x.name === 'Long Shift Test');
  const hoursOnStartDay = (j.assignment.days || [])
    .filter((d) => d.date === j.assignment.startDate)
    .reduce((s, d) => s + d.hours, 0);
  check('#32 the full 12h goes to this one job on its first day, not capped at 8h',
        hoursOnStartDay === 12, JSON.stringify(j.assignment.days));
  check('#32 the job does not spill onto a second day for hours the roster already covers',
        j.assignment.startDate === j.assignment.endDate,
        `${j.assignment.startDate} -> ${j.assignment.endDate}`);

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

run.suiteName = 'shift-capacity';
