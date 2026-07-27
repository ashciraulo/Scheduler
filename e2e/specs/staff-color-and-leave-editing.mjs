/* Issues #40 (staff colour on the schedule timeline should be assignable,
   not fixed/random) and #41 (leave/absences should be editable, not just
   deletable). */

import { modalSel, clearToast } from '../lib/harness.mjs';

// The browser normalises an inline `style` attribute's colour to
// `rgb(r, g, b)` on read regardless of how it was written (hex, in this
// app's case), so comparisons against the STAFF_PALETTE hex strings need
// the same conversion applied before comparing.
const hexToRgb = (hex) => {
  const n = parseInt(hex.replace('#', ''), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};

export default async function run({ page, check, errors, baseUrl }) {
  const modal = () => page.locator(modalSel);

  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.click('nav >> text=Staff');
  await page.waitForTimeout(400);

  // ---- #40: staff colour ----
  await page.locator('tr', { hasText: 'Alex' }).first().locator('button').first().click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);

  const colourField = modal().locator('label:has-text("Timeline colour")');
  check('#40 the staff modal has a Timeline colour field', (await colourField.count()) === 1);
  const swatches = colourField.locator('button[style]');
  check('#40 there are multiple colour swatches to pick from', (await swatches.count()) > 1, `${await swatches.count()}`);
  const chosenColor = await swatches.nth(2).getAttribute('style');
  await swatches.nth(2).click();
  await page.waitForTimeout(150);
  await modal().getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForTimeout(500);

  const alexAfter = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_staff') || '[]').find((s) => s.name === 'Alex'));
  check('#40 the chosen colour is saved on the staff record', !!alexAfter.color, JSON.stringify(alexAfter.color));
  check('#40 the swatch clicked and the saved colour match',
        chosenColor.includes(hexToRgb(alexAfter.color)), `${chosenColor} vs ${alexAfter.color} (${hexToRgb(alexAfter.color)})`);

  // reopening shows it selected (a real, persisted choice, not just a visual click)
  await page.locator('tr', { hasText: 'Alex' }).first().locator('button').first().click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);
  const ring = modal().locator('label:has-text("Timeline colour") button.ring-amber-400');
  check('#40 reopening the modal shows the saved colour as selected', (await ring.count()) === 1);
  await page.mouse.click(5, 5);
  await page.waitForTimeout(300);

  // the schedule view actually renders jobs staffed by Alex in that colour
  await page.click('nav >> text=Schedule');
  await page.waitForTimeout(600);
  const aBlock = page.locator('div[style*="' + hexToRgb(alexAfter.color) + '"]').first();
  check('#40 the Schedule view renders a block in the chosen colour', (await aBlock.count()) > 0);

  // ---- #41: leave/absence editing ----
  await page.click('nav >> text=Staff');
  await page.waitForTimeout(400);
  await page.locator('button:has-text("Absence for Alex")').click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(200);
  await modal().locator('label:has-text("Reason") input').fill('Original reason');
  await modal().getByRole('button', { name: 'Save absence', exact: true }).click();
  await page.waitForTimeout(500);
  await clearToast(page);

  const row = page.locator('tr', { hasText: 'Original reason' });
  check('#41 the new absence appears in the leave table', (await row.count()) === 1);
  const idBefore = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('wf::wf_staff') || '[]').find((s) => s.name === 'Alex').leavePeriods.find((p) => p.reason === 'Original reason').id);

  check('#41 the leave row has an edit control, not just delete', (await row.locator('button').count()) === 2);
  await row.locator('button').first().click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(200);
  const title = await modal().locator('h3').first().innerText();
  check('#41 the modal opens in "Edit" mode with the right person', /Edit absence.*Alex/.test(title), title);
  const reasonValue = await modal().locator('label:has-text("Reason") input').inputValue();
  check('#41 the form is pre-filled with the existing entry', reasonValue === 'Original reason', reasonValue);

  await modal().locator('label:has-text("Reason") input').fill('Edited reason');
  await modal().getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.waitForTimeout(500);

  const staffAfter = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_staff') || '[]').find((s) => s.name === 'Alex'));
  check('#41 editing updates the existing entry in place, not a duplicate',
        staffAfter.leavePeriods.length === 1 && staffAfter.leavePeriods[0].id === idBefore
        && staffAfter.leavePeriods[0].reason === 'Edited reason',
        JSON.stringify(staffAfter.leavePeriods));

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

run.suiteName = 'staff-color-and-leave-editing';
