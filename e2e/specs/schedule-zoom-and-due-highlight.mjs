/* Two Schedule-view UI tweaks, unrelated except for both living in
   ScheduleView:

   1. The zoom default used to be 100%, with ZOOM_MIN (60%) as the floor —
      so 60% was "as far out as you can go," not a genuine midpoint. Now
      60% is the default (WeldingScheduler's own zoom useState) and
      ZOOM_MIN is 40%, so there's room to zoom out further, not just in.

   2. A job due (effectiveDueDate — department due date if set, else the
      client one) within the CURRENT calendar month gets its name card
      tinted and its timeline bar bordered in a new accent
      (DUE_THIS_MONTH_COLOR, #8B5CF6) — distinct from amber/coral (the
      general accent), red (conflict) and sky/orange (equipment-type
      colouring, also used for the parallel-processing icon on the same
      tile) — so it reads apart from other work merely scheduled during
      the same window that isn't actually due yet. A job due a different
      month gets neither, even when scheduled in the exact same window. */

export default async function run({ page, check, errors, baseUrl }) {
  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.evaluate(() => {
    const todayIso = new Date().toISOString().slice(0, 10);
    const [y, m] = todayIso.split('-').map(Number);
    const thisMonthDue = `${y}-${String(m).padStart(2, '0')}-25`; // 25th exists in every month, including Feb
    const nextMonthDate = new Date(y, m, 15); // JS month is 0-based, so `m` (1-based) is next month
    const nextMonthDue = nextMonthDate.toISOString().slice(0, 10);
    const startDate = todayIso;
    const jobs = [
      {
        id: 'job_thismonth', name: 'Due this month job', process: 'Robotic MIG Welding', quantity: 1, hoursTotal: 8,
        dueDate: thisMonthDue, departmentDueDate: null, readyDate: startDate, templateId: null, notes: '',
        totalValue: 500, departmentValue: 500, percentComplete: 0, needsFurtherProcessing: false,
        status: 'active', completedDate: null, batchId: null, batchOrder: null, tags: [], procedureId: '',
        bcJobNo: 'BC-1', bcJobTaskNo: '', staffId: null, updatedAt: new Date().toISOString(),
        assignment: { equipmentId: 'eq_1', startDate, endDate: startDate, pinned: true, conflict: false, days: [] },
      },
      {
        id: 'job_nextmonth', name: 'Due next month job', process: 'Robotic MIG Welding', quantity: 1, hoursTotal: 8,
        dueDate: nextMonthDue, departmentDueDate: null, readyDate: startDate, templateId: null, notes: '',
        totalValue: 500, departmentValue: 500, percentComplete: 0, needsFurtherProcessing: false,
        status: 'active', completedDate: null, batchId: null, batchOrder: null, tags: [], procedureId: '',
        bcJobNo: 'BC-2', bcJobTaskNo: '', staffId: null, updatedAt: new Date().toISOString(),
        assignment: { equipmentId: 'eq_1', startDate, endDate: startDate, pinned: true, conflict: false, days: [] },
      },
      {
        // A department due date this month should count even when the
        // client due date isn't — effectiveDueDate prefers it, same as
        // everywhere else that reads a job's "real" due date.
        id: 'job_deptdue', name: 'Department due this month job', process: 'Robotic MIG Welding', quantity: 1, hoursTotal: 8,
        dueDate: nextMonthDue, departmentDueDate: thisMonthDue, readyDate: startDate, templateId: null, notes: '',
        totalValue: 500, departmentValue: 500, percentComplete: 0, needsFurtherProcessing: false,
        status: 'active', completedDate: null, batchId: null, batchOrder: null, tags: [], procedureId: '',
        bcJobNo: 'BC-3', bcJobTaskNo: '', staffId: null, updatedAt: new Date().toISOString(),
        assignment: { equipmentId: 'eq_2', startDate, endDate: startDate, pinned: true, conflict: false, days: [] },
      },
    ];
    localStorage.setItem('wf::wf_jobs', JSON.stringify(jobs));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.waitForTimeout(400);
  await page.click('nav >> text=Schedule');
  await page.waitForTimeout(500);

  // ---- zoom: 60% default, zoomable both in and out from there ----
  const zoomBox = page.locator('[title="Zoom the schedule grid"]');
  const zoomLabel = zoomBox.locator('span.tabular-nums');
  const zoomOutBtn = zoomBox.locator('button').nth(0);
  const zoomInBtn = zoomBox.locator('button').nth(1);

  check('zoom defaults to 60%, not 100%', (await zoomLabel.innerText()) === '60%');
  check('zoom-out is available from the default (not already at the floor)', !(await zoomOutBtn.isDisabled()));
  check('zoom-in is also available from the default', !(await zoomInBtn.isDisabled()));

  await zoomOutBtn.click();
  await page.waitForTimeout(150);
  check('zooming out from the default goes to 40%', (await zoomLabel.innerText()) === '40%');
  check('40% is the floor — zoom-out is now disabled', await zoomOutBtn.isDisabled());

  await zoomInBtn.click();
  await zoomInBtn.click();
  await page.waitForTimeout(150);
  check('zooming back in from 40% reaches 80% (two +20% steps)', (await zoomLabel.innerText()) === '80%');

  // ---- due-this-month highlight ----
  const nameCell = (jobText) => page.locator('div', { hasText: jobText }).locator('xpath=ancestor::div[contains(@class,"sticky") and contains(@class,"left-0")]').first();

  const thisMonthCell = nameCell('Due this month job');
  const nextMonthCell = nameCell('Due next month job');
  const deptDueCell = nameCell('Department due this month job');

  check('a job due (client date) this month gets the violet highlight class', (await thisMonthCell.getAttribute('class')).includes('bg-violet-500/15'));
  const thisMonthBg = await thisMonthCell.evaluate((el) => getComputedStyle(el).backgroundColor);
  check('...and it actually renders violet, not just carries the class', thisMonthBg === 'rgb(239, 234, 251)', thisMonthBg);

  check('a job due next month is NOT highlighted, despite being scheduled in the same window', !(await nextMonthCell.getAttribute('class')).includes('bg-violet-500/15'));

  check('a job whose DEPARTMENT due date (not client date) falls this month is highlighted too — effectiveDueDate, not raw dueDate',
        (await deptDueCell.getAttribute('class')).includes('bg-violet-500/15'));

  // ---- the timeline bar itself gets a matching border ----
  const thisMonthBar = page.locator('div[title*="Due this month job"]').last();
  const nextMonthBar = page.locator('div[title*="Due next month job"]').last();
  const thisMonthBorder = await thisMonthBar.evaluate((el) => getComputedStyle(el).borderColor);
  const nextMonthBorder = await nextMonthBar.evaluate((el) => getComputedStyle(el).borderColor);
  check('the due-this-month job\'s timeline bar is bordered in the same violet accent', thisMonthBorder === 'rgb(139, 92, 246)', thisMonthBorder);
  check('the due-next-month job\'s bar is NOT — it keeps its ordinary pinned border', nextMonthBorder !== 'rgb(139, 92, 246)', nextMonthBorder);

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

run.suiteName = 'schedule-zoom-and-due-highlight';
