/* Issue #33: the job edit modal was unnecessarily narrow for how much it
   held, forcing a lot of vertical scrolling. Widened to Modal's 'lg' size
   and reorganised into a two-column layout with collapsible Section blocks
   (Template, Scheduling, Value & costing, Split job, Business Central
   linking) so a section nobody needs right now can be tucked away instead
   of just adding to the scroll. */

import { modalSel } from '../lib/harness.mjs';

export default async function run({ page, check, errors, baseUrl }) {
  const modal = () => page.locator(modalSel);

  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.click('nav >> text=Job Backlog');
  await page.waitForTimeout(400);

  // ---- Editing an existing job ----
  await page.locator('table tbody tr').first().locator('button[title="Edit"]').click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);

  const dialogWidth = (await modal().locator('> div').boundingBox()).width;
  check('#33 the job modal is wider than the old default (max-w-md, 448px)', dialogWidth > 700, `${dialogWidth}px`);

  const sectionTitles = ['Template', 'Scheduling', 'Value & costing', 'Business Central linking'];
  for (const title of sectionTitles) {
    check(`#33 a "${title}" section exists`, (await modal().locator(`button:has-text("${title}")`).count()) > 0);
  }

  // Scheduling and Value & costing hold fields relevant to every edit, so
  // they default open; Template (browsing a different template mid-edit is
  // rare) and Business Central linking (opt-in, usually empty) default
  // closed on an existing job.
  check('#33 "Scheduling" is open by default on an existing job',
        (await modal().locator('label:has-text("Assigned to")').isVisible()));
  check('#33 "Value & costing" is open by default on an existing job',
        (await modal().locator('label:has-text("Total job value")').isVisible()));
  check('#33 "Template" is collapsed by default on an existing job',
        !(await modal().locator('label:has-text("Search templates")').isVisible()));

  // Toggling a section's header shows/hides its fields without touching
  // anything else.
  const schedulingHeader = modal().locator('button:has-text("Scheduling")');
  await schedulingHeader.click();
  await page.waitForTimeout(150);
  check('#33 collapsing "Scheduling" hides its fields',
        !(await modal().locator('label:has-text("Assigned to")').isVisible()));
  check('#33 "Value & costing" is unaffected by collapsing a different section',
        (await modal().locator('label:has-text("Total job value")').isVisible()));
  await schedulingHeader.click();
  await page.waitForTimeout(150);
  check('#33 expanding it again brings the fields back',
        (await modal().locator('label:has-text("Assigned to")').isVisible()));

  // Collapsing every section still leaves Save reachable without scrolling
  // past a wall of expanded content — the whole point of the restructure.
  // (Template starts collapsed already on an existing job — see above.)
  await modal().locator('button:has-text("Scheduling")').click();
  await modal().locator('button:has-text("Value & costing")').click();
  await page.waitForTimeout(200);
  const saveVisible = await modal().getByRole('button', { name: 'Save', exact: true }).isVisible();
  check('#33 the Save button stays reachable with sections collapsed', saveVisible);

  await page.mouse.click(5, 5);
  await page.waitForTimeout(300);

  // ---- A new job opens with Template + Scheduling expanded (the fields
  // most relevant when starting from nothing) ----
  await page.click('button:has-text("New job")');
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);
  check('#33 "Template" is open by default on a new job',
        (await modal().locator('label:has-text("Search templates")').isVisible()));
  check('#33 "Scheduling" is open by default on a new job',
        (await modal().locator('label:has-text("Assigned to")').isVisible()));

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

run.suiteName = 'job-modal-layout';
