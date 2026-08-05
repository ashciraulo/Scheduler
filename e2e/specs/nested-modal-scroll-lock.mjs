/* Job Backlog/Costing/Patterns (and, once they have enough content, every
   other tab) intermittently stopped scrolling at all — the Schedule view
   kept working throughout, since its grid has its own independent
   `overflow-auto` container rather than relying on the page/body.

   Root cause: `Modal` locked page scroll by capturing
   `document.body.style.overflow` at its own mount time and restoring that
   exact snapshot on unmount. That's correct for one modal at a time, but
   breaks the moment modals nest — e.g. clicking Delete inside an open
   JobModal opens the confirm-delete Modal *while JobModal is still
   mounted*, and depending on which of the two modals' cleanup happened to
   run last, body.style.overflow could get stomped back to 'hidden' even
   after every modal involved had actually closed, silently locking page
   scroll for the rest of the session. Fixed with a shared, reference-
   counted lock (`lockBodyScroll`) instead: still 'hidden' for as long as
   ANY modal is open, reliably cleared only once the last one closes,
   regardless of nesting or close order. See "Modal" in
   scheduler/CLAUDE.md. */

export default async function run({ page, check, errors, baseUrl }) {
  const bodyOverflow = () => page.evaluate(() => document.body.style.overflow);
  const modalCount = () => page.locator('div.fixed.inset-0.bg-black\\/60').count();

  // Enough jobs that the Backlog page is genuinely taller than the
  // viewport — the bug is about document.body.style.overflow specifically,
  // which the checks below assert directly, but a real scroll movement at
  // the end confirms it's not just the attribute value, the page actually
  // scrolls.
  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.evaluate(() => {
    const jobs = [];
    for (let i = 0; i < 30; i++) {
      jobs.push({
        id: `job_${i}`, name: `Filler job ${i}`, process: 'Robotic MIG Welding', quantity: 1, hoursTotal: 2,
        dueDate: '2026-12-01', departmentDueDate: null, readyDate: '2026-01-01', templateId: null, notes: '',
        totalValue: 0, departmentValue: 0, percentComplete: 0, needsFurtherProcessing: false,
        status: 'active', completedDate: null, batchId: null, batchOrder: null, tags: [], procedureId: '',
        bcJobNo: '', bcJobTaskNo: '', staffId: null, updatedAt: new Date().toISOString(), assignment: null,
      });
    }
    localStorage.setItem('wf::wf_jobs', JSON.stringify(jobs));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.waitForTimeout(300);

  check('nothing is locked before any modal has opened', (await bodyOverflow()) === '');

  await page.click('nav >> text=Job Backlog');
  await page.waitForTimeout(300);
  const scrollInfo = await page.evaluate(() => ({ scrollHeight: document.documentElement.scrollHeight, clientHeight: document.documentElement.clientHeight }));
  check('the seeded Backlog is genuinely taller than the viewport (a real scroll test is meaningful)', scrollInfo.scrollHeight > scrollInfo.clientHeight, JSON.stringify(scrollInfo));

  // ---- open JobModal, then nest the confirm-delete dialog inside it ----
  await page.locator('table tbody tr').first().locator('button[title="Edit"]').click();
  await page.waitForSelector('div.fixed.inset-0.bg-black\\/60');
  await page.waitForTimeout(200);
  check('opening a modal locks page scroll', (await bodyOverflow()) === 'hidden');

  await page.click('button:has-text("Delete")');
  await page.waitForTimeout(200);
  check('a nested confirm dialog can open while the first modal is still mounted', (await modalCount()) === 2);
  check('scroll stays locked with two modals open', (await bodyOverflow()) === 'hidden');

  // ---- cancelling the nested dialog must NOT unlock scroll — the outer
  // modal (JobModal) is still open ----
  await page.click('button:has-text("Cancel")');
  await page.waitForTimeout(300);
  check('only the nested dialog closed', (await modalCount()) === 1);
  check('scroll stays locked — the outer modal is still open, this is the exact case that used to break',
        (await bodyOverflow()) === 'hidden');

  // ---- closing the remaining modal must fully unlock ----
  await page.locator('div.fixed.inset-0.bg-black\\/60 button').first().click();
  await page.waitForTimeout(300);
  check('every modal is closed', (await modalCount()) === 0);
  check('scroll is unlocked now that nothing is open', (await bodyOverflow()) === '');

  await page.mouse.move(700, 300);
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(300);
  const scrollY1 = await page.evaluate(() => window.scrollY);
  check('the page actually scrolls again, not just the attribute value', scrollY1 > 0, String(scrollY1));
  await page.evaluate(() => window.scrollTo(0, 0));

  // ---- the full delete-through flow (both modals close TOGETHER in one
  // event) must also end unlocked ----
  await page.locator('table tbody tr').nth(1).locator('button[title="Edit"]').click();
  await page.waitForSelector('div.fixed.inset-0.bg-black\\/60');
  await page.waitForTimeout(200);
  await page.click('button:has-text("Delete")');
  await page.waitForTimeout(200);
  await page.locator('div.fixed.inset-0.bg-black\\/60').last().locator('button:has-text("Delete")').click();
  await page.waitForTimeout(400);
  check('both modals are gone after the full delete-through flow', (await modalCount()) === 0);
  check('scroll is unlocked after that flow too', (await bodyOverflow()) === '');
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(300);
  check('...and the page scrolls', (await page.evaluate(() => window.scrollY)) > 0);

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

run.suiteName = 'nested-modal-scroll-lock';
