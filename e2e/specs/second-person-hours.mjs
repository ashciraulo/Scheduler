/* A training partner's own hours, logged separately from the primary's —
   see the "Two-person jobs" note on separately-logged hours in
   scheduler/CLAUDE.md. Example from the request: primary spends 20h on a
   job, the trainee rides along but only actually works 4h of it — the
   daily hours log needs to capture both figures independently, and the
   R&D/Quality reports need to show them as two separate entries (20h for
   one person, 4h for the other), not one blended total. The job/task's
   own scheduled duration stays based on the primary's hours alone — this
   is purely about what gets logged after the fact, nothing about
   placement.

   Applies uniformly to jobs and tasks (TimeLogModal already merges both
   into one `jobs` prop) — this spec exercises a task (mirroring the
   feature's own R&D framing) and a plain job (regression, since
   job.secondStaffId predates task.secondStaffId), plus the "no pairing,
   no second field" and "split job, no second field" cases. */

import { modalSel, isoDate, nextWeekday } from '../lib/harness.mjs';

export default async function run({ page, check, errors, baseUrl }) {
  const modal = () => page.locator(modalSel);
  const anchorIso = isoDate(nextWeekday(new Date()));

  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.evaluate((anchorIso) => {
    const roster = {
      mon: { working: true, production: true, shift: 'day', hours: 8 }, tue: { working: true, production: true, shift: 'day', hours: 8 },
      wed: { working: true, production: true, shift: 'day', hours: 8 }, thu: { working: true, production: true, shift: 'day', hours: 8 },
      fri: { working: true, production: true, shift: 'day', hours: 8 }, sat: { working: false, production: true, shift: 'day', hours: 0 },
      sun: { working: false, production: true, shift: 'day', hours: 0 },
    };
    const staff = [
      { id: 'st_1', name: 'Alex', processes: ['Robotic MIG Welding'], weeklyRoster: roster, leavePeriods: [], color: null },
      { id: 'st_2', name: 'Jordan', processes: ['Robotic MIG Welding'], weeklyRoster: roster, leavePeriods: [], color: null },
    ];
    const equipment = [{ id: 'eq_1', name: 'Cell 1', type: 'Welding Robot', tags: [], processes: ['Robotic MIG Welding'], unavailableDates: [] }];
    const procedures = [{
      id: 'proc_1', name: 'Trial procedure', process: 'Robotic MIG Welding', costCentreId: '', substrate: '', notes: '',
      powder: {}, gases: [], electricity: {}, spares: [], maintenance: [], consumables: [],
      labour: [{ name: 'Welder', rate: 50, count: 1 }], qa: [],
    }];
    const tasks = [{
      id: 'task_paired', name: 'Paired task', process: 'Robotic MIG Welding', procedureId: 'proc_1',
      hoursTotal: 20, readyDate: anchorIso, dueDate: anchorIso, projectId: null, staffId: 'st_1', secondStaffId: 'st_2', notes: '',
      status: 'active', completedDate: null, actualHours: null, updatedAt: new Date().toISOString(),
      assignment: { equipmentId: 'eq_1', startDate: anchorIso, endDate: anchorIso, pinned: true, days: [] },
    }, {
      id: 'task_solo', name: 'Solo task', process: 'Robotic MIG Welding', procedureId: '',
      hoursTotal: 3, readyDate: anchorIso, dueDate: anchorIso, projectId: null, staffId: null, notes: '',
      status: 'active', completedDate: null, actualHours: null, updatedAt: new Date().toISOString(),
      assignment: { equipmentId: 'eq_1', startDate: anchorIso, endDate: anchorIso, pinned: true, days: [] },
    }];
    const jobs = [{
      id: 'job_paired', name: 'Paired job', process: 'Robotic MIG Welding', quantity: 1, hoursTotal: 10,
      dueDate: '2026-12-01', departmentDueDate: null, readyDate: anchorIso, templateId: null, notes: '',
      totalValue: 0, departmentValue: 0, percentComplete: 0, needsFurtherProcessing: false,
      status: 'active', completedDate: null, batchId: null, batchOrder: null, tags: [], procedureId: '',
      bcJobNo: '', bcJobTaskNo: '', staffId: 'st_1', secondStaffId: 'st_2', updatedAt: new Date().toISOString(),
      assignment: { equipmentId: 'eq_1', startDate: anchorIso, endDate: anchorIso, pinned: true, days: [] },
    }];
    localStorage.setItem('wf::wf_staff', JSON.stringify(staff));
    localStorage.setItem('wf::wf_equipment', JSON.stringify(equipment));
    localStorage.setItem('wf::wf_procedures', JSON.stringify(procedures));
    localStorage.setItem('wf::wf_costcentres', JSON.stringify([]));
    localStorage.setItem('wf::wf_jobs', JSON.stringify(jobs));
    localStorage.setItem('wf::wf_tasks', JSON.stringify(tasks));
    localStorage.setItem('wf::wf_projects', JSON.stringify([]));
  }, anchorIso);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.waitForTimeout(500);

  // ---- open the daily log; a paired task shows two hours inputs ----
  await page.click('button:has-text("Log hours")');
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);

  const pairedRow = modal().locator('tr', { hasText: 'Paired task' });
  check('a paired task shows two hours inputs — primary and training partner', (await pairedRow.locator('input[type=number]').count()) === 2);
  check('the second one is labelled with the training partner\'s name', (await pairedRow.locator('div', { hasText: 'Jordan' }).locator('text=training').count()) > 0);

  const soloRow = modal().locator('tr', { hasText: 'Solo task' });
  check('an unpaired task shows only one hours input', (await soloRow.locator('input[type=number]').count()) === 1);

  const pairedJobRow = modal().locator('tr', { hasText: 'Paired job' });
  check('the same applies to a paired JOB, not just a task (job.secondStaffId predates task.secondStaffId)', (await pairedJobRow.locator('input[type=number]').count()) === 2);

  // ---- log 20h primary, 4h secondary on the task ----
  await pairedRow.locator('select').selectOption('st_1');
  await pairedRow.locator('input[type=number]').nth(0).fill('20');
  await pairedRow.locator('input[type=number]').nth(1).fill('4');
  await modal().getByRole('button', { name: /Save log/i }).click();
  await page.waitForTimeout(700);

  const entries = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_timelog') || '[]').filter((e) => e.jobId === 'task_paired'));
  check('two separate log entries were created, not one blended total', entries.length === 2);
  const primaryEntry = entries.find((e) => e.staffId === 'st_1');
  const secondEntry = entries.find((e) => e.staffId === 'st_2');
  check('the primary\'s entry has the primary\'s hours', primaryEntry?.hours === 20);
  check('the second person\'s entry has THEIR OWN hours, not the primary\'s', secondEntry?.hours === 4);

  // ---- reopening the log shows both values correctly, not swapped ----
  await page.click('button:has-text("Log hours")');
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);
  const reopened = modal().locator('tr', { hasText: 'Paired task' }).locator('input[type=number]');
  check('reopened: primary hours still 20', (await reopened.nth(0).inputValue()) === '20');
  check('reopened: training partner hours still 4, not swapped with the primary\'s', (await reopened.nth(1).inputValue()) === '4');
  await modal().locator('button').first().click();
  await page.waitForSelector(modalSel, { state: 'detached' });
  await page.waitForTimeout(300);

  // ---- the R&D report shows two separate rows, correctly attributed ----
  await page.click('nav >> text=R&D');
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: 'Report', exact: true }).click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(400);
  const reportRows = await modal().locator('tbody tr', { hasText: 'Paired task' }).allInnerTexts();
  check('the report has exactly two rows for the paired task — one per person', reportRows.length === 2, JSON.stringify(reportRows));
  const alexRow = reportRows.find((r) => r.includes('Alex'));
  const jordanRow = reportRows.find((r) => r.includes('Jordan'));
  check('the primary\'s row: 20h for Alex, costed at the procedure rate ($50/hr × 20h = $1,000.00)',
        !!alexRow && /\b20\b/.test(alexRow) && alexRow.includes('1,000.00'), alexRow);
  check('the trainee\'s row, separately: 4h for Jordan, on its own line ($50/hr × 4h = $200.00)',
        !!jordanRow && /\b4\b/.test(jordanRow) && jordanRow.includes('200.00'), jordanRow);

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

run.suiteName = 'second-person-hours';
