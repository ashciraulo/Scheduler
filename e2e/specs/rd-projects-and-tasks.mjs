/* R&D projects (tracking-only) and tasks (the non-job schedulable item) —
   see "R&D projects and tasks" in scheduler/CLAUDE.md. Tasks share the
   scheduling engine with jobs (taskToJobUnit/splitTaskUnits) so they draw on
   the exact same equipment/staff capacity a job would; projects are never
   scheduled themselves, existing purely so a task's hours/cost can roll up
   somewhere. What's worth guarding at browser level rather than only in
   unit tests:
   - a task is created already pinned (Equipment + Planned start date are
     both required, there's no "automatic" mode) from either the R&D tab or
     straight off the Schedule view
   - it genuinely competes for capacity: a job that also needs the one
     qualified person gets pushed off the day the task occupies
   - it renders on the Schedule view as its own, non-job-styled tile
   - it's draggable onto other equipment, same mechanism as a job
     (dragTaskId/handleTaskDrop) — the only way to move one once created
   - the daily hours log lists it exactly like a job (same wf_timelog)
   - completing it with actual hours costs correctly off its procedure
     (jobCost, unmodified — task field names deliberately match)
   - a project's rollup card reflects that cost/hours, and deleting the
     project leaves the task's own record (and history) untouched */

import { modalSel, isoDate, nextWeekday } from '../lib/harness.mjs';

