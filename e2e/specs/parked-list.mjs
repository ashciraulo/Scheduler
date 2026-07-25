/* Issue #8's parked list: rows an import leaves behind are kept so a job whose
   scope later grows into the department can be pulled in without re-running
   the import. Also guards the storage boundary — only job-shaped fields may be
   persisted, never the raw sheet. */

import { modalSel, clearToast } from '../lib/harness.mjs';
import { makeWipXlsx } from '../fixtures/make-wip-xlsx.mjs';

// Exactly what buildSchedulerJobs emits, plus the parkId used to drop a row
// once it has been brought in. Anything else appearing here means the raw WIP
// data has started leaking into storage — see PARKED_KEY in WeldingScheduler.
const ALLOWED_FIELDS = new Set([
  'name', 'process', 'quantity', 'hoursTotal', 'readyDate', 'dueDate',
  'templateId', 'notes', 'totalValue', 'departmentValue', 'percentComplete',
  'needsFurtherProcessing', 'status', 'completedDate', 'bcJobNo', 'bcJobTaskNo',
  'updatedAt', 'assignment', 'parkId', 'staffId',
]);

export default async function run({ page, check, errors, offOrigin, baseUrl }) {
  const XLSX = makeWipXlsx();
  const modal = () => page.locator(modalSel);

  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');

  await page.click('nav >> text=Job Backlog');
  await page.waitForTimeout(300);
  check('parked button hidden when nothing is parked',
        (await page.locator('button:has-text("Parked")').count()) === 0);

  // run an import, leaving the unmatched rows behind
  await page.click('button:has-text("Import from BC WIP export")');
  await modal().locator('input[type="file"]').setInputFiles(XLSX);
  await page.waitForTimeout(1500);
  await modal().getByRole('button', { name: /Next: set hours/ }).click();
  await page.waitForTimeout(600);
  await modal().getByRole('button', { name: /^Import \d+ jobs?/ }).click();
  await page.waitForTimeout(1200);

  const parkedBtn = page.locator('button:has-text("Parked")');
  check('parked button appears after an import', (await parkedBtn.count()) === 1,
        await parkedBtn.innerText().catch(() => ''));

  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_wipparked') || 'null'));
  check('parked list was written to storage', Array.isArray(stored) && stored.length > 0,
        `${stored ? stored.length : 0} rows`);

  const names = (stored || []).map((r) => r.name);
  check('the unmatched rows are the ones parked', names.some((n) => /Turned shaft/i.test(n)),
        JSON.stringify(names));

  const extra = (stored && stored[0] ? Object.keys(stored[0]) : []).filter((k) => !ALLOWED_FIELDS.has(k));
  check('parked rows carry only the job-shaped fields', extra.length === 0, `extra: ${extra.join(', ')}`);
  check('no raw sheet rows or analysis records persisted',
        !JSON.stringify(stored).includes('Job Task Description'));

  // reopen the parked list and bring one in
  await parkedBtn.click();
  await page.waitForTimeout(600);
  const parkedRows = modal().locator('table tbody tr');
  check('parked list opens straight at the review table', (await parkedRows.count()) > 0);
  check('nothing is ticked by default in the parked list',
        (await modal().locator('table tbody input[type=checkbox]:checked').count()) === 0);

  const beforeJobs = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_jobs') || '[]').length);
  await parkedRows.first().locator('input[type=checkbox]').first().click();
  await page.waitForTimeout(300);
  await modal().getByRole('button', { name: /^Import \d+ job/ }).click();
  await page.waitForTimeout(1500);

  const afterJobs = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_jobs') || '[]').length);
  check('bringing a parked job in adds it to the backlog', afterJobs === beforeJobs + 1,
        `${beforeJobs} -> ${afterJobs}`);

  const after = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_wipparked') || '[]'));
  check('the consumed row is no longer parked', after.length === stored.length - 1,
        `${stored.length} -> ${after.length}`);
  await clearToast(page);

  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.click('nav >> text=Job Backlog');
  await page.waitForTimeout(600);
  const stillThere = await page.locator('button:has-text("Parked")').count();
  check('parked list survives a reload', after.length > 0 ? stillThere === 1 : stillThere === 0);

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  check('nothing left the origin', offOrigin.length === 0, offOrigin.slice(0, 2).join(' | '));
}

run.suiteName = 'parked-list';
