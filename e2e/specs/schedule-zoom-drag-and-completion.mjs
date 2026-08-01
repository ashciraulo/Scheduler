/* Issues #49 (marking a job complete shouldn't reshuffle the schedule unless
   it finished in less time than estimated), #50 (zoom should survive
   switching away from the Schedule tab and back), and #51 (jobs should be
   draggable from the name column, not just the thin timeline bar). */

import { nextWeekday, isoDate } from '../lib/harness.mjs';

export default async function run({ page, check, errors, baseUrl }) {
  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');

  // #49's fixtures below pin a job to "today" as the one day Alex (Mon-Fri
  // roster) is busy — anchored to the next Mon-Fri day instead of literal
  // "today" so the suite doesn't flake whenever it happens to run on a
  // weekend (see nextWeekday).
  const anchorIso = isoDate(nextWeekday(new Date()));

  // ---- #50: zoom persists across a tab switch ----
  await page.click('nav >> text=Schedule');
  await page.waitForTimeout(500);
  const zoomLabel = page.locator('span.tabular-nums');
  const zoomButtons = zoomLabel.locator('xpath=..').locator('button');
  await zoomButtons.nth(1).click();
  await zoomButtons.nth(1).click();
  await page.waitForTimeout(150);
  const zoomBefore = await zoomLabel.innerText();
  check('#50 zoom actually changed from the default', zoomBefore !== '100%', zoomBefore);

  await page.click('nav >> text=Job Backlog');
  await page.waitForTimeout(300);
  await page.click('nav >> text=Schedule');
  await page.waitForTimeout(300);
  const zoomAfter = await zoomLabel.innerText();
  check('#50 zoom survives switching away and back', zoomAfter === zoomBefore, `${zoomBefore} -> ${zoomAfter}`);

  // ---- #51: dragging the job name column reassigns equipment, same as the timeline bar ----
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_jobs') || '[]')
    .find((j) => j.name === 'Bracket Weld - Standard')?.assignment);
  const nameCell = page.locator('div', { hasText: 'Bracket Weld - Standard' })
    .filter({ has: page.locator('span.font-mono') }).last();
  const eqHeader = page.locator('span.font-semibold', { hasText: 'Weld Robot 2' });
  await eqHeader.scrollIntoViewIfNeeded();
  const eqBox = await eqHeader.boundingBox();
  await nameCell.hover();
  await page.mouse.down();
  await page.mouse.move(eqBox.x + 400, eqBox.y + 40, { steps: 10 });
  await page.mouse.move(eqBox.x + 400, eqBox.y + 40, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_jobs') || '[]')
    .find((j) => j.name === 'Bracket Weld - Standard')?.assignment);
  check('#51 dragging the job name cell moves the job to the dropped equipment',
        after.equipmentId !== before.equipmentId && after.pinned === true,
        `${before.equipmentId} -> ${after.equipmentId}`);

  // ---- #49: completing a job doesn't reshuffle the schedule unless it finished early ----
  await page.evaluate((anchorIso) => {
    const today = new Date(anchorIso + 'T00:00:00');
    const iso = (d) => { const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0'); return `${y}-${m}-${day}`; };
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
    const equipment = [{ id: 'eq_1', name: 'Cell 1', type: 'Welding Robot', tags: [], processes: ['Robotic MIG Welding'], unavailableDates: [] }];
    const jobs = [
      {
        id: 'job_a', name: 'Completion Test A', process: 'Robotic MIG Welding', quantity: 1, hoursTotal: 8,
        dueDate: '2026-12-01', departmentDueDate: null, readyDate: iso(today), templateId: null, notes: '',
        totalValue: 0, departmentValue: 0, percentComplete: 0, needsFurtherProcessing: false,
        status: 'active', completedDate: null, batchId: null, batchOrder: null, tags: [], procedureId: '',
        bcJobNo: '', bcJobTaskNo: '', staffId: null, updatedAt: new Date().toISOString(),
        assignment: {
          equipmentId: 'eq_1', startDate: iso(today), endDate: iso(today), pinned: true, conflict: false,
          days: [{ date: iso(today), shift: 'day', staffId: 'st_1', hours: 8 }], claimOrder: 0,
        },
      },
      {
        id: 'job_b', name: 'Completion Test B', process: 'Robotic MIG Welding', quantity: 1, hoursTotal: 8,
        dueDate: '2026-12-05', departmentDueDate: null, readyDate: iso(today), templateId: null, notes: '',
        totalValue: 0, departmentValue: 0, percentComplete: 0, needsFurtherProcessing: false,
        status: 'active', completedDate: null, batchId: null, batchOrder: null, tags: [], procedureId: '',
        bcJobNo: '', bcJobTaskNo: '', staffId: null, updatedAt: new Date().toISOString(), assignment: null,
      },
    ];
    localStorage.setItem('wf::wf_staff', JSON.stringify(staff));
    localStorage.setItem('wf::wf_equipment', JSON.stringify(equipment));
    localStorage.setItem('wf::wf_jobs', JSON.stringify(jobs));
  }, anchorIso);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.waitForTimeout(500);

  // claimOrder is a fresh counter stamped on every recompute — it's expected
  // to change even when nothing meaningfully moved, so it's excluded from
  // the "did this job move" comparison below.
  const withoutClaimOrder = (a) => a && { ...a, claimOrder: undefined };
  const bBefore = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_jobs') || '[]')
    .find((j) => j.name === 'Completion Test B')?.assignment);

  await page.click('nav >> text=Job Backlog');
  await page.waitForTimeout(300);
  const rowA = page.locator('tr', { hasText: 'Completion Test A' });
  await rowA.locator('button').first().click();
  await page.waitForSelector('.fixed.inset-0');
  await page.waitForTimeout(300);
  const hoursModal = page.locator('.fixed.inset-0').last();
  await hoursModal.locator('input[type=number]').first().fill('8'); // exactly the estimate
  await hoursModal.getByRole('button', { name: /confirm|complete|save/i }).click();
  await page.waitForTimeout(600);

  const bAfterFullHours = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_jobs') || '[]')
    .find((j) => j.name === 'Completion Test B')?.assignment);
  check('#49 completing a job at its full estimate does not move an unrelated job',
        JSON.stringify(withoutClaimOrder(bBefore)) === JSON.stringify(withoutClaimOrder(bAfterFullHours)),
        `${JSON.stringify(bBefore)} vs ${JSON.stringify(bAfterFullHours)}`);

  // Finishing early is the one case that's allowed to free anything up — and
  // only the amount actually saved.
  await page.evaluate((anchorIso) => {
    const today = new Date(anchorIso + 'T00:00:00');
    const iso = (d) => { const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0'); return `${y}-${m}-${day}`; };
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
    const equipment = [{ id: 'eq_1', name: 'Cell 1', type: 'Welding Robot', tags: [], processes: ['Robotic MIG Welding'], unavailableDates: [] }];
    const jobs = [
      {
        id: 'job_c', name: 'Completion Test C', process: 'Robotic MIG Welding', quantity: 1, hoursTotal: 8,
        dueDate: '2026-12-01', departmentDueDate: null, readyDate: iso(today), templateId: null, notes: '',
        totalValue: 0, departmentValue: 0, percentComplete: 0, needsFurtherProcessing: false,
        status: 'active', completedDate: null, batchId: null, batchOrder: null, tags: [], procedureId: '',
        bcJobNo: '', bcJobTaskNo: '', staffId: null, updatedAt: new Date().toISOString(),
        assignment: {
          equipmentId: 'eq_1', startDate: iso(today), endDate: iso(today), pinned: true, conflict: false,
          days: [{ date: iso(today), shift: 'day', staffId: 'st_1', hours: 8 }], claimOrder: 0,
        },
      },
      {
        id: 'job_d', name: 'Completion Test D', process: 'Robotic MIG Welding', quantity: 1, hoursTotal: 3,
        dueDate: '2026-12-05', departmentDueDate: null, readyDate: iso(today), templateId: null, notes: '',
        totalValue: 0, departmentValue: 0, percentComplete: 0, needsFurtherProcessing: false,
        status: 'active', completedDate: null, batchId: null, batchOrder: null, tags: [], procedureId: '',
        bcJobNo: '', bcJobTaskNo: '', staffId: null, updatedAt: new Date().toISOString(), assignment: null,
      },
    ];
    localStorage.setItem('wf::wf_staff', JSON.stringify(staff));
    localStorage.setItem('wf::wf_equipment', JSON.stringify(equipment));
    localStorage.setItem('wf::wf_jobs', JSON.stringify(jobs));
  }, anchorIso);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.waitForTimeout(500);

  await page.click('nav >> text=Job Backlog');
  await page.waitForTimeout(300);
  const rowC = page.locator('tr', { hasText: 'Completion Test C' });
  await rowC.locator('button').first().click();
  await page.waitForSelector('.fixed.inset-0');
  await page.waitForTimeout(300);
  const hoursModal2 = page.locator('.fixed.inset-0').last();
  await hoursModal2.locator('input[type=number]').first().fill('5'); // finished 3h early
  await hoursModal2.getByRole('button', { name: /confirm|complete|save/i }).click();
  await page.waitForTimeout(600);

  const dAfter = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_jobs') || '[]')
    .find((j) => j.name === 'Completion Test D')?.assignment);
  // Same anchor day as the seed data above, not literal "today".
  check('#49 finishing 3h early frees exactly that 3h for another job the same day',
        dAfter?.startDate === anchorIso, JSON.stringify(dAfter));

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

run.suiteName = 'schedule-zoom-drag-and-completion';
