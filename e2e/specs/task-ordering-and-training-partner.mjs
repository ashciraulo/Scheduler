/* Two follow-up fixes on top of the R&D tasks feature:
   1. A task's Schedule view lane now sits in actual date order alongside
      job lanes on the same equipment (equipLanes in ScheduleView), instead
      of always being appended after every job lane regardless of when it's
      scheduled.
   2. Tasks get the same training-partner (secondStaffId) field jobs do —
      see "Two-person jobs" in scheduler/CLAUDE.md and e2e/specs/
      training-partner.mjs for the job version this mirrors.
   See "R&D projects and tasks" in scheduler/CLAUDE.md. */

import { modalSel, isoDate, nextWeekday } from '../lib/harness.mjs';

export default async function run({ page, check, errors, baseUrl }) {
  const modal = () => page.locator(modalSel);
  const anchorIso = isoDate(nextWeekday(new Date()));
  const laterIso = isoDate(new Date(new Date(anchorIso + 'T00:00:00').getTime() + 86400000));

  // ---- ordering: a task scheduled EARLIER than a job on the same
  // equipment must render ABOVE it, not after every job lane ----
  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.evaluate(({ anchorIso, laterIso }) => {
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
    const jobs = [{
      id: 'job_later', name: 'Job scheduled later', process: 'Robotic MIG Welding', quantity: 1, hoursTotal: 2,
      dueDate: '2026-12-01', departmentDueDate: null, readyDate: laterIso, templateId: null, notes: '',
      totalValue: 0, departmentValue: 0, percentComplete: 0, needsFurtherProcessing: false,
      status: 'active', completedDate: null, batchId: null, batchOrder: null, tags: [], procedureId: '',
      bcJobNo: '', bcJobTaskNo: '', staffId: 'st_2', updatedAt: new Date().toISOString(),
      assignment: { equipmentId: 'eq_1', startDate: laterIso, endDate: laterIso, pinned: true, days: [] },
    }];
    const tasks = [{
      id: 'task_earlier', name: 'Task scheduled earlier', process: 'Robotic MIG Welding', procedureId: '',
      hoursTotal: 2, readyDate: anchorIso, dueDate: anchorIso, projectId: null, staffId: 'st_1', notes: '',
      status: 'active', completedDate: null, actualHours: null, updatedAt: new Date().toISOString(),
      assignment: { equipmentId: 'eq_1', startDate: anchorIso, endDate: anchorIso, pinned: true, days: [] },
    }];
    localStorage.setItem('wf::wf_staff', JSON.stringify(staff));
    localStorage.setItem('wf::wf_equipment', JSON.stringify(equipment));
    localStorage.setItem('wf::wf_jobs', JSON.stringify(jobs));
    localStorage.setItem('wf::wf_tasks', JSON.stringify(tasks));
    localStorage.setItem('wf::wf_projects', JSON.stringify([]));
  }, { anchorIso, laterIso });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.click('nav >> text=Schedule');
  await page.waitForTimeout(700);

  const positions = await page.evaluate(() => {
    const spans = Array.from(document.querySelectorAll('span'))
      .filter((s) => s.textContent === 'Task scheduled earlier' || s.textContent === 'Job scheduled later');
    return Object.fromEntries(spans.map((s) => [s.textContent, s.getBoundingClientRect().top]));
  });
  check('the earlier-dated task renders above the later-dated job on the same equipment — not appended after every job lane',
        positions['Task scheduled earlier'] < positions['Job scheduled later'], JSON.stringify(positions));

  // ---- training partner: mirrors e2e/specs/training-partner.mjs's job
  // version, on a task instead ----
  await page.evaluate(() => localStorage.setItem('wf::wf_jobs', JSON.stringify([])));
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.click('nav >> text=R&D');
  await page.waitForTimeout(400);
  await page.locator('tr', { hasText: 'Task scheduled earlier' }).click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);

  // The seed already has a primary (st_1), so Training partner should
  // already be visible — confirm the field is genuinely gated on that by
  // clearing the primary and checking it disappears.
  check('Training partner is offered once a primary is assigned', (await modal().locator('label:has-text("Training partner")').count()) === 1);
  const assignedSel = modal().locator('label:has-text("Assigned to") select');
  await assignedSel.selectOption('');
  await page.waitForTimeout(200);
  check('...and disappears again once the primary is cleared', (await modal().locator('label:has-text("Training partner")').count()) === 0);
  await assignedSel.selectOption('st_1');
  await page.waitForTimeout(200);

  const trainingSel = modal().locator('label:has-text("Training partner") select');
  const trainingOpts = await trainingSel.locator('option').evaluateAll((os) => os.map((o) => o.value).filter(Boolean));
  check('the primary is not offered as their own training partner', !trainingOpts.includes('st_1'), JSON.stringify(trainingOpts));
  await trainingSel.selectOption('st_2');
  await modal().getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForTimeout(700);

  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_tasks') || '[]').find((t) => t.id === 'task_earlier'));
  check('the pairing is saved on the task', saved?.secondStaffId === 'st_2');
  check('a successful pairing is not flagged unmet', saved?.assignment?.secondStaffUnmet === false);
  check('every day of the plan carries both people',
        (saved?.assignment?.days || []).length > 0 && saved.assignment.days.every((d) => d.staffId === 'st_1' && d.secondStaffId === 'st_2'),
        JSON.stringify(saved?.assignment?.days));

  await page.click('nav >> text=Schedule');
  await page.waitForTimeout(700);
  const nameCell = page.locator('div[draggable]', { hasText: 'Task scheduled earlier' }).first();
  check('the tile tooltip names both people', (await nameCell.getAttribute('title'))?.includes('Alex, Jordan'), await nameCell.getAttribute('title'));
  check('the tile shows two colour dots, one per person', (await nameCell.locator('span[style*="border-radius: 2px"]').count()) === 2);

  // ---- unmet pairing: the second person is never actually free ----
  await page.evaluate(() => {
    const tasks = JSON.parse(localStorage.getItem('wf::wf_tasks') || '[]');
    const staff = JSON.parse(localStorage.getItem('wf::wf_staff') || '[]');
    staff.find((s) => s.id === 'st_2').leavePeriods = [{ id: 'lv_perma', kind: 'leave', startDate: '2000-01-01', endDate: '2100-01-01' }];
    localStorage.setItem('wf::wf_staff', JSON.stringify(staff));
    localStorage.setItem('wf::wf_tasks', JSON.stringify(tasks));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.click('nav >> text=Schedule');
  await page.waitForTimeout(700);

  check('an unmet pairing gets its own review panel', (await page.locator('text=Training partner not paired').count()) > 0);
  const mainText = await page.locator('main').innerText();
  check('the panel explains the task is still scheduled fine — this is not an overbooking', /scheduled fine, just missing/i.test(mainText));

  await page.locator('button', { hasText: 'Task scheduled earlier' }).click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);
  check('clicking the entry in the review panel opens the task itself', (await modal().locator('input[value="Task scheduled earlier"]').count()) === 1);
  await modal().locator('button').first().click();
  await page.waitForSelector(modalSel, { state: 'detached' });
  await page.waitForTimeout(300);

  const unmetTask = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_tasks') || '[]').find((t) => t.assignment?.secondStaffUnmet));
  check('an unmet pairing is not flagged as a conflict', unmetTask?.assignment?.conflict === false);
  check('nothing was stamped on any day when the pairing could not be honoured', (unmetTask?.assignment?.days || []).every((d) => !d.secondStaffId));

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

run.suiteName = 'task-ordering-and-training-partner';
