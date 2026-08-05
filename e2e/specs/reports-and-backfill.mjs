/* Report generation/export for the Quality and R&D tabs, plus "Log past
   work" — a way to add an R&D entry directly (already complete, with a
   historical date/hours) without scheduling it. See "Reports" and
   "R&D projects and tasks" in scheduler/CLAUDE.md.

   Both reports share one shell (ReportModal) built from two things that
   differ per tab: `buildRows(dateFrom, dateTo)` and `columns`. What's worth
   guarding at browser level rather than only reading the source:
   - each report's columns match what was actually asked for (Quality:
     date/job/job description/hours/reason/cost — R&D: date/person/
     project/task/hours/cost)
   - the date range genuinely filters, not just decorates the table
   - CSV export produces a real file with the same rows and a header row
   - "Log past work" produces a task that's already complete, with no
     equipment/schedule — so it never touches the Schedule view — and one
     matching wf_timelog entry, which is what lets it show up in the R&D
     report through the exact same day-by-day path as normally-logged work
   - editing a backfilled entry replaces its one log entry rather than
     leaving the old date's entry behind as an orphan */

import { modalSel, isoDate, nextWeekday } from '../lib/harness.mjs';

export default async function run({ page, check, errors, baseUrl }) {
  const modal = () => page.locator(modalSel);
  const reportBtn = () => page.getByRole('button', { name: 'Report', exact: true });
  const anchorIso = isoDate(nextWeekday(new Date()));

  // ---- seed: a completed rework job with a real logged day, for the
  // Quality report ----
  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.evaluate((anchorIso) => {
    const procedures = [{
      id: 'proc_1', name: 'Trial procedure', process: 'Robotic MIG Welding', costCentreId: '', substrate: '', notes: '',
      powder: {}, gases: [], electricity: {}, spares: [], maintenance: [], consumables: [],
      labour: [{ name: 'Welder', rate: 50, count: 1 }], qa: [],
    }];
    const jobs = [{
      id: 'job_rw', name: 'Bracket Weld — Rework', process: 'Robotic MIG Welding', quantity: 1, hoursTotal: 3,
      dueDate: '2026-12-01', departmentDueDate: null, readyDate: anchorIso, templateId: null, notes: 'Porosity on inspection',
      totalValue: 0, departmentValue: 0, percentComplete: 100, needsFurtherProcessing: false,
      status: 'complete', completedDate: anchorIso, actualHours: 3, batchId: null, batchOrder: null,
      tags: [], procedureId: 'proc_1', bcJobNo: 'J00120', bcJobTaskNo: '', staffId: null,
      isRework: true, reworkOfJobId: null, updatedAt: new Date().toISOString(), assignment: null,
    }];
    const timeLog = [{ id: 'tl_1', jobId: 'job_rw', date: anchorIso, hours: 3, staffId: '', note: '' }];
    localStorage.setItem('wf::wf_procedures', JSON.stringify(procedures));
    localStorage.setItem('wf::wf_costcentres', JSON.stringify([]));
    localStorage.setItem('wf::wf_jobs', JSON.stringify(jobs));
    localStorage.setItem('wf::wf_timelog', JSON.stringify(timeLog));
    localStorage.setItem('wf::wf_projects', JSON.stringify([]));
    localStorage.setItem('wf::wf_tasks', JSON.stringify([]));
  }, anchorIso);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.waitForTimeout(500);

  // ---- Quality report ----
  await page.click('nav >> text=Quality');
  await page.waitForTimeout(400);
  await reportBtn().click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(400);
  check('the Quality report lists the logged rework entry', (await modal().locator('td', { hasText: 'Bracket Weld — Rework' }).count()) === 1);
  check('...with its job number', (await modal().locator('td', { hasText: 'J00120' }).count()) === 1);
  check('...its reason for rework', (await modal().locator('td', { hasText: 'Porosity on inspection' }).count()) === 1);
  // $50/hr procedure rate, blended at the default 75% efficiency (no
  // average labour cost set) — see "Costing: efficiency and average
  // labour cost" in scheduler/CLAUDE.md — so 3h × ($50 × 0.75) = $112.50,
  // not a flat 3h × $50.
  check('...and cost computed from hours × the blended (efficiency-adjusted) rate', (await modal().locator('td', { hasText: '112.50' }).count()) === 1);

  // Narrow the range to exclude the entry's date — it should disappear
  // entirely, proving the range genuinely filters rather than just labels.
  const dateInputs = modal().locator('input[type=date]');
  await dateInputs.nth(0).fill(isoDate(new Date(Date.now() + 5 * 86400000)));
  await page.waitForTimeout(300);
  check('narrowing the date range past the entry excludes it', (await modal().locator('td', { hasText: 'Bracket Weld — Rework' }).count()) === 0);
  check('the empty state explains there\'s nothing in range', (await modal().locator('text=Nothing logged in this range').count()) === 1);

  // Widen it back and export.
  await dateInputs.nth(0).fill(isoDate(new Date(Date.now() - 30 * 86400000)));
  await page.waitForTimeout(300);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    modal().getByRole('button', { name: /Export CSV/i }).click(),
  ]);
  check('export produces a .csv file', /\.csv$/.test(download.suggestedFilename()), download.suggestedFilename());
  const csvPath = await download.path();
  const fs = await import('node:fs');
  const csv = fs.readFileSync(csvPath, 'utf8');
  check('the CSV has the requested header row', csv.startsWith('Date,Job,Job description/name,Hours logged,Reason for rework,Cost'), csv.split('\n')[0]);
  check('the CSV row matches the table', csv.includes('J00120') && csv.includes('Bracket Weld') && csv.includes('112.50'));

  await modal().getByRole('button', { name: 'Close', exact: true }).click();
  await page.waitForSelector(modalSel, { state: 'detached' });
  await page.waitForTimeout(300);

  // ---- "Log past work": add an R&D entry directly, no scheduling ----
  await page.click('nav >> text=R&D');
  await page.waitForTimeout(400);
  await page.click('button:has-text("Log past work")');
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);
  await modal().locator('input').first().fill('Old coating trial');
  await modal().locator('select').nth(0).selectOption('Robotic MIG Welding');
  await page.waitForTimeout(200);
  await modal().locator('input[type=number]').fill('5');
  const pastDate = isoDate(new Date(Date.now() - 10 * 86400000));
  await modal().locator('input[type=date]').fill(pastDate);
  await modal().getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForTimeout(700);

  const backfilled = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_tasks') || '[]').find((t) => t.name === 'Old coating trial'));
  check('the backfilled task is created already complete', backfilled?.status === 'complete');
  check('...with no assignment — never scheduled on the timeline', backfilled?.assignment == null);
  check('...actual hours and completedDate set from the form', backfilled?.actualHours === 5 && backfilled?.completedDate === pastDate);
  check('...flagged isBackfilled for the "logged" badge', backfilled?.isBackfilled === true);

  const backfillEntry = await page.evaluate((id) => JSON.parse(localStorage.getItem('wf::wf_timelog') || '[]').filter((e) => e.jobId === id), backfilled.id);
  check('a matching wf_timelog entry was created — same path the report reads', backfillEntry.length === 1 && backfillEntry[0].hours === 5 && backfillEntry[0].date === pastDate);

  // No assignment means tasksByEquip never includes it — it should never
  // render a tile on the Schedule view at all. Clear the "logged for..."
  // toast first — it names the task too, and would otherwise be counted
  // as a false positive here.
  await page.locator('div.fixed.bottom-5').waitFor({ state: 'detached', timeout: 6000 }).catch(() => {});
  await page.click('nav >> text=Schedule');
  await page.waitForTimeout(600);
  check('a backfilled entry never appears on the Schedule view', (await page.locator('text=Old coating trial').count()) === 0);
  await page.click('nav >> text=R&D');
  await page.waitForTimeout(400);

  check('the task list badges it as logged directly', (await page.locator('tr', { hasText: 'Old coating trial' }).locator('text=logged').count()) === 1);

  // ---- R&D report picks it up ----
  await reportBtn().click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);
  check('the R&D report lists it', (await modal().locator('td', { hasText: 'Old coating trial' }).count()) === 1);
  check('...for the date it was actually worked, not today', (await modal().locator('tr', { hasText: 'Old coating trial' }).locator('td').first().innerText()) !== '');
  await modal().getByRole('button', { name: 'Close', exact: true }).click();
  await page.waitForSelector(modalSel, { state: 'detached' });
  await page.waitForTimeout(300);

  // ---- editing a backfilled entry replaces its one log entry, no orphan ----
  await page.locator('tr', { hasText: 'Old coating trial' }).click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);
  check('reopening it shows the modal built for this — hours/date prefilled, not TaskModal\'s equipment/pin fields',
        (await modal().locator('input[type=number]').inputValue()) === '5' && (await modal().locator('text=Planned start date').count()) === 0);
  await modal().locator('input[type=number]').fill('8');
  const newerDate = isoDate(new Date(Date.now() - 2 * 86400000));
  await modal().locator('input[type=date]').fill(newerDate);
  await modal().getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForTimeout(700);

  const afterEdit = await page.evaluate((id) => ({
    task: JSON.parse(localStorage.getItem('wf::wf_tasks') || '[]').find((t) => t.id === id),
    entries: JSON.parse(localStorage.getItem('wf::wf_timelog') || '[]').filter((e) => e.jobId === id),
  }), backfilled.id);
  check('the task\'s hours updated', afterEdit.task?.actualHours === 8);
  check('still exactly one log entry — the old date\'s entry was replaced, not left behind', afterEdit.entries.length === 1 && afterEdit.entries[0].date === newerDate && afterEdit.entries[0].hours === 8);

  // ---- delete it ----
  await page.locator('tr', { hasText: 'Old coating trial' }).click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);
  await modal().locator('button:has-text("Delete")').click();
  await page.waitForTimeout(300);
  await page.locator('button:has-text("Delete")').last().click();
  await page.waitForTimeout(500);
  const afterDelete = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_tasks') || '[]'));
  check('the backfilled task is gone', afterDelete.length === 0);

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

run.suiteName = 'reports-and-backfill';
