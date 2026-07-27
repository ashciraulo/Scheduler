/* Issues #35 (job name column too narrow), #36 (job modal footer should stay
   visible without scrolling), #37 (100%-to-department shortcut). */

import { modalSel } from '../lib/harness.mjs';

export default async function run({ page, check, errors, baseUrl }) {
  const modal = () => page.locator(modalSel);

  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');

  // ---- #35: job name column width ----
  await page.click('nav >> text=Schedule');
  await page.waitForTimeout(600);
  const jobCell = page.locator('div', { hasText: 'Bracket Weld - Standard' }).last();
  const cellBox = await jobCell.boundingBox();
  check('#35 the job name column is wider than the old 240px', cellBox.width > 280, `${cellBox.width}px`);

  // ---- #36 / #37: job modal ----
  await page.click('nav >> text=Job Backlog');
  await page.waitForTimeout(400);
  await page.locator('table tbody tr').first().locator('button[title="Edit"]').click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);

  const dialog = modal().locator('> div').first();
  const dbox = await dialog.boundingBox();
  await page.mouse.move(dbox.x + dbox.width / 2, dbox.y + dbox.height / 2);
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(200);
  const saveVisible = await modal().getByRole('button', { name: 'Save', exact: true }).isVisible();
  check('#36 the Save button stays visible after scrolling the modal to the bottom', saveVisible);
  const deleteVisible = await modal().locator('button:has-text("Delete")').isVisible();
  check('#36 the whole footer (Delete, etc.) stays visible, not just Save', deleteVisible);

  const totalValue = await modal().locator('label:has-text("Total job value") input').inputValue();
  await modal().locator('button:has-text("100% to department")').click();
  await page.waitForTimeout(150);
  const deptValue = await modal().locator('label:has-text("Value of your department") input').inputValue();
  check('#37 "100% to department" copies the total value across', deptValue === totalValue, `${totalValue} -> ${deptValue}`);

  // confirms it registered as a real change worth confirming on close (#19
  // dirty-tracking) — a button click doesn't fire a native DOM change event
  await page.mouse.click(5, 5);
  await page.waitForTimeout(300);
  check('#37 the change is tracked as unsaved (asks before discarding)',
        (await modal().locator('text=Discard unsaved changes?').count()) === 1);
  await modal().locator('button:has-text("Discard changes")').click();
  await page.waitForTimeout(300);

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

run.suiteName = 'schedule-and-jobmodal-polish';
