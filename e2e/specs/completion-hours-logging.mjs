/* Reported directly: marking a task complete and typing actual hours into
   the "record actual hours" dialog left the R&D view showing 0h logged
   against both the task and its project — the daily hours log (wf_timelog)
   was never touched by completion at all, only the task's own actualHours
   field, which every "hours logged" reader (ProjectsView's task table,
   projectRollup) deliberately does NOT fall back to (see "The daily hours
   log" in scheduler/CLAUDE.md — that figure is meant to be the raw
   day-by-day total, kept separate from actualHours on purpose). And a
   training partner's hours had nowhere to go here at all — no field for
   them, so the only way to record them was misusing "Log past work" to
   create an unrelated, unlinked entry.

   Covers, for a task with no prior day-by-day log:
   - completing it writes a real wf_timelog entry, so it shows up in the
     R&D task table AND the project rollup, not just as actualHours
   - a training partner's hours field appears in the completion dialog and
     writes its own separate entry, summed into the same total
   - completing a job (not just a task) gets the identical fix — same
     shared modal, same shared helper
   - a side that already HAS day-by-day entries is left untouched, not
     duplicated on top of, when completed — the log stays the source of
     truth for that side, exactly like it already was for cost. */

import { modalSel } from '../lib/harness.mjs';

export default async function run({ page, check, errors, baseUrl }) {
  const modal = () => page.locator(modalSel);

  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.evaluate(() => {
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
    const projects = [{ id: 'proj_1', name: 'Coating Study', description: '', status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }];
    const tasks = [
      {
        // Never logged day by day at all — the exact gap that was reported.
        id: 'task_unlogged', name: 'Trial spray run', process: 'Robotic MIG Welding', procedureId: '',
        hoursTotal: 8, readyDate: '2026-01-01', dueDate: '2026-01-05', projectId: 'proj_1', staffId: 'st_1', secondStaffId: 'st_2', notes: '',
        status: 'active', completedDate: null, actualHours: null, updatedAt: new Date().toISOString(),
        assignment: { equipmentId: 'eq_1', startDate: '2026-01-01', endDate: '2026-01-01', pinned: true, days: [] },
      },
      {
        // Already logged day by day (primary only) — completion must not
        // duplicate this into a second entry.
        id: 'task_logged', name: 'Robot recalibration', process: 'Robotic MIG Welding', procedureId: '',
        hoursTotal: 4, readyDate: '2026-01-01', dueDate: '2026-01-05', projectId: null, staffId: 'st_1', notes: '',
        status: 'active', completedDate: null, actualHours: null, updatedAt: new Date().toISOString(),
        assignment: { equipmentId: 'eq_1', startDate: '2026-01-02', endDate: '2026-01-02', pinned: true, days: [] },
      },
    ];
    const jobs = [{
      id: 'job_unlogged', name: 'Bracket Weld', process: 'Robotic MIG Welding', quantity: 1, hoursTotal: 6,
      dueDate: '2026-12-01', departmentDueDate: null, readyDate: '2026-01-01', templateId: null, notes: '',
      totalValue: 0, departmentValue: 0, percentComplete: 0, needsFurtherProcessing: false,
      status: 'active', completedDate: null, batchId: null, batchOrder: null, tags: [], procedureId: '',
      bcJobNo: '', bcJobTaskNo: '', staffId: 'st_1', updatedAt: new Date().toISOString(),
      assignment: { equipmentId: 'eq_1', startDate: '2026-01-03', endDate: '2026-01-03', pinned: true, days: [] },
    }];
    const timeLog = [{ id: 'tl_1', jobId: 'task_logged', date: '2026-01-02', hours: 4, staffId: 'st_1', note: '' }];
    localStorage.setItem('wf::wf_staff', JSON.stringify(staff));
    localStorage.setItem('wf::wf_equipment', JSON.stringify(equipment));
    localStorage.setItem('wf::wf_procedures', JSON.stringify([]));
    localStorage.setItem('wf::wf_costcentres', JSON.stringify([]));
    localStorage.setItem('wf::wf_projects', JSON.stringify(projects));
    localStorage.setItem('wf::wf_tasks', JSON.stringify(tasks));
    localStorage.setItem('wf::wf_jobs', JSON.stringify(jobs));
    localStorage.setItem('wf::wf_timelog', JSON.stringify(timeLog));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.waitForTimeout(400);

  // ---- completing an unlogged, paired task: primary + training partner ----
  await page.click('nav >> text=R&D');
  await page.waitForTimeout(400);
  await page.locator('tr', { hasText: 'Trial spray run' }).click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);
  await modal().getByRole('button', { name: /Mark complete/i }).click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);

  const hourInputs = modal().locator('input[type=number]');
  check('the completion dialog offers a second hours field for the training partner', (await hourInputs.count()) === 2);
  check('the second field is labelled with the partner\'s name', /Jordan/.test(await modal().innerText()));

  await hourInputs.nth(0).fill('7');
  await hourInputs.nth(1).fill('3');
  await modal().getByRole('button', { name: /Save.*complete/i }).click();
  await page.waitForTimeout(700);

  const afterUnlogged = await page.evaluate(() => ({
    task: JSON.parse(localStorage.getItem('wf::wf_tasks') || '[]').find((t) => t.id === 'task_unlogged'),
    entries: JSON.parse(localStorage.getItem('wf::wf_timelog') || '[]').filter((e) => e.jobId === 'task_unlogged'),
  }));
  check('the task\'s actualHours is the primary\'s figure only', afterUnlogged.task?.actualHours === 7);
  check('exactly two wf_timelog entries were written — one per person', afterUnlogged.entries.length === 2, JSON.stringify(afterUnlogged.entries));
  const primaryEntry = afterUnlogged.entries.find((e) => e.staffId === 'st_1');
  const partnerEntry = afterUnlogged.entries.find((e) => e.staffId === 'st_2');
  check('the primary\'s entry has the primary\'s hours', primaryEntry?.hours === 7);
  check('the partner\'s entry has their OWN hours, not the primary\'s', partnerEntry?.hours === 3);

  await page.click('nav >> text=R&D');
  await page.waitForTimeout(400);
  const rdText = await page.locator('main').innerText();
  check('the R&D task table now shows 10h logged (7+3), not 0h', /Trial spray run[\s\S]{0,120}10h/.test(rdText), rdText.slice(0, 400));
  check('the project rollup card reflects the combined 10h too', /10h logged/.test(rdText), rdText);

  // ---- completing an already-logged task doesn't duplicate the entry ----
  await page.locator('tr', { hasText: 'Robot recalibration' }).click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);
  await modal().getByRole('button', { name: /Mark complete/i }).click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);
  check('pre-filled from the existing 4h logged, not blank', (await modal().locator('input[type=number]').first().inputValue()) === '4');
  check('no training-partner field for a task with no pairing', (await modal().locator('input[type=number]').count()) === 1);
  await modal().getByRole('button', { name: /Save.*complete/i }).click();
  await page.waitForTimeout(700);

  const afterLogged = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_timelog') || '[]').filter((e) => e.jobId === 'task_logged'));
  check('still exactly one entry — completion did not add a duplicate on top of the existing day-by-day log', afterLogged.length === 1 && afterLogged[0].hours === 4, JSON.stringify(afterLogged));

  // ---- the identical fix applies to completing a JOB, not just a task ----
  await page.click('nav >> text=Job Backlog');
  await page.waitForTimeout(400);
  await page.locator('table tbody tr', { hasText: 'Bracket Weld' }).locator('button[title="Mark complete"]').click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);
  await modal().locator('input[type=number]').first().fill('5');
  await modal().getByRole('button', { name: /Save.*complete/i }).click();
  await page.waitForTimeout(700);

  const jobEntries = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_timelog') || '[]').filter((e) => e.jobId === 'job_unlogged'));
  check('completing an unlogged JOB writes a wf_timelog entry too', jobEntries.length === 1 && jobEntries[0].hours === 5, JSON.stringify(jobEntries));

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

run.suiteName = 'completion-hours-logging';
