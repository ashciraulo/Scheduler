/* "Mark complete" inside JobModal has to close the modal first (a separate
   ActualHoursModal asks for actual hours; this file never nests two fully
   independent top-level modals under one editingX state) — but that used
   to strand the user back at a bare Backlog with nothing open at all.
   "Mark for rework" (only offered on a completed job) was real and correct
   the instant they reopened the job by hand, but nothing told them to, and
   reported from testing: it read as "the modal isn't updating to show
   Mark for rework" and "doesn't appear until the scheduler is re-opened".

   Fixed by reopening JobModal on the freshly-completed job automatically
   — same close-then-reopen-on-a-tick pattern onOpenRelatedJob already uses
   elsewhere in this file — for BOTH ways out of the actual-hours dialog:
   confirming (job completes, modal reopens showing Mark for rework) and
   cancelling (job stays as it was, modal reopens on the same job rather
   than losing the edit-in-progress entirely). Completing a job from the
   Backlog row's own inline checkmark (no JobModal ever open) is
   deliberately unaffected — there's nothing to reopen. */

export default async function run({ page, check, errors, baseUrl }) {
  const modalSel = 'div.fixed.inset-0.bg-black\\/60';
  const modal = () => page.locator(modalSel);

  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.evaluate(() => {
    const mk = (id, name, hoursTotal) => ({
      id, name, process: 'Robotic MIG Welding', quantity: 1, hoursTotal,
      dueDate: '2026-12-01', departmentDueDate: null, readyDate: '2026-01-01', templateId: null, notes: '',
      totalValue: 0, departmentValue: 0, percentComplete: 0, needsFurtherProcessing: false,
      status: 'active', completedDate: null, batchId: null, batchOrder: null, tags: [], procedureId: '',
      bcJobNo: '', bcJobTaskNo: '', staffId: null, updatedAt: new Date().toISOString(), assignment: null,
    });
    const jobs = [mk('job_confirm', 'Confirm Test Job', 8), mk('job_cancel', 'Cancel Test Job', 5), mk('job_backlog', 'Backlog Toggle Job', 4)];
    localStorage.setItem('wf::wf_jobs', JSON.stringify(jobs));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.waitForTimeout(300);
  await page.click('nav >> text=Job Backlog');
  await page.waitForTimeout(400);

  // ---- confirming actual hours reopens JobModal on the now-complete job ----
  await page.locator('tr', { hasText: 'Confirm Test Job' }).locator('button[title="Edit"]').click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);
  await modal().locator('button:has-text("Mark complete")').click();
  await page.waitForTimeout(300);
  check('marking complete opens the actual-hours dialog', (await page.locator('text=/actual hours/i').count()) > 0);

  await modal().locator('input[type=number]').first().fill('8');
  await modal().getByRole('button', { name: /Save.*complete/i }).click();
  await page.waitForTimeout(500);

  check('JobModal reopens automatically — no manual navigation back through the Backlog', (await modal().count()) === 1);
  check('reopened on the SAME job, now showing 100% complete', (await modal().innerText()).includes('100%'));
  check('"Mark for rework" is visible immediately, without the user reopening it themselves',
        (await modal().locator('button:has-text("Mark for rework")').count()) === 1);

  await modal().locator('div.sticky.top-0 button').click();
  await page.waitForTimeout(200);

  // ---- cancelling the actual-hours dialog reopens the SAME (unchanged) job ----
  await page.locator('tr', { hasText: 'Cancel Test Job' }).locator('button[title="Edit"]').click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);
  await modal().locator('button:has-text("Mark complete")').click();
  await page.waitForTimeout(300);
  await modal().getByRole('button', { name: 'Cancel' }).click();
  await page.waitForTimeout(300);

  check('cancelling the hours dialog also reopens JobModal, not a bare Backlog',
        (await modal().locator('input').first().inputValue()) === 'Cancel Test Job');
  const afterCancel = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_jobs') || '[]').find((j) => j.id === 'job_cancel'));
  check('the job itself is unchanged — cancelling did not complete it', afterCancel?.status === 'active');
  await modal().locator('div.sticky.top-0 button').click();
  await page.waitForTimeout(200);

  // ---- completing from the Backlog row's own toggle (no JobModal open) reopens nothing ----
  await page.locator('tr', { hasText: 'Backlog Toggle Job' }).locator('button[title="Mark complete"]').click();
  await page.waitForTimeout(300);
  check('the actual-hours dialog still opens from the Backlog toggle', (await page.locator('text=/actual hours/i').count()) > 0);
  await modal().locator('input[type=number]').first().fill('4');
  await modal().getByRole('button', { name: /Save.*complete/i }).click();
  await page.waitForTimeout(500);
  check('no modal reopens — there was never a JobModal to return to', (await modal().count()) === 0);
  const backlogJob = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_jobs') || '[]').find((j) => j.id === 'job_backlog'));
  check('the job still completed correctly via this path', backlogJob?.status === 'complete' && backlogJob?.actualHours === 4);

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

run.suiteName = 'complete-reopens-jobmodal';
