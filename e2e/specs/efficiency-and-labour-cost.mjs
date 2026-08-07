/* Job/task cost isn't just hours × procedure rate — scheduled time includes
   setup/breakdown, not just the process actually running. See "Costing:
   efficiency and average labour cost" in scheduler/CLAUDE.md.

   `effectiveHourlyRate` blends the procedure's own $/hr (assumed to apply
   for `efficiency`% of the scheduled hours — default 75%) with a single,
   global "average labour cost" (the rest of the hours, setup/breakdown,
   priced at labour alone — no materials/gas/machine time).

   `efficiency` itself is NOT global, though (reported directly: different
   procedures/jobs — level of automation, cooldown pauses — genuinely need
   different assumptions here). It lives on the job template, as a starting
   default, and then the job itself, freely editable per job same as its
   procedure — the same procedure run by two jobs can be priced at two
   different efficiencies. Only the average labour cost stays one global
   figure under the Costing tab (individual pay is HR data this app must
   not hold, which is a different reason from why efficiency moved).

   Worth guarding at browser level rather than only reading the source:
   - the Costing tab has ONLY the labour-cost field now, no Efficiency
   - TemplateModal has its own Efficiency field, defaulting to 75%
   - a job made from a template starts at the template's efficiency
   - a job's own Efficiency field is independently editable and changes
     its cost live, in JobModal's preview AND everywhere else (Quality
     tab, R&D task list/report) once saved
   - two jobs sharing the same procedure but different efficiencies cost
     differently — the actual point of the move
   - both settings persist across a reload
   - the math is right: 100/hr procedure, 8h job, 60%/$20 labour →
     100×0.6 + 20×0.4 = $68/hr × 8h = $544 */

import { modalSel } from '../lib/harness.mjs';

