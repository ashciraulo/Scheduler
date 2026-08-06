/* ProcedureEditor used to be built around thermal-spray powder feedstock
   only (a "Powder" section with $/kg and g/min) — fine for HVOF/Plasma
   Spray, wrong for anything wire-fed (Robotic MIG/TIG welding, and Thermal
   Spray - Arc Spray, which is ALSO wire-fed despite being a spray process,
   so `process` alone can't tell powder and wire apart). A "Feedstock"
   radio toggle (Powder/Wire) now switches between the existing powder
   fields and a new wire section: wire type (a fixed list with known
   densities — WIRE_DENSITIES), diameter, feed speed and $/kg. Wire's
   consumption rate (and so its $/hr) is CALCULATED from those, not entered
   directly, via the standard welding deposition-rate formula: cross-
   sectional area × feed speed × density = g/min. See "Costing: wire
   feedstock" in scheduler/CLAUDE.md. */

import { modalSel } from '../lib/harness.mjs';

export default async function run({ page, check, errors, baseUrl }) {
  const modal = () => page.locator(modalSel);

  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.waitForTimeout(300);
  await page.click('nav >> text=Costing');
  await page.waitForTimeout(400);

  // ---- a new procedure defaults to Powder, unchanged from before ----
  await page.getByRole('button', { name: 'New procedure' }).click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(200);

  check('a "Feedstock" toggle is present', (await modal().locator('text=Feedstock').count()) === 1);
  const powderRadio = modal().locator('input[type=radio][name=materialMode]').nth(0);
  const wireRadio = modal().locator('input[type=radio][name=materialMode]').nth(1);
  check('Powder is selected by default', await powderRadio.isChecked());
  check('the powder fields (g/min) show by default', (await modal().locator('text=g/min').count()) === 1);
  check('the wire fields do NOT show by default', (await modal().locator('text=Wire type').count()) === 0);

  // ---- switching to Wire swaps the fields, and the $/hr is CALCULATED ----
  await wireRadio.check();
  await page.waitForTimeout(150);
  // >0, not ===1 — the substring text selector also matches ancestor
  // containers whose concatenated text includes "Wire type", not just the
  // header span itself.
  check('choosing Wire shows the wire fields', (await modal().locator('text=Wire type').count()) > 0);
  check('...and hides the powder fields', (await modal().locator('text=g/min').count()) === 0);

  const wireBlock = modal().locator('div', { hasText: 'Wire type' }).locator('xpath=ancestor::div[contains(@class,"mb-3")]').first();
  const typeSel = wireBlock.locator('select');
  const diaInput = wireBlock.locator('input').nth(0);
  const feedInput = wireBlock.locator('input').nth(1);
  const priceInput = wireBlock.locator('input').nth(2);

  const wireTypeOptions = await typeSel.locator('option').allTextContents();
  check('the wire-type list offers the four named materials', ['Carbon Steel', 'Stainless Steel', 'Nickel Alloy', 'Titanium'].every((t) => wireTypeOptions.includes(t)), wireTypeOptions.join(', '));

  await typeSel.selectOption('Carbon Steel');
  await diaInput.fill('1.2');
  await feedInput.fill('5');
  await priceInput.fill('3.5');
  await page.waitForTimeout(200);

  // Standard deposition-rate formula: area(mm²) × feed(m/min) × density(g/cm³) = g/min,
  // with no extra unit-conversion factor (mm→m and cm³→mm³ cancel exactly).
  // 1.2mm dia → r=0.6mm → area = π×0.6² = 1.13097mm²; density(Carbon Steel)=7.85;
  // feed=5m/min → 1.13097×7.85×5 = 44.394 g/min → ×0.06 = 2.6636 kg/hr → ×$3.50 = $9.32/hr.
  const wireText = await wireBlock.innerText();
  check('the wire $/hr is calculated, not entered — $9.32/hr for 1.2mm Carbon Steel @ 5m/min, $3.50/kg',
        /\$9\.32\s*\/hr/.test(wireText), wireText.replace(/\n/g, ' | '));
  check('the consumption figure (density + kg/hr) is shown so the $/hr isn\'t a black box',
        /7\.85 g\/cm.*2\.66 kg\/hr/.test(wireText.replace(/\n/g, ' ')), wireText.replace(/\n/g, ' | '));

  // ---- switching modes preserves the OTHER mode's data, doesn't clear it ----
  await powderRadio.check();
  await page.waitForTimeout(150);
  check('switching back to Powder shows its fields again', (await modal().locator('text=g/min').count()) === 1);
  await wireRadio.check();
  await page.waitForTimeout(150);
  const wireTextAfterRoundTrip = await wireBlock.innerText();
  check('the wire data survives a round trip through Powder and back', wireTextAfterRoundTrip.includes('Carbon Steel') && /\$9\.32\s*\/hr/.test(wireTextAfterRoundTrip));

  // ---- save, and the CostingView card reflects it correctly ----
  await modal().getByRole('button', { name: 'Save' }).click();
  await page.waitForTimeout(500);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_procedures') || '[]'));
  const newProc = saved[saved.length - 1];
  check('materialMode is saved as "wire"', newProc.materialMode === 'wire');
  check('the wire fields are saved onto the procedure', newProc.wire?.type === 'Carbon Steel' && newProc.wire?.diameterMm === 1.2 && newProc.wire?.feedSpeedMPerMin === 5 && newProc.wire?.pricePerKg === 3.5, JSON.stringify(newProc.wire));
  check('the OTHER mode\'s data (powder) is still present, not wiped by switching modes', !!newProc.powder, JSON.stringify(newProc.powder));

  await page.waitForTimeout(2200); // let the save toast fade — it also contains the procedure name
  const card = page.locator('div.font-semibold.text-slate-100.text-sm.truncate', { hasText: newProc.name }).locator('xpath=ancestor::div[contains(@class,"rounded-lg")]').first();
  const cardText = await card.innerText();
  check('the Costing card labels the row "Wire", not "Powder"', cardText.includes('Wire') && !cardText.includes('Powder'), cardText.replace(/\n/g, ' | '));
  check('the card total includes the calculated wire cost ($9.32/hr)', cardText.includes('9.32'), cardText.replace(/\n/g, ' | '));

  // ---- an OLD procedure with no materialMode/wire field at all still opens cleanly ----
  await page.evaluate(() => {
    const old = {
      id: 'proc_old', name: 'Legacy powder procedure', process: 'Thermal Spray - HVOF', costCentreId: '', substrate: '', notes: '',
      powder: { material: 'Old Powder', pricePerKg: 50, gPerMin: 40 },
      gases: [], electricity: { kw: 0, tariff: 0 }, spares: [], maintenance: [], consumables: [], labour: [], qa: [],
    };
    const existing = JSON.parse(localStorage.getItem('wf::wf_procedures') || '[]');
    localStorage.setItem('wf::wf_procedures', JSON.stringify([...existing, old]));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.click('nav >> text=Costing');
  await page.waitForTimeout(400);

  const legacyCard = page.locator('div.font-semibold.text-slate-100.text-sm.truncate', { hasText: 'Legacy powder procedure' }).locator('xpath=ancestor::div[contains(@class,"rounded-lg")]').first();
  check('a legacy (no materialMode/wire) procedure still shows correctly — $120.00/hr powder cost', (await legacyCard.innerText()).includes('120.00'), (await legacyCard.innerText()).replace(/\n/g, ' | '));

  await page.locator('div.font-semibold.text-slate-100.text-sm.truncate', { hasText: 'Legacy powder procedure' }).click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);
  check('the legacy procedure opens with Powder selected, no crash reading a missing .wire object',
        await modal().locator('input[type=radio][name=materialMode]').nth(0).isChecked());
  check('its powder values are shown correctly', (await modal().locator('input[placeholder="Material"]').inputValue()) === 'Old Powder');

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

run.suiteName = 'procedure-wire-feedstock';
