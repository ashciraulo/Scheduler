/* Three related gaps in seeing/trusting a job's actual cost, reported from
   testing:
   1. Logging hours day-by-day (TimeLogModal) had nowhere it showed up
      again afterward — JobModal itself never displayed it.
   2. JobModal's own cost preview always priced at quantity × hoursPerUnit
      (the estimate), even for a completed job with real actualHours on
      record — jobCost()/jobHoursForCost() elsewhere had already switched
      to the actual figure once complete, but this preview hadn't, so a
      completed job's own modal kept showing "cost = rate × predicted
      hours."
   3. Value Reports had no per-job breakdown at all — the operating-cost/
      margin tiles were pure assertions with nothing to check them against.

   Job seeded here: 10h estimated, but only 6h actually worked (3h+3h
   logged day-by-day, confirmed as 6h at completion) — exactly the case
   that exposes #2, since 10h and 6h give different, checkable dollar
   figures ($40/hr labour, 75% default efficiency → $30/hr blended →
   $300 at the (wrong) 10h estimate vs $180 at the (correct) 6h actual). */

export default async function run({ page, check, errors, baseUrl }) {
  const modalSel = 'div.fixed.inset-0.bg-black\\/60';
  const modal = () => page.locator(modalSel);

  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.evaluate(() => {
    const procedures = [{
      id: 'proc_1', name: 'Trial procedure', process: 'Robotic MIG Welding', materialMode: 'powder',
      costCentreId: '', substrate: '', notes: '', powder: { material: '', pricePerKg: 0, gPerMin: 0 },
      wire: { type: '', diameterMm: 0, feedSpeedMPerMin: 0, pricePerKg: 0 },
      gases: [], electricity: {}, spares: [], maintenance: [], consumables: [],
      labour: [{ name: 'Welder', rate: 40, count: 1 }], qa: [],
    }];
    const jobs = [{
      id: 'job_1', name: 'Test Job', process: 'Robotic MIG Welding', quantity: 1, hoursTotal: 10,
      dueDate: '2026-12-01', departmentDueDate: null, readyDate: '2026-01-01', templateId: null, notes: '',
      totalValue: 1000, departmentValue: 500, percentComplete: 100, needsFurtherProcessing: false,
      status: 'complete', completedDate: '2026-07-01', actualHours: 6, batchId: null, batchOrder: null,
      tags: [], procedureId: 'proc_1', bcJobNo: '', bcJobTaskNo: '', staffId: 'st_1',
      updatedAt: new Date().toISOString(), assignment: null,
    }];
    const timeLog = [
      { id: 'tl1', jobId: 'job_1', date: '2026-06-28', hours: 3, staffId: 'st_1', note: '' },
      { id: 'tl2', jobId: 'job_1', date: '2026-06-29', hours: 3, staffId: 'st_1', note: '' },
    ];
    localStorage.setItem('wf::wf_procedures', JSON.stringify(procedures));
    localStorage.setItem('wf::wf_costcentres', JSON.stringify([]));
    localStorage.setItem('wf::wf_jobs', JSON.stringify(jobs));
    localStorage.setItem('wf::wf_timelog', JSON.stringify(timeLog));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.waitForTimeout(300);

  // ---- 1: logged hours visible in JobModal ----
  await page.click('nav >> text=Job Backlog');
  await page.waitForTimeout(400);
  await page.click('button:text-is("complete")');
  await page.waitForTimeout(200);
  await page.locator('tr', { hasText: 'Test Job' }).locator('button[title="Edit"]').click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);

  const modalText = await modal().innerText();
  check('a "Hours logged" field is shown in JobModal', /hours logged/i.test(modalText), modalText.slice(0, 300));
  check('it shows the 6h actually logged day-by-day', /\b6h\b/.test(modalText));
  check('...against the 10h estimate, for comparison', /10h estimated/.test(modalText));
  check('explains that cost is calculated from the recorded actual hours',
        modalText.includes('cost below is calculated from the recorded actual hours'));

  // ---- 2: cost preview prices at the ACTUAL 6h, not the estimated 10h ----
  // $40/hr labour × 75% default efficiency = $30/hr blended.
  // Correct: 6h actual × $30/hr = $180.00. Bug: 10h estimate × $30/hr = $300.00.
  check('the cost line is labelled "(actual)", not "(estimated)"', modalText.includes('(actual)'));
  check('the cost preview reads $30.00/hr × 6h — the actual hours, not the 10h estimate',
        /Cost .*\$30\.00\/hr × 6h \(actual\)/.test(modalText.replace(/\n/g, ' ')), modalText.replace(/\n/g, ' | '));
  check('the calculated cost is $180.00 (correct, from 6h actual)', modalText.includes('180.00'));
  check('...NOT $300.00 (the old bug — 10h estimate at the same rate)', !modalText.includes('300.00'));

  await modal().locator('div.sticky.top-0 button').click();
  await page.waitForTimeout(300);

  // ---- 3: Value Reports shows a per-job Hours/Cost breakdown ----
  await page.click('nav >> text=Value Reports');
  await page.waitForTimeout(400);
  await page.click('button:has-text("Completed")');
  await page.waitForTimeout(200);
  await page.fill('input[type=date] >> nth=0', '2026-01-01');
  await page.fill('input[type=date] >> nth=1', '2026-12-31');
  await page.waitForTimeout(300);

  const reportsText = await page.locator('main').innerText();
  check('the Contributing jobs table has an Hours column', /hours/i.test(reportsText));
  check('the Contributing jobs table has a Cost column', /\bcost\b/i.test(reportsText));
  check('the row shows 6h, labelled actual', /6h.*actual/i.test(reportsText.replace(/\n/g, ' ')), reportsText.replace(/\n/g, ' | ').slice(0, 500));
  check('the row shows the correct $180.00 cost', reportsText.includes('180.00'));
  check('the top operating-cost tile total matches the row — the tile is checkable, not just asserted',
        (reportsText.match(/180\.00/g) || []).length >= 2, reportsText.match(/\$[\d,.]+/g)?.join(','));
  check('the operating-cost tile explains actual vs estimated', reportsText.includes('actual hours where complete'));

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

run.suiteName = 'actual-hours-cost-visibility';
