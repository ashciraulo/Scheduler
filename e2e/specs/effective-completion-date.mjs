/* Value Reports' "Completed" basis used to filter jobs on job.completedDate
   — literally the day someone clicked "Mark complete" in the app, not
   necessarily when the job actually finished. A job physically done on a
   Friday but not marked complete until the following Wednesday landed in
   Wednesday's reporting period instead of the one it was really finished
   in — reported from testing directly.

   effectiveCompletionDate(job) derives a better date from what the app
   already knows: the job's own day-by-day scheduled plan
   (assignment.days) and how its actualHours compared to the estimate.
   - Finished EARLY (actualHours <= scheduled total): walk the original
     plan cumulatively and stop at the day the actual total is reached —
     the same "trim from the start" the scheduler's own capacity replay
     already does for a different reason (freeing capacity), recomputed
     here since that pass never writes the trimmed date back onto the job.
   - Ran OVER (actualHours > scheduled total): extrapolate forward from
     the last scheduled day at the plan's own average hours/day.
   - No day-by-day plan to work from at all (e.g. a record with no
     assignment): falls back to the raw completedDate, unchanged.
   See "The daily hours log" in scheduler/CLAUDE.md. */

export default async function run({ page, check, errors, baseUrl }) {
  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.evaluate(() => {
    const mkDays = (dates, hoursEach) => dates.map((d) => ({ date: d, shift: 'day', staffId: 'st_1', hours: hoursEach }));
    const scheduledDays = ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05']; // 4h/day, 20h total
    const jobs = [
      {
        // Finished early: 12h actual (cumulative 4+4+4) -> 2026-06-03,
        // not the 2026-06-10 mark-complete date, a full week later.
        id: 'job_early', name: 'Early Finish Job', process: 'Robotic MIG Welding', quantity: 1, hoursTotal: 20,
        dueDate: '2026-12-01', departmentDueDate: null, readyDate: '2026-06-01', templateId: null, notes: '',
        totalValue: 0, departmentValue: 0, percentComplete: 100, needsFurtherProcessing: false,
        status: 'complete', completedDate: '2026-06-10', actualHours: 12, batchId: null, batchOrder: null,
        tags: [], procedureId: '', bcJobNo: '', bcJobTaskNo: '', staffId: 'st_1', updatedAt: new Date().toISOString(),
        assignment: { equipmentId: 'eq_1', startDate: '2026-06-01', endDate: '2026-06-05', pinned: false, conflict: false, days: mkDays(scheduledDays, 4) },
      },
      {
        // Ran over: 28h actual (8h over the 20h scheduled) -> extrapolate
        // 2 extra days at the 4h/day pace -> 2026-06-07.
        id: 'job_over', name: 'Overrun Job', process: 'Robotic MIG Welding', quantity: 1, hoursTotal: 20,
        dueDate: '2026-12-01', departmentDueDate: null, readyDate: '2026-06-01', templateId: null, notes: '',
        totalValue: 0, departmentValue: 0, percentComplete: 100, needsFurtherProcessing: false,
        status: 'complete', completedDate: '2026-06-20', actualHours: 28, batchId: null, batchOrder: null,
        tags: [], procedureId: '', bcJobNo: '', bcJobTaskNo: '', staffId: 'st_1', updatedAt: new Date().toISOString(),
        assignment: { equipmentId: 'eq_1', startDate: '2026-06-01', endDate: '2026-06-05', pinned: false, conflict: false, days: mkDays(scheduledDays, 4) },
      },
      {
        // No day-by-day plan at all -> falls back to the raw completedDate.
        id: 'job_noplan', name: 'No Plan Job', process: 'Robotic MIG Welding', quantity: 1, hoursTotal: 8,
        dueDate: '2026-12-01', departmentDueDate: null, readyDate: '2026-06-01', templateId: null, notes: '',
        totalValue: 0, departmentValue: 0, percentComplete: 100, needsFurtherProcessing: false,
        status: 'complete', completedDate: '2026-06-15', actualHours: 8, batchId: null, batchOrder: null,
        tags: [], procedureId: '', bcJobNo: '', bcJobTaskNo: '', staffId: null, updatedAt: new Date().toISOString(),
        assignment: null,
      },
    ];
    localStorage.setItem('wf::wf_jobs', JSON.stringify(jobs));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.waitForTimeout(300);
  await page.click('nav >> text=Value Reports');
  await page.waitForTimeout(400);
  await page.click('button:has-text("Completed")');
  await page.waitForTimeout(200);

  // ---- range covering the SCHEDULED window, not any of the completedDates ----
  await page.fill('input[type=date] >> nth=0', '2026-06-01');
  await page.fill('input[type=date] >> nth=1', '2026-06-07');
  await page.waitForTimeout(300);

  const mainText = () => page.locator('main').innerText();
  let text = await mainText();
  check('an early-finishing job appears in the period it actually finished, not when it was marked complete',
        text.includes('Early Finish Job'));
  check('an over-running job\'s extrapolated finish date also lands it in this period',
        text.includes('Overrun Job'));
  check('a job with no schedule to compute from falls back to its raw completedDate and is correctly excluded here',
        !text.includes('No Plan Job'));

  const earlyRow = page.locator('tr', { hasText: 'Early Finish Job' });
  const earlyRowText = await earlyRow.innerText();
  check('the early job\'s row shows the computed effective date (Jun 3), not the mark-complete date (Jun 10)',
        /Jun 3/.test(earlyRowText) && !/Jun 10/.test(earlyRowText), earlyRowText.replace(/\n/g, ' | '));
  check('a row whose effective date differs from completedDate is flagged with an asterisk', earlyRowText.includes('*'));

  const overRow = page.locator('tr', { hasText: 'Overrun Job' });
  const overRowText = await overRow.innerText();
  check('the overrun job\'s row shows the extrapolated date (Jun 7), 2 days past its last scheduled day',
        /Jun 7/.test(overRowText), overRowText.replace(/\n/g, ' | '));

  const tooltip = await earlyRow.locator('td').last().getAttribute('title');
  check('hovering the flagged date explains both dates', tooltip?.includes('Jun 10') && tooltip?.includes('actually finished'), tooltip);

  check('a legend explaining the effective-date column is shown', text.includes('Completed date is when the job actually finished'));

  // ---- a range covering only the mark-complete date (not the effective
  // date) must NOT include the job — this is the core of the fix ----
  await page.fill('input[type=date] >> nth=0', '2026-06-08');
  await page.fill('input[type=date] >> nth=1', '2026-06-12');
  await page.waitForTimeout(300);
  text = await mainText();
  check('the early job is excluded from a range covering only its (irrelevant) mark-complete date',
        !text.includes('Early Finish Job'));

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

run.suiteName = 'effective-completion-date';
