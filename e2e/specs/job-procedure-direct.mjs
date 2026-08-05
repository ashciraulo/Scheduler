/* A job's procedureId — what drives jobCost()/hourlyRate() — used to only
   ever arrive on a job via applyTemplate copying it across from a picked
   template. A custom (one-off) job, or any job whose template was never
   assigned a procedure, had no way to get cost tracking at all short of
   inventing a template just to carry the procedure. JobModal's Value &
   costing section now has its own "Procedure — for cost" select, always
   present (not gated on custom/no-template), filtered to the job's own
   process, independent of whether the job has a template — a template still
   supplies a sensible starting point via applyTemplate, but from there it's
   an ordinary, directly-editable job field like tags or hours, and editing
   it never writes back to the template itself. See "Value & costing" in
   scheduler/CLAUDE.md's JobModal section. */

import { modalSel } from '../lib/harness.mjs';

export default async function run({ page, check, errors, baseUrl }) {
  const modal = () => page.locator(modalSel);

  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.evaluate(() => {
    const procedures = [
      { id: 'proc_mig', name: 'MIG proc', process: 'Robotic MIG Welding', costCentreId: '', substrate: '', notes: '',
        powder: {}, gases: [], electricity: {}, spares: [], maintenance: [], consumables: [],
        labour: [{ name: 'Welder', rate: 40, count: 1 }], qa: [] },
      { id: 'proc_mig2', name: 'MIG proc alt', process: 'Robotic MIG Welding', costCentreId: '', substrate: '', notes: '',
        powder: {}, gases: [], electricity: {}, spares: [], maintenance: [], consumables: [],
        labour: [{ name: 'Welder', rate: 80, count: 1 }], qa: [] },
      { id: 'proc_spray', name: 'Spray proc', process: 'Thermal Spray - HVOF', costCentreId: '', substrate: '', notes: '',
        powder: {}, gases: [], electricity: {}, spares: [], maintenance: [], consumables: [],
        labour: [{ name: 'Sprayer', rate: 60, count: 1 }], qa: [] },
    ];
    const templates = [{
      id: 'tpl_1', name: 'Test template', category: 'Test', process: 'Robotic MIG Welding',
      procedureId: 'proc_mig', tags: [], hoursPerUnit: 1, totalValuePerUnit: 0, departmentValuePerUnit: 0,
    }];
    const jobs = [
      {
        id: 'job_custom', name: 'Custom no-template job', process: 'Robotic MIG Welding', quantity: 1, hoursTotal: 8,
        dueDate: '2026-12-01', departmentDueDate: null, readyDate: '2026-01-01', templateId: null, notes: '',
        totalValue: 500, departmentValue: 500, percentComplete: 0, needsFurtherProcessing: false,
        status: 'active', completedDate: null, batchId: null, batchOrder: null, tags: [], procedureId: '',
        bcJobNo: '', bcJobTaskNo: '', staffId: null, updatedAt: new Date().toISOString(), assignment: null,
      },
      {
        id: 'job_templated', name: 'Templated job', process: 'Robotic MIG Welding', quantity: 1, hoursTotal: 8,
        dueDate: '2026-12-01', departmentDueDate: null, readyDate: '2026-01-01', templateId: 'tpl_1', notes: '',
        totalValue: 500, departmentValue: 500, percentComplete: 0, needsFurtherProcessing: false,
        status: 'active', completedDate: null, batchId: null, batchOrder: null, tags: [], procedureId: 'proc_mig',
        bcJobNo: '', bcJobTaskNo: '', staffId: null, updatedAt: new Date().toISOString(), assignment: null,
      },
    ];
    localStorage.setItem('wf::wf_procedures', JSON.stringify(procedures));
    localStorage.setItem('wf::wf_costcentres', JSON.stringify([]));
    localStorage.setItem('wf::wf_jobs', JSON.stringify(jobs));
    localStorage.setItem('wf::wf_templates', JSON.stringify(templates));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.waitForTimeout(300);

  await page.click('nav >> text=Job Backlog');
  await page.waitForTimeout(300);

  // ---- a job with no template gets a direct Procedure select ----
  await page.locator('table tbody tr', { hasText: 'Custom no-template job' }).locator('button[title="Edit"]').click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);

  const procField = modal().locator('label:has-text("Procedure — for cost")');
  check('a job with no template still shows the Procedure field', (await procField.count()) === 1);
  const procSelect = procField.locator('select');
  check('it starts unset ("None")', (await procSelect.inputValue()) === '');
  const options = await procSelect.locator('option').allTextContents();
  check('only procedures matching the job\'s own process are offered',
        options.includes('MIG proc · $40.00/hr') && !options.some((o) => o.includes('Spray proc')), options.join(' | '));

  await procSelect.selectOption('proc_mig');
  await page.waitForTimeout(200);
  check('picking a procedure shows the cost preview', (await modal().innerText()).includes('Cost —'));

  await modal().getByRole('button', { name: 'Save' }).click();
  await page.waitForTimeout(300);
  let savedJobs = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_jobs') || '[]'));
  let custom = savedJobs.find((j) => j.id === 'job_custom');
  check('the procedure is saved directly onto the template-less job', custom.procedureId === 'proc_mig');

  // ---- reopening shows it persisted, and changing process clears an
  // incompatible procedure rather than silently keeping a mismatched one ----
  await page.locator('table tbody tr', { hasText: 'Custom no-template job' }).locator('button[title="Edit"]').click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);
  check('the saved procedure is shown on reopen', (await modal().locator('label:has-text("Procedure — for cost") select').inputValue()) === 'proc_mig');

  const processSelect = modal().locator('label:has-text("Welding / coating process") select');
  await processSelect.selectOption('Thermal Spray - HVOF');
  await page.waitForTimeout(200);
  const procSelectAfter = modal().locator('label:has-text("Procedure — for cost") select');
  check('switching process clears the now-mismatched procedure', (await procSelectAfter.inputValue()) === '');
  const optionsAfter = await procSelectAfter.locator('option').allTextContents();
  check('the procedure list now reflects the new process instead', optionsAfter.includes('Spray proc · $60.00/hr') && !optionsAfter.some((o) => o.includes('MIG proc')), optionsAfter.join(' | '));

  // Discard this edit via the header ✕ (JobModal has no Cancel button — see
  // CLAUDE.md) so it doesn't pollute the next check.
  await modal().locator('div.sticky.top-0 button').click();
  await page.waitForTimeout(200);
  check('the header close asks before discarding the dirty edit', (await page.locator('text=Discard unsaved changes?').count()) === 1);
  await page.click('button:has-text("Discard changes")');
  await page.waitForTimeout(200);

  // ---- a job WITH a template starts from the template's procedure, but
  // it's directly overridable without touching the template ----
  await page.locator('table tbody tr', { hasText: 'Templated job' }).locator('button[title="Edit"]').click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);
  const templatedProcSelect = modal().locator('label:has-text("Procedure — for cost") select');
  check('a templated job\'s procedure select starts from the template\'s own procedure', (await templatedProcSelect.inputValue()) === 'proc_mig');

  await templatedProcSelect.selectOption('proc_mig2');
  await page.waitForTimeout(200);
  await modal().getByRole('button', { name: 'Save' }).click();
  await page.waitForTimeout(300);

  savedJobs = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_jobs') || '[]'));
  const templatedJob = savedJobs.find((j) => j.id === 'job_templated');
  check('the override is saved onto the job itself', templatedJob.procedureId === 'proc_mig2');
  const savedTemplates = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_templates') || '[]'));
  check('the template itself is untouched by the per-job override', savedTemplates[0].procedureId === 'proc_mig');

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

run.suiteName = 'job-procedure-direct';
