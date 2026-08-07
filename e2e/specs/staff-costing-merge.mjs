/* Issue #20: "Roster" and "Equipment & Staff" used to be two separate tabs
   with staff identity split across both and no link between the halves.
   Merged into one Staff tab (identity + capabilities + weekly roster +
   leave); Equipment moved into a new section at the top of Costing, since it
   has no data-model link to cost centres/procedures and only needed a home
   once Staff absorbed the other half of the old tab. */

import { modalSel, clearToast } from '../lib/harness.mjs';

export default async function run({ page, check, errors, baseUrl }) {
  const modal = () => page.locator(modalSel);

  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');

  const navTexts = await page.locator('nav button').allInnerTexts();
  check('#20 nav has one merged Staff tab, no separate Roster or Equipment & Staff',
        navTexts.includes('Staff') && !navTexts.includes('Roster') && !navTexts.includes('Equipment & Staff'),
        JSON.stringify(navTexts));

  // ---- Staff tab: identity + capabilities + roster in one table ----
  await page.click('nav >> text=Staff');
  await page.waitForTimeout(400);
  check('#20 the roster table is the staff list — a capability tag is visible on a row',
        (await page.locator('td', { hasText: 'Robotic MIG Welding' }).count()) > 0);

  const staffCountBefore = (await page.evaluate(() =>
    JSON.parse(localStorage.getItem('wf::wf_staff') || '[]').length));

  await page.locator('button:has-text("Add staff")').click();
  await page.waitForSelector(modalSel);
  await modal().getByLabel(/name/i).first().fill('Devon');
  await modal().getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForTimeout(500);
  await clearToast(page);

  const staffCountAfter = (await page.evaluate(() =>
    JSON.parse(localStorage.getItem('wf::wf_staff') || '[]').length));
  check('#20 adding staff from the Staff tab works', staffCountAfter === staffCountBefore + 1,
        `${staffCountBefore} -> ${staffCountAfter}`);
  check('#20 the new staff member shows up in the roster table',
        (await page.locator('td', { hasText: 'Devon' }).count()) > 0);

  // edit it via the pencil in the sticky name cell
  const row = page.locator('tr', { hasText: 'Devon' }).first();
  await row.locator('button').first().click();
  await page.waitForSelector(modalSel);
  const nameField = modal().getByLabel(/name/i).first();
  check('#20 editing staff from the Staff tab opens the right record',
        (await nameField.inputValue()) === 'Devon');
  await page.mouse.click(5, 5);
  await page.waitForTimeout(300);

  // ---- Costing tab: Equipment section at the top ----
  await page.click('nav >> text=Costing');
  await page.waitForTimeout(400);
  const headings = await page.locator('h2').allInnerTexts();
  check('#20 Costing has an Equipment section', headings.includes('Equipment'), JSON.stringify(headings));
  check('#20 Equipment section lists equipment cards',
        (await page.locator('h3', { hasText: 'Weld Robot 1' }).count()) > 0);
  const mainText = await page.locator('main').first().innerText();
  // Cost centres no longer exist as their own section — equipment absorbed
  // that role directly (interestRate/annualHours/assets live on the
  // equipment record itself; see "Costing: equipment is the cost centre"
  // in scheduler/CLAUDE.md) — so this now just checks Equipment sits above
  // the Costing/Procedures section, same layout intent as before.
  check('#20 Equipment is above Costing (procedures)',
        mainText.indexOf('Equipment') >= 0
        && mainText.indexOf('Equipment') < mainText.indexOf('Costing'));
  check('#20 no Cost centres section remains — equipment carries that data now',
        !/Cost centres/i.test(mainText));

  const equipCountBefore = (await page.evaluate(() =>
    JSON.parse(localStorage.getItem('wf::wf_equipment') || '[]').length));
  await page.locator('h2:has-text("Equipment")').locator('xpath=..')
    .locator('button:has-text("Add")').click();
  await page.waitForSelector(modalSel);
  await modal().getByLabel(/name/i).first().fill('Weld Robot 5');
  await modal().getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForTimeout(500);
  await clearToast(page);
  const equipCountAfter = (await page.evaluate(() =>
    JSON.parse(localStorage.getItem('wf::wf_equipment') || '[]').length));
  check('#20 adding equipment from Costing works', equipCountAfter === equipCountBefore + 1,
        `${equipCountBefore} -> ${equipCountAfter}`);
  check('#20 the new equipment shows up in the Costing equipment list',
        (await page.locator('h3', { hasText: 'Weld Robot 5' }).count()) > 0);

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

run.suiteName = 'staff-costing-merge';
