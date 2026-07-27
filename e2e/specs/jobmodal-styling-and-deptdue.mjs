/* Issues #43 (Scheduling section rendered as a low-contrast grey box) and
   #44 (a separate, optional department due date that overrides dueDate for
   scheduling purposes when it's earlier). */

import { modalSel } from '../lib/harness.mjs';

export default async function run({ page, check, errors, baseUrl }) {
  const modal = () => page.locator(modalSel);

  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');

  // ---- #43: the Scheduling section is no longer a washed-out grey box ----
  await page.click('nav >> text=Job Backlog');
  await page.waitForTimeout(400);
  await page.locator('table tbody tr').first().locator('button[title="Edit"]').click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);

  const schedulingSection = modal().locator('button:has-text("Scheduling")').first().locator('xpath=..');
  const bg = await schedulingSection.evaluate((el) => getComputedStyle(el).backgroundColor);
  // index.css maps bg-slate-800/50 to #EEF0F2 -> rgb(238, 240, 242). The old,
  // unmapped bg-slate-900/40 fell through to raw Tailwind dark slate at 40%
  // opacity, which composited to a mid-grey nowhere near this light.
  check('#43 the Scheduling section uses the mapped light panel colour, not raw dark slate',
        bg === 'rgb(238, 240, 242)', bg);

  const label = modal().locator('span:has-text("Needs further processing after this department")').first();
  const labelColor = await label.evaluate((el) => getComputedStyle(el).color);
  check('#43 body text inside the section is dark, readable text', labelColor === 'rgb(57, 67, 79)', labelColor);

  // ---- #44: department due date ----
  const deptField = modal().locator('label:has-text("Department due date") input');
  check('#44 the job modal has a Department due date field', (await deptField.count()) === 1);
  const dueDateValue = await modal().locator('label', { hasText: /^Due date$/ }).locator('input').inputValue();
  await deptField.fill('2026-08-01');
  await page.waitForTimeout(150);
  check('#44 setting it shows an explanatory note naming both dates',
        (await modal().locator('text=This department is scheduling to').count()) === 1);

  await modal().getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForTimeout(400);

  const savedJob = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_jobs') || '[]')
    .find((j) => j.departmentDueDate === '2026-08-01'));
  check('#44 the department due date is saved on the job', !!savedJob, JSON.stringify(savedJob));
  check('#44 the client/target due date is left untouched', savedJob?.dueDate === dueDateValue,
        `${savedJob?.dueDate} vs ${dueDateValue}`);

  // The Backlog's Due column should now show the earlier, effective date.
  const row = page.locator('tr', { hasText: savedJob.name });
  const dueCellText = await row.locator('td').nth(8).innerText();
  check('#44 the Backlog Due column shows the department due date, not the client date',
        /Aug 1/.test(dueCellText), dueCellText);

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

run.suiteName = 'jobmodal-styling-and-deptdue';
