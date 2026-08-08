/* The "Log hours" modal (TimeLogModal) needed to show a job's number
   (bcJobNo) alongside its name — reported directly: with several
   similarly-named jobs on the go, the name alone wasn't always enough to
   tell them apart while logging hours. Same field/formatting the
   Backlog's own "Job #" column and the Schedule view's tooltips already
   use — `—` when a job has none, not a blank cell. Also reflected in the
   "Also worked on" picker's own option labels, for the same reason. */

import { modalSel } from '../lib/harness.mjs';

export default async function run({ page, check, errors, baseUrl }) {
  const modal = () => page.locator(modalSel);

  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  const today = await page.evaluate(() => new Date().toISOString().slice(0, 10));
  await page.evaluate((today) => {
    const jobs = [{
      id: 'job_numbered', name: 'Bracket Weld Job', process: 'Robotic MIG Welding', quantity: 1, hoursTotal: 8,
      dueDate: '2026-12-01', departmentDueDate: null, readyDate: today, templateId: null, notes: '',
      totalValue: 0, departmentValue: 0, percentComplete: 0, needsFurtherProcessing: false,
      status: 'active', completedDate: null, actualHours: null, batchId: null, batchOrder: null,
      tags: [], procedureId: '', bcJobNo: 'J00456', bcJobTaskNo: '10', staffId: null,
      isRework: false, reworkOfJobId: null, updatedAt: new Date().toISOString(), assignment: null,
    }, {
      id: 'job_unnumbered', name: 'Unlinked Job', process: 'Robotic MIG Welding', quantity: 1, hoursTotal: 4,
      dueDate: '2026-12-01', departmentDueDate: null, readyDate: today, templateId: null, notes: '',
      totalValue: 0, departmentValue: 0, percentComplete: 0, needsFurtherProcessing: false,
      status: 'active', completedDate: null, actualHours: null, batchId: null, batchOrder: null,
      tags: [], procedureId: '', bcJobNo: '', bcJobTaskNo: '', staffId: null,
      isRework: false, reworkOfJobId: null, updatedAt: new Date().toISOString(), assignment: null,
    }];
    localStorage.setItem('wf::wf_jobs', JSON.stringify(jobs));
  }, today);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.waitForTimeout(400);

  await page.click('button:has-text("Log hours")');
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);

  const headers = (await modal().locator('thead th').allInnerTexts()).map((h) => h.trim().toLowerCase());
  check('the daily log table has a "Job #" column, ahead of "Job"', headers[0] === 'job #' && headers[1] === 'job', JSON.stringify(headers));

  // Neither job was scheduled for today (assignment: null), so both reach
  // the table only via "Also worked on" — which is exactly where a job
  // number most needs to disambiguate, since it's a plain job-name list.
  // Located relative to its own label, not `select().first()` — once a
  // row is added, that row's own "Who" select sorts before this one in
  // DOM order, so a plain `.first()` would start hitting the wrong select.
  const addSelect = modal().locator('span:has-text("Also worked on:")').locator('xpath=following-sibling::select');
  const addOptions = await addSelect.locator('option').allInnerTexts();
  check('the numbered job\'s option is prefixed with its job number', addOptions.includes('J00456 — Bracket Weld Job'), JSON.stringify(addOptions));
  check('the un-numbered job\'s option has no dangling prefix', addOptions.includes('Unlinked Job'), JSON.stringify(addOptions));

  await addSelect.selectOption({ label: 'J00456 — Bracket Weld Job' });
  await modal().locator('button:has-text("Add")').click();
  await page.waitForTimeout(200);
  await addSelect.selectOption({ label: 'Unlinked Job' });
  await modal().locator('button:has-text("Add")').click();
  await page.waitForTimeout(200);

  const numberedRow = modal().locator('tbody tr', { hasText: 'Bracket Weld Job' });
  check('the numbered job\'s row shows its job number in the first cell', (await numberedRow.locator('td').first().innerText()).trim() === 'J00456');

  const unnumberedRow = modal().locator('tbody tr', { hasText: 'Unlinked Job' });
  check('a job with no bcJobNo shows "—", not a blank cell', (await unnumberedRow.locator('td').first().innerText()).trim() === '—');

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

run.suiteName = 'log-hours-job-number';
