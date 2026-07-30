/* Issue #59, three separate reports bundled together:
   1. Editing any field on a batched job (via the Job modal) silently dropped
      it out of its batch — JobModal.handleSave() built a fresh `data` object
      that never carried batchId/batchOrder through, and the save path
      replaces the job wholesale rather than merging.
   2. "New job" pre-selected the first template in the list, and the "set up
      a custom job instead" toggle only cleared templateId — the name/
      process/hours fields it had already copied in stayed put, so there was
      no way to actually land on a blank job.
   3. Ready-for-processing date defaulted to today (both in the Job modal and
      the WIP-import review table), so a job could get auto-scheduled before
      anyone actually confirmed it was ready. It's now blank by default, and
      a job with no ready date sits out of scheduling entirely. */

export default async function run({ page, check, errors, baseUrl }) {
  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');

  // ---- Seed two batched jobs ----
  await page.evaluate(() => {
    const today = new Date();
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
    const mk = (id, name, order) => ({
      id, name, process: 'Robotic MIG Welding', quantity: 1, hoursTotal: 4,
      dueDate: '2026-12-01', departmentDueDate: null, readyDate: iso(today), templateId: null, notes: '',
      totalValue: 0, departmentValue: 0, percentComplete: 0, needsFurtherProcessing: false,
      status: 'active', completedDate: null, batchId: 'batch_x', batchOrder: order, tags: [], procedureId: '',
      bcJobNo: '', bcJobTaskNo: '', staffId: null, updatedAt: new Date().toISOString(),
      assignment: null,
    });
    const jobs = [mk('job_a', 'Batch Job A', 0), mk('job_b', 'Batch Job B', 1)];
    localStorage.setItem('wf::wf_staff', JSON.stringify(staff));
    localStorage.setItem('wf::wf_equipment', JSON.stringify(equipment));
    localStorage.setItem('wf::wf_jobs', JSON.stringify(jobs));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.click('nav >> text=Job Backlog');
  await page.waitForTimeout(500);

  // ---- 1. Editing a batched job's notes must not drop its batchId ----
  await page.click('text=Batch Job A');
  await page.waitForTimeout(300);
  await page.locator('textarea').first().fill('touched by e2e');
  await page.click('div.fixed.inset-0 >> button:has-text("Save")');
  await page.waitForTimeout(400);
  const afterEdit = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_jobs') || '[]'));
  const a = afterEdit.find((j) => j.name === 'Batch Job A');
  check('#59 saving an edit to a batched job keeps its batchId', a?.batchId === 'batch_x', JSON.stringify(a?.batchId));
  check('#59 the edited field actually saved', a?.notes === 'touched by e2e', a?.notes);

  // ---- 2. "New job" starts with nothing pre-selected ----
  await page.click('button:has-text("New job")');
  await page.waitForTimeout(300);
  const nameVal = await page.getByLabel(/job name/i).inputValue();
  check('#59 a new job starts with a blank name, not a template\'s', nameVal === '', JSON.stringify(nameVal));
  const modalText = await page.locator('div.fixed.inset-0').first().innerText();
  check('#59 the template pickers start unselected', modalText.includes('Select a category') && modalText.includes('Select a template'), modalText.slice(0, 200));
  // Close without saving.
  await page.locator('div.fixed.inset-0 > div > div:first-child button').first().click();
  await page.waitForTimeout(300);
  // Confirm the discard-changes prompt (#19) if it appears.
  const confirmDiscard = page.locator('button:has-text("Discard")');
  if (await confirmDiscard.count()) await confirmDiscard.first().click();
  await page.waitForTimeout(300);

  // ---- 3. Ready-for-processing date is blank by default and gates scheduling ----
  await page.click('button:has-text("New job")');
  await page.waitForTimeout(300);
  const readyVal = await page.locator('input[type=date]').first().inputValue();
  check('#59 ready date starts blank, not today', readyVal === '', JSON.stringify(readyVal));

  await page.getByLabel(/job name/i).fill('No Ready Date Job');
  await page.click('text=Set up a custom (one-off) job instead');
  await page.waitForTimeout(150);
  await page.selectOption('select >> nth=0', { index: 1 });
  await page.click('div.fixed.inset-0 >> button:has-text("Save")');
  await page.waitForTimeout(400);

  const jobsAfterNew = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_jobs') || '[]'));
  const noReady = jobsAfterNew.find((j) => j.name === 'No Ready Date Job');
  check('#59 a job saved with no ready date has none set', !noReady?.readyDate, JSON.stringify(noReady?.readyDate));
  check('#59 a job with no ready date is not auto-scheduled', noReady?.assignment === null, JSON.stringify(noReady?.assignment));

  const tableText = await page.locator('table').first().innerText();
  check('#59 the backlog table shows a placeholder, not "Invalid Date", for the blank ready date', !tableText.includes('Invalid Date'), tableText.includes('Invalid Date'));

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

run.suiteName = 'batch-edit-newjob-readydate';