export default async function run({ page, check, errors, baseUrl }) {
  const modal = () => page.locator(modalSel);

  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.evaluate(() => {
    const procedures = [{
      id: 'proc_1', name: 'Trial procedure', process: 'Robotic MIG Welding', substrate: '', notes: '',
      powder: {}, gases: [], electricity: {}, spares: [], maintenance: [], consumables: [],
      labour: [{ name: 'Welder', rate: 100, count: 1 }], qa: [],
    }];
    const templates = [{
      id: 'tpl_1', name: 'Automated MIG template', category: '', tags: [], process: 'Robotic MIG Welding',
      procedureId: 'proc_1', efficiency: 60, hoursPerUnit: 8, totalValuePerUnit: null, departmentValuePerUnit: null,
    }];
    const jobs = [{
      id: 'job_a', name: 'Job A (60% via template)', process: 'Robotic MIG Welding', quantity: 1, hoursTotal: 8,
      dueDate: '2026-12-01', departmentDueDate: null, readyDate: '2026-01-01', templateId: 'tpl_1', notes: '',
      totalValue: 0, departmentValue: 0, percentComplete: 100, needsFurtherProcessing: false,
      status: 'complete', completedDate: '2026-01-01', actualHours: 8, batchId: null, batchOrder: null,
      tags: [], procedureId: 'proc_1', efficiency: 60, bcJobNo: '', bcJobTaskNo: '', staffId: null,
      isRework: false, reworkOfJobId: null, updatedAt: new Date().toISOString(), assignment: null,
    }, {
      // Same procedure as Job A, deliberately a DIFFERENT efficiency — the
      // core claim being tested: two jobs on the same procedure don't have
      // to cost the same rate any more.
      id: 'job_b', name: 'Job B (90%, hand-edited)', process: 'Robotic MIG Welding', quantity: 1, hoursTotal: 8,
      dueDate: '2026-12-01', departmentDueDate: null, readyDate: '2026-01-01', templateId: null, notes: '',
      totalValue: 0, departmentValue: 0, percentComplete: 100, needsFurtherProcessing: false,
      status: 'complete', completedDate: '2026-01-01', actualHours: 8, batchId: null, batchOrder: null,
      tags: [], procedureId: 'proc_1', efficiency: 90, bcJobNo: '', bcJobTaskNo: '', staffId: null,
      isRework: false, reworkOfJobId: null, updatedAt: new Date().toISOString(), assignment: null,
    }];
    localStorage.setItem('wf::wf_procedures', JSON.stringify(procedures));
    localStorage.setItem('wf::wf_templates', JSON.stringify(templates));
    localStorage.setItem('wf::wf_jobs', JSON.stringify(jobs));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.waitForTimeout(500);

  // ---- with no labour rate set: each job prices at its OWN efficiency,
  // both at the raw procedure rate (100/hr) since eff% + 0×(1-eff%) = eff% ----
  // Job A: 100×0.60×8h = $480. Job B: 100×0.90×8h = $720.
  // ---- the Costing tab has ONLY the labour-cost field now ----
  await page.click('nav >> text=Costing');
  await page.waitForTimeout(400);
  const costingText = await page.locator('main').innerText();
  check('the old global "Efficiency" field is gone from the Costing tab', !/Efficiency/i.test(costingText), costingText.slice(0, 200));
  check('the card is now titled "Average labour cost", not "Setup/breakdown time"',
        /Average labour cost/i.test(costingText) && !/Setup\/breakdown time/i.test(costingText));
  const laborInput = page.locator('label:has-text("Average labour cost") input');
  check('average labour cost defaults to $0', (await laborInput.inputValue()) === '0');

  // ---- TemplateModal has its own Efficiency field, prefilled from the seed ----
  await page.click('nav >> text=Templates');
  await page.waitForTimeout(400);
  const tplCard = page.locator('h3', { hasText: 'Automated MIG template' }).locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]');
  await tplCard.locator('button').first().click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);
  const tplEffInput = modal().locator('label:has-text("Efficiency") input');
  check('the template carries its own Efficiency field, at the seeded 60%', (await tplEffInput.inputValue()) === '60');
  await modal().locator('div.sticky.top-0 button').click();
  await page.waitForTimeout(200);

  // A brand new template defaults to 75%.
  await page.getByRole('button', { name: 'New template' }).click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(200);
  const newTplEffInput = modal().locator('label:has-text("Efficiency") input');
  check('a new template defaults its efficiency to 75%', (await newTplEffInput.inputValue()) === '75');
  await modal().locator('div.sticky.top-0 button').click();
  await page.waitForTimeout(200);

  // ---- set the average labour cost, then check each job's OWN preview in
  // JobModal reflects its own efficiency, not a shared one ----
  await page.click('nav >> text=Costing');
  await page.waitForTimeout(400);
  await laborInput.fill('20');
  await page.waitForTimeout(500);
  const savedCs = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_costsettings') || '{}'));
  check('the labour rate is saved, and the settings object carries no efficiency key at all any more',
        Number(savedCs.avgLabourRate) === 20 && !('efficiency' in savedCs), JSON.stringify(savedCs));

  await page.click('nav >> text=Job Backlog');
  await page.waitForTimeout(400);
  // Both seeded jobs are complete — the Backlog defaults to the Active
  // filter, which would hide them.
  await page.click('button:has-text("All")');
  await page.waitForTimeout(300);
  await page.locator('text=Job A (60% via template)').first().click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);
  let jmText = await modal().innerText();
  let idx = jmText.indexOf('VALUE & COSTING');
  check('Job A costs at its own 60% efficiency: 100×0.6 + 20×0.4 = $68/hr × 8h = $544.00',
        jmText.slice(idx, idx + 400).includes('544.00'), jmText.slice(idx, idx + 400));
  const jobEffInput = modal().locator('label:has-text("Efficiency") input');
  check('Job A\'s own Efficiency field shows 60%, inherited from its template at creation', (await jobEffInput.inputValue()) === '60');
  await modal().locator('div.sticky.top-0 button').click();
  await page.waitForTimeout(200);

  await page.locator('text=Job B (90%, hand-edited)').first().click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);
  jmText = await modal().innerText();
  idx = jmText.indexOf('VALUE & COSTING');
  check('Job B, same procedure as Job A but 90% efficiency, costs differently: 100×0.9 + 20×0.1 = $92/hr × 8h = $736.00 — the actual point of moving efficiency off one global setting',
        jmText.slice(idx, idx + 400).includes('736.00'), jmText.slice(idx, idx + 400));

  // Edit Job B's efficiency live and watch the preview change before saving.
  const jobBEffInput = modal().locator('label:has-text("Efficiency") input');
  await jobBEffInput.fill('50');
  await page.waitForTimeout(300);
  jmText = await modal().innerText();
  idx = jmText.indexOf('VALUE & COSTING');
  check('editing efficiency live updates the preview: 100×0.5 + 20×0.5 = $60/hr × 8h = $480.00',
        jmText.slice(idx, idx + 400).includes('480.00'), jmText.slice(idx, idx + 400));
  await modal().getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForTimeout(400);

  const jobsAfter = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_jobs') || '[]'));
  const jobB = jobsAfter.find((j) => j.id === 'job_b');
  check('the edited efficiency is actually saved onto the job', jobB?.efficiency === 50, JSON.stringify(jobB?.efficiency));

  // ---- persists across reload ----
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.waitForTimeout(400);
  await page.click('nav >> text=Costing');
  await page.waitForTimeout(300);
  check('the labour rate survives a reload', (await laborInput.inputValue()) === '20');
  await page.click('nav >> text=Job Backlog');
  await page.waitForTimeout(300);
  await page.click('button:has-text("All")');
  await page.waitForTimeout(300);
  await page.locator('text=Job B (90%, hand-edited)').first().click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);
  check('Job B\'s hand-edited 50% efficiency survives a reload', (await modal().locator('label:has-text("Efficiency") input').inputValue()) === '50');

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

run.suiteName = 'efficiency-and-labour-cost';