export default async function run({ page, check, errors, baseUrl }) {
  const modal = () => page.locator(modalSel);
  const anchorIso = isoDate(nextWeekday(new Date()));

  // ---- seed: one staff/equipment/procedure, a project, a task that hard-
  // locks the only qualified person for a full day, and a competing
  // unpinned job that also needs that same person ----
  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.evaluate((anchorIso) => {
    const staff = [{
      id: 'st_1', name: 'Alex', processes: ['Robotic MIG Welding'],
      weeklyRoster: {
        mon: { working: true, production: true, shift: 'day', hours: 8 },
        tue: { working: true, production: true, shift: 'day', hours: 8 },
        wed: { working: true, production: true, shift: 'day', hours: 8 },
        thu: { working: true, production: true, shift: 'day', hours: 8 },
        fri: { working: true, production: true, shift: 'day', hours: 8 },
        sat: { working: false, production: true, shift: 'day', hours: 0 },
        sun: { working: false, production: true, shift: 'day', hours: 0 },
      },
      leavePeriods: [], color: null,
    }];
    const equipment = [
      { id: 'eq_1', name: 'Cell 1', type: 'Welding Robot', tags: [], processes: ['Robotic MIG Welding'], unavailableDates: [] },
      { id: 'eq_2', name: 'Cell 2', type: 'Welding Robot', tags: [], processes: ['Robotic MIG Welding'], unavailableDates: [] },
    ];
    const procedures = [{
      id: 'proc_1', name: 'R&D trial procedure', process: 'Robotic MIG Welding', costCentreId: '', substrate: '', notes: '',
      powder: {}, gases: [], electricity: {}, spares: [], maintenance: [], consumables: [],
      labour: [{ name: 'Engineer', rate: 40, count: 1 }], qa: [],
    }];
    const projects = [{ id: 'proj_1', name: 'Coating Study', description: 'Wear resistance trial', status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }];
    const tasks = [{
      id: 'task_1', name: 'Trial spray run', process: 'Robotic MIG Welding', procedureId: 'proc_1',
      hoursTotal: 8, readyDate: anchorIso, dueDate: anchorIso, projectId: 'proj_1', staffId: 'st_1', notes: '',
      status: 'active', completedDate: null, actualHours: null, updatedAt: new Date().toISOString(),
      assignment: { equipmentId: 'eq_1', startDate: anchorIso, endDate: anchorIso, pinned: true, days: [] },
    }];
    const jobs = [{
      id: 'job_1', name: 'Competing job', process: 'Robotic MIG Welding', quantity: 1, hoursTotal: 4,
      dueDate: '2026-12-01', departmentDueDate: null, readyDate: anchorIso, templateId: null, notes: '',
      totalValue: 0, departmentValue: 0, percentComplete: 0, needsFurtherProcessing: false,
      status: 'active', completedDate: null, batchId: null, batchOrder: null, tags: [], procedureId: '',
      bcJobNo: '', bcJobTaskNo: '', staffId: null, updatedAt: new Date().toISOString(), assignment: null,
    }];
    localStorage.setItem('wf::wf_staff', JSON.stringify(staff));
    localStorage.setItem('wf::wf_equipment', JSON.stringify(equipment));
    localStorage.setItem('wf::wf_procedures', JSON.stringify(procedures));
    localStorage.setItem('wf::wf_costcentres', JSON.stringify([]));
    localStorage.setItem('wf::wf_projects', JSON.stringify(projects));
    localStorage.setItem('wf::wf_tasks', JSON.stringify(tasks));
    localStorage.setItem('wf::wf_jobs', JSON.stringify(jobs));
  }, anchorIso);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.waitForTimeout(500);

  // ---- the task genuinely consumed the day, same capacity pool as a job ----
  const seeded = await page.evaluate(() => {
    const jobs = JSON.parse(localStorage.getItem('wf::wf_jobs') || '[]');
    const tasks = JSON.parse(localStorage.getItem('wf::wf_tasks') || '[]');
    return { job: jobs.find((j) => j.id === 'job_1'), task: tasks.find((t) => t.id === 'task_1') };
  });
  check('the task is pinned exactly where it was placed', seeded.task.assignment.startDate === anchorIso && seeded.task.assignment.equipmentId === 'eq_1');
  check('the task consumed the qualified person\'s full day',
        seeded.task.assignment.days?.[0]?.staffId === 'st_1' && seeded.task.assignment.days[0].hours === 8);
  check('a competing job needing the same person is pushed off that day — capacity genuinely shared',
        seeded.job.assignment && seeded.job.assignment.startDate !== anchorIso,
        JSON.stringify(seeded.job.assignment));

  // ---- renders on the Schedule view as its own, distinctly-styled tile ----
  await page.click('nav >> text=Schedule');
  await page.waitForTimeout(700);
  check('the task tile is visible on the Schedule view', (await page.locator('span.text-violet-200', { hasText: 'Trial spray run' }).count()) === 1);

  // ---- drag-and-drop: dragging the task's name cell onto another piece of
  // equipment reassigns it, same mechanism as a job (dragTaskId/
  // handleTaskDrop) — the ONLY way to move a task once created, since it has
  // no auto-schedule mode to unpin into. ----
  {
    const taskNameCell = page.locator('span.text-violet-200', { hasText: 'Trial spray run' });
    const cell2Header = page.locator('span.font-semibold', { hasText: 'Cell 2' });
    await cell2Header.scrollIntoViewIfNeeded();
    const eqBox = await cell2Header.boundingBox();
    await taskNameCell.hover();
    await page.mouse.down();
    await page.mouse.move(eqBox.x + 400, eqBox.y + 40, { steps: 10 });
    await page.mouse.move(eqBox.x + 400, eqBox.y + 40, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(700);
    const dragged = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_tasks') || '[]').find((t) => t.id === 'task_1'));
    check('dragging a task tile onto different equipment reassigns it', dragged.assignment.equipmentId === 'eq_2', JSON.stringify(dragged.assignment));
    check('the reassigned task is still pinned, not left floating', dragged.assignment.pinned === true);
  }

  // ---- "New task" straight from the Schedule view, no project ----
  await page.click('button:has-text("New task")');
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);
  await modal().locator('input').first().fill('Robot calibration check');
  const processSel = modal().locator('select').nth(0);
  await processSel.selectOption('Robotic MIG Welding');
  await page.waitForTimeout(200);
  await modal().locator('input[type=number]').fill('2');
  const dateInputs = modal().locator('input[type=date]');
  const today = new Date();
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  await dateInputs.nth(0).fill(iso(new Date(today.getTime() + 7 * 86400000))); // required completion date
  await dateInputs.nth(1).fill(iso(today)); // ready for processing
  await dateInputs.nth(2).fill(iso(today)); // planned start date
  const equipSel = modal().locator('select').nth(2);
  const equipOpts = await equipSel.locator('option').evaluateAll((os) => os.map((o) => o.value).filter(Boolean));
  check('Equipment offers both process-qualified machines', equipOpts.length === 2 && equipOpts.includes('eq_1') && equipOpts.includes('eq_2'));
  await equipSel.selectOption(equipOpts[0]);
  await modal().getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForTimeout(700);

  const withStandalone = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_tasks') || '[]').find((t) => t.name === 'Robot calibration check'));
  check('a task created with no project saved is standalone (projectId null)', withStandalone && withStandalone.projectId == null, JSON.stringify(withStandalone?.projectId));
  check('a task assigned no one is left for the scheduler to pick anyone qualified', withStandalone?.staffId == null);

  // ---- edit flow: click the tile (avoiding the just-fired toast), confirm
  // it reopens with real values, not stale/blank ----
  await page.locator('div.fixed.bottom-5').waitFor({ state: 'detached', timeout: 6000 }).catch(() => {});
  await page.locator('span.text-violet-200', { hasText: 'Robot calibration check' }).click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);
  check('reopening the tile shows the task\'s own description, not blank/stale', (await modal().locator('input[value="Robot calibration check"]').count()) === 1);
  check('the edit modal offers Delete and Mark complete', (await modal().locator('button:has-text("Delete")').count()) === 1 && (await modal().locator('button:has-text("Mark complete")').count()) === 1);
  await modal().locator('button').first().click(); // the header's X — Modal has no Escape handler
  await page.waitForSelector(modalSel, { state: 'detached' });
  await page.waitForTimeout(300);

  // ---- the daily hours log lists tasks exactly like jobs (same merge into
  // TimeLogModal's `jobs` prop, zero changes to TimeLogModal itself) ----
  // "Trial spray run" may have landed a day off anchorIso — the earlier
  // drag's drop coordinates aren't pixel-precise about which day column
  // they land on, only which equipment (see the job-drag suite's own
  // tolerance for the same reason) — so read its actual planned date back
  // rather than assuming it's still "today", and check the standalone task
  // (untouched by the drag, still planned for today) on its own date.
  const draggedDate = (await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_tasks') || '[]').find((t) => t.id === 'task_1'))).assignment.startDate;
  await page.click('button:has-text("Log hours")'); // opens on today by default
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);
  await modal().locator('input[type=date]').fill(draggedDate);
  await page.waitForTimeout(300);
  check('the daily hours log lists the project-linked task, planned for its actual day',
        (await modal().locator('tr', { hasText: 'Trial spray run' }).count()) === 1);
  await modal().locator('input[type=date]').fill(isoDate(new Date()));
  await page.waitForTimeout(300);
  check('...and the standalone task, planned for today, shows on its own day too',
        (await modal().locator('tr', { hasText: 'Robot calibration check' }).count()) === 1);
  // Editing the date field left the modal "dirty" (any onChange does, per
  // Modal's tracking — see the DirtyContext comment in WeldingScheduler.jsx),
  // so its X now asks for confirmation rather than closing outright.
  await modal().locator('button').first().click();
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await page.waitForSelector(modalSel, { state: 'detached' });
  await page.waitForTimeout(300);
  check('no page errors so far', errors.length === 0, errors.slice(0, 3).join(' | '));

  // ---- R&D tab: project card rollup + task list ----
  await page.click('nav >> text=R&D');
  await page.waitForTimeout(400);
  check('the seeded project card is visible with its rollup', (await page.locator('text=Coating Study').count()) > 0);
  check('the task list shows the project-linked task with its project name', (await page.locator('tr', { hasText: 'Trial spray run' }).locator('text=Coating Study').count()) === 1);
  check('the standalone task shows no project', (await page.locator('tr', { hasText: 'Robot calibration check' }).locator('text=—').count()) >= 1);

  // ---- mark the project task complete with actual hours; cost recalculates ----
  await page.locator('tr', { hasText: 'Trial spray run' }).click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);
  await modal().getByRole('button', { name: /Mark complete/i }).click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);
  await modal().locator('input[type=number]').fill('6');
  await modal().getByRole('button', { name: /Save.*complete/i }).click();
  await page.waitForTimeout(700);

  const completed = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_tasks') || '[]').find((t) => t.id === 'task_1'));
  check('the task is complete with actual hours recorded', completed.status === 'complete' && completed.actualHours === 6);

  await page.click('nav >> text=R&D');
  await page.waitForTimeout(400);
  const rdText = await page.locator('main').innerText();
  // 6h actual * $40/hr labour = $240.00 — same jobCost() every job/rework uses.
  check('the project card and task row both show cost computed from actual hours × procedure rate', (rdText.match(/240\.00/g) || []).length >= 2, rdText);

  // ---- deleting the project leaves the task's own record untouched ----
  await page.locator('button', { hasText: 'Coating Study' }).click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);
  await modal().locator('button:has-text("Delete")').click();
  await page.waitForTimeout(300);
  await page.locator('button:has-text("Delete")').last().click();
  await page.waitForTimeout(500);

  const afterProjectDelete = await page.evaluate(() => ({
    projects: JSON.parse(localStorage.getItem('wf::wf_projects') || '[]'),
    task: JSON.parse(localStorage.getItem('wf::wf_tasks') || '[]').find((t) => t.id === 'task_1'),
  }));
  check('the project is gone', afterProjectDelete.projects.length === 0);
  check('the task survives deletion of its project, history intact', afterProjectDelete.task?.status === 'complete' && afterProjectDelete.task?.actualHours === 6);

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

run.suiteName = 'rd-projects-and-tasks';
