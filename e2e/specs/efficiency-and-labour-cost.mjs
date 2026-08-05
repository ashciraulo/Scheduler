/* Job/task cost isn't just hours × procedure rate — scheduled time includes
   setup/breakdown, not just the process actually running. See "Costing:
   efficiency and average labour cost" in scheduler/CLAUDE.md.

   `effectiveHourlyRate` blends the procedure's own $/hr (assumed to apply
   for `efficiency`% of the scheduled hours — default 75%) with a single,
   global "average labour cost" (the rest of the hours, setup/breakdown,
   priced at labour alone — no materials/gas/machine time). Both are new
   settings under the Costing tab. Deliberately ONE average rate, not a
   rate per staff member: individual pay is HR data this app must not hold.

   Worth guarding at browser level rather than only reading the source:
   - the new fields exist, default to 75% / $0, and are editable
   - every cost figure in the app (Quality tab, R&D task list + report,
     project rollups) reflects the blended rate once the labour cost is
     set — not just one of them
   - the setting persists across a reload
   - the math is right: 50/hr procedure, 8h job, 75%/$20 → $340, not $400
     (unblended) or some other figure */

import { modalSel } from '../lib/harness.mjs';

export default async function run({ page, check, errors, baseUrl }) {
  const modal = () => page.locator(modalSel);

  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.evaluate(() => {
    const procedures = [{
      id: 'proc_1', name: 'Trial procedure', process: 'Robotic MIG Welding', costCentreId: '', substrate: '', notes: '',
      powder: {}, gases: [], electricity: {}, spares: [], maintenance: [], consumables: [],
      labour: [{ name: 'Welder', rate: 50, count: 1 }], qa: [],
    }];
    const jobs = [{
      id: 'job_rw', name: 'Rework job', process: 'Robotic MIG Welding', quantity: 1, hoursTotal: 8,
      dueDate: '2026-12-01', departmentDueDate: null, readyDate: '2026-01-01', templateId: null, notes: '',
      totalValue: 0, departmentValue: 0, percentComplete: 100, needsFurtherProcessing: false,
      status: 'complete', completedDate: '2026-01-01', actualHours: 8, batchId: null, batchOrder: null,
      tags: [], procedureId: 'proc_1', bcJobNo: '', bcJobTaskNo: '', staffId: null,
      isRework: true, reworkOfJobId: null, updatedAt: new Date().toISOString(), assignment: null,
    }];
    const tasks = [{
      id: 'task_1', name: 'R&D task', process: 'Robotic MIG Welding', procedureId: 'proc_1',
      hoursTotal: 8, readyDate: '2026-01-01', dueDate: '2026-01-01', projectId: null, staffId: null, notes: '',
      status: 'complete', completedDate: '2026-01-01', actualHours: 8, updatedAt: new Date().toISOString(),
      assignment: null, isBackfilled: true,
    }];
    localStorage.setItem('wf::wf_procedures', JSON.stringify(procedures));
    localStorage.setItem('wf::wf_costcentres', JSON.stringify([]));
    localStorage.setItem('wf::wf_jobs', JSON.stringify(jobs));
    localStorage.setItem('wf::wf_tasks', JSON.stringify(tasks));
    localStorage.setItem('wf::wf_projects', JSON.stringify([]));
    localStorage.setItem('wf::wf_timelog', JSON.stringify([{ id: 'tl1', jobId: 'task_1', date: '2026-01-01', hours: 8, staffId: '', note: '' }]));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.waitForTimeout(500);

  // ---- before setting a labour rate: 75% default, $0 labour → 50×0.75×8 = $300 ----
  await page.click('nav >> text=Quality');
  await page.waitForTimeout(400);
  let qualityText = await page.locator('main').innerText();
  check('with no labour rate set, cost is the procedure rate at 75% efficiency only ($300.00, not $400.00 unblended)',
        qualityText.includes('300.00') && !qualityText.includes('400.00'), qualityText.match(/\$[\d,.]+/g)?.join(','));

  // ---- the Costing tab has the new fields, correct defaults ----
  await page.click('nav >> text=Costing');
  await page.waitForTimeout(400);
  check('the Setup/breakdown time section exists', (await page.locator('text=Setup/breakdown time').count()) === 1);
  const effInput = page.locator('label:has-text("Efficiency (%)") input');
  const laborInput = page.locator('label:has-text("Average labour cost") input');
  check('efficiency defaults to 75%', (await effInput.inputValue()) === '75');
  check('average labour cost defaults to $0', (await laborInput.inputValue()) === '0');

  await laborInput.fill('20');
  await page.waitForTimeout(500);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_costsettings') || '{}'));
  check('the labour rate is saved', Number(saved.avgLabourRate) === 20, JSON.stringify(saved));

  // ---- every cost figure in the app now reflects the blend: 50×0.75 + 20×0.25 = 42.5/hr × 8h = $340 ----
  await page.click('nav >> text=Quality');
  await page.waitForTimeout(400);
  qualityText = await page.locator('main').innerText();
  check('Quality tab cost updates to the blended rate ($340.00)', qualityText.includes('340.00'), qualityText.match(/\$[\d,.]+/g)?.join(','));

  await page.click('nav >> text=R&D');
  await page.waitForTimeout(400);
  let rdText = await page.locator('main').innerText();
  check('R&D task list cost also reflects the blend ($340.00)', rdText.includes('340.00'), rdText.match(/\$[\d,.]+/g)?.join(','));

  await page.getByRole('button', { name: 'Report', exact: true }).click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);
  await modal().locator('input[type=date]').first().fill('2026-01-01');
  await page.waitForTimeout(300);
  const reportText = await modal().locator('tbody').innerText();
  check('the R&D report also prices the row at the blended rate ($340.00)', reportText.includes('340.00'), reportText);
  await modal().getByRole('button', { name: 'Close', exact: true }).click();
  await page.waitForTimeout(300);

  // ---- persists across reload ----
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.click('nav >> text=Quality');
  await page.waitForTimeout(400);
  qualityText = await page.locator('main').innerText();
  check('the blended cost survives a reload', qualityText.includes('340.00'), qualityText.match(/\$[\d,.]+/g)?.join(','));

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

run.suiteName = 'efficiency-and-labour-cost';
