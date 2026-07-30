/* Issue #63: jobsByEquip used to include every job with any assignment at
   all, forever — a completed job kept its own permanent lane row on every
   equipment, on every page of the Schedule view, no matter how long ago it
   finished. Requested from the shop floor: completed jobs should still be
   visible when paging back through history, but shouldn't clutter the
   current view once history has moved on. A job's lane now only shows on a
   page of the timeline whose visible date window actually overlaps where
   the job was scheduled. */

export default async function run({ page, check, errors, baseUrl }) {
  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');

  await page.evaluate(() => {
    const iso = (d) => { const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0'); return `${y}-${m}-${day}`; };
    const addDays = (base, n) => { const d = new Date(base); d.setDate(d.getDate() + n); return iso(d); };
    const today = new Date();
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
    const oldDate = addDays(today, -75); // within the 90-day history window, well outside the default 30-day page
    const jobs = [
      {
        id: 'job_old', name: 'Old Completed Job', process: 'Robotic MIG Welding', quantity: 1, hoursTotal: 8,
        dueDate: addDays(today, -70), departmentDueDate: null, readyDate: addDays(today, -80), templateId: null, notes: '',
        totalValue: 0, departmentValue: 0, percentComplete: 100, needsFurtherProcessing: false,
        status: 'complete', completedDate: oldDate, actualHours: 8, batchId: null, batchOrder: null, tags: [], procedureId: '',
        bcJobNo: '', bcJobTaskNo: '', staffId: null, updatedAt: new Date().toISOString(),
        assignment: { equipmentId: 'eq_1', startDate: oldDate, endDate: oldDate, pinned: true, conflict: false, days: [{ date: oldDate, shift: 'day', staffId: 'st_1', hours: 8 }], claimOrder: 0 },
      },
      {
        id: 'job_current', name: 'Current Active Job', process: 'Robotic MIG Welding', quantity: 1, hoursTotal: 8,
        dueDate: addDays(today, 10), departmentDueDate: null, readyDate: iso(today), templateId: null, notes: '',
        totalValue: 0, departmentValue: 0, percentComplete: 0, needsFurtherProcessing: false,
        status: 'active', completedDate: null, batchId: null, batchOrder: null, tags: [], procedureId: '',
        bcJobNo: '', bcJobTaskNo: '', staffId: null, updatedAt: new Date().toISOString(),
        assignment: null,
      },
    ];
    localStorage.setItem('wf::wf_staff', JSON.stringify(staff));
    localStorage.setItem('wf::wf_equipment', JSON.stringify(equipment));
    localStorage.setItem('wf::wf_jobs', JSON.stringify(jobs));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.click('nav >> text=Schedule');
  await page.waitForTimeout(600);

  const grid = page.locator('div.border.border-slate-800.rounded-lg.overflow-hidden.bg-slate-900').first();
  const todayView = await grid.innerText();
  check("#63 a completed job from 75 days ago doesn't clutter today's view",
        !todayView.includes('Old Completed Job'), todayView.includes('Old Completed Job'));
  check('#63 the currently-active job still shows on the current page',
        todayView.includes('Current Active Job'), todayView.includes('Current Active Job'));

  // Page back into the completed job's own window (3 clicks of the default
  // 30-day page = 90 days, comfortably past the job's 75-days-ago date).
  const prevBtn = page.locator('button:has(svg.lucide-chevron-left)').first();
  await prevBtn.click(); await page.waitForTimeout(300);
  await prevBtn.click(); await page.waitForTimeout(300);
  await prevBtn.click(); await page.waitForTimeout(300);

  const pastView = await grid.innerText();
  check("#63 paging back to when it was scheduled brings the completed job's history back",
        pastView.includes('Old Completed Job'), pastView.includes('Old Completed Job'));
  check("#63 the current job — not scheduled back then — is gone from this older page",
        !pastView.includes('Current Active Job'), pastView.includes('Current Active Job'));

  // Back to today (the "Today" jump button) — the completed job should
  // disappear again, proving this isn't a one-way reveal.
  await page.locator('button:has-text("Today")').click();
  await page.waitForTimeout(300);
  const backToToday = await grid.innerText();
  check('#63 jumping back to today hides the old completed job again',
        !backToToday.includes('Old Completed Job'), backToToday.includes('Old Completed Job'));

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

run.suiteName = 'schedule-timeline-window-filter';
