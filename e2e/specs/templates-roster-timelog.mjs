/* Issues #9 (template categories + capability propagation), #11 (roster
   availability) and #12 (daily hours log). */

import { modalSel, clearToast } from '../lib/harness.mjs';

export default async function run({ page, check, errors, baseUrl }) {
  const modal = () => page.locator(modalSel);
  const toast = () => page.locator('div.fixed.bottom-5');

  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');

  // ---- #9: categories are a managed list ----
  await page.click('nav >> text=Templates');
  await page.waitForTimeout(500);
  check('#9 a Template categories panel exists',
        (await page.locator('h2:has-text("Template categories")').count()) === 1);

  const seeded = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_categories') || 'null'));
  check('#9 categories seeded from existing templates', Array.isArray(seeded) && seeded.length > 0,
        JSON.stringify(seeded));

  const catInput = page.locator('input[placeholder="Add a category…"]');
  await catInput.fill('Valves');
  await catInput.press('Enter');
  await page.waitForTimeout(500);
  const afterCats = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_categories') || '[]'));
  check('#9 a new category persists', afterCats.includes('Valves'), JSON.stringify(afterCats));

  await page.locator('button:has-text("New template")').click();
  await page.waitForTimeout(500);
  const catOptions = await modal().locator('select').first().locator('option').allInnerTexts();
  check('#9 category is a drop-down listing the managed categories',
        catOptions.some((o) => /Valves/.test(o)), JSON.stringify(catOptions.slice(0, 6)));
  await page.mouse.click(5, 5); // close via backdrop
  await page.waitForTimeout(400);

  // ---- #9: capability requirements propagate to open jobs ----
  const before = await page.evaluate(() => {
    const jobs = JSON.parse(localStorage.getItem('wf::wf_jobs') || '[]');
    const tpl = JSON.parse(localStorage.getItem('wf::wf_templates') || '[]');
    const t = tpl.find((x) => jobs.some((j) => j.templateId === x.id && j.status !== 'complete'));
    return t ? { tplId: t.id, tplName: t.name } : {};
  });
  check('#9 found a template with open jobs to test propagation', !!before.tplId, before.tplName || '');

  await page.locator(`h3:has-text("${before.tplName}")`).first()
    .locator('xpath=../..').locator('button').first().click();
  await page.waitForTimeout(500);
  const tagInput = modal().locator('input[list="cap-tags"]');
  await tagInput.fill('5T Positioner');
  await tagInput.press('Enter');
  await page.waitForTimeout(200);
  await modal().locator('button:has-text("Save")').click();
  await page.waitForTimeout(900);

  const toastTxt = await toast().textContent().catch(() => '');
  check('#9 saving reports the propagation', /capability requirements/i.test(toastTxt || ''),
        (toastTxt || '').slice(0, 120));

  const afterTags = await page.evaluate((tplId) => {
    const jobs = JSON.parse(localStorage.getItem('wf::wf_jobs') || '[]');
    return jobs.filter((j) => j.templateId === tplId && j.status !== 'complete').map((j) => j.tags || []);
  }, before.tplId);
  check('#9 open jobs picked up the new capability requirement',
        afterTags.length > 0 && afterTags.every((t) => t.includes('5T Positioner')),
        JSON.stringify(afterTags));
  await clearToast(page);

  // ---- #9 (regression): a tag typed but never confirmed with Enter/Add must
  // still be saved. This is the actual bug behind "adding a capability
  // requirement seems to do nothing" — typing then clicking Save discarded
  // whatever was in the box with no error, which reads exactly like the
  // feature not working. Fixed by committing on blur (see TagEditor).
  await page.locator(`h3:has-text("${before.tplName}")`).first()
    .locator('xpath=../..').locator('button').first().click();
  await page.waitForTimeout(500);
  const tagInput2 = modal().locator('input[list="cap-tags"]');
  await tagInput2.click();
  await tagInput2.type('Unconfirmed Tag', { delay: 15 });
  // Straight to Save — no Enter, no Add click.
  await modal().locator('button:has-text("Save")').click();
  await page.waitForTimeout(700);
  await clearToast(page);

  const afterUnconfirmed = await page.evaluate((tplId) => {
    const tpl = JSON.parse(localStorage.getItem('wf::wf_templates') || '[]');
    return (tpl.find((t) => t.id === tplId) || {}).tags || [];
  }, before.tplId);
  check('#9 a typed-but-unconfirmed tag is not silently discarded on Save',
        afterUnconfirmed.includes('Unconfirmed Tag'), JSON.stringify(afterUnconfirmed));

  // ---- #23: "equipment this can run on" is derived, not manually picked ----
  // Chassis Frame Weld (tp_2) is untouched by the #9 checks above (those
  // operate on tp_1, the first template with an open job) — seeded with
  // process "Robotic TIG Welding" and tag "5T Positioner", which only
  // Weld Robot 2 and Weld Robot 4 carry.
  await page.locator('h3:has-text("Chassis Frame Weld")').first()
    .locator('xpath=../..').locator('button').first().click();
  await page.waitForSelector(modalSel);
  // Field renders as a <label> wrapping its own content directly (see
  // WeldingScheduler.jsx's Field component) — this locator IS the field,
  // no need to walk up to a parent (which would broaden the scope to the
  // whole form and quietly defeat these checks).
  const equipField = modal().locator('label:has-text("Equipment this can run on")');
  check('#23 the equipment list has no checkboxes — nothing to pick by hand',
        (await equipField.locator('input[type=checkbox]').count()) === 0);
  const equipChips = await equipField.locator('span').allInnerTexts();
  check('#23 it lists only equipment actually matching process + capability tags',
        equipChips.includes('Weld Robot 2') && equipChips.includes('Weld Robot 4')
        && !equipChips.includes('Weld Robot 1') && !equipChips.includes('Weld Robot 3'),
        JSON.stringify(equipChips));

  // adding a requirement no equipment satisfies flips the list to a live
  // warning, before Save — proving it's recomputed from the form state, not
  // read back from some stored list.
  const tagInput3 = modal().locator('input[list="cap-tags"]');
  await tagInput3.fill('Nonexistent Rig');
  await tagInput3.press('Enter');
  await page.waitForTimeout(200);
  check('#23 an unsatisfiable requirement updates the list live, before Save',
        (await modal().locator('text=No equipment currently has every required capability tag').count()) === 1);

  await page.mouse.click(5, 5);
  await page.waitForTimeout(200);
  await modal().locator('button:has-text("Discard changes")').click();
  await page.waitForTimeout(300);

  const templatesAfter = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('wf::wf_templates') || '[]'));
  check('#23 templates no longer persist a manually-picked equipmentIds list',
        templatesAfter.every((t) => t.equipmentIds === undefined),
        JSON.stringify(templatesAfter.map((t) => t.equipmentIds)));

  // ---- #11: roster availability ----
  // #20 merged the old "Roster" tab into "Staff" — the weekly roster table
  // is still there, just alongside the staff list rather than on its own tab.
  await page.click('nav >> text=Staff');
  await page.waitForTimeout(600);
  const firstDaySelect = page.locator('table select').first();
  const opts = await firstDaySelect.locator('option').allInnerTexts();
  check('#11 roster offers a non-production state', opts.some((o) => /no prod/i.test(o)),
        JSON.stringify(opts));

  await firstDaySelect.selectOption('nonprod');
  await page.waitForTimeout(700);
  const rosterSaved = await page.evaluate(() => {
    const d = JSON.parse(localStorage.getItem('wf::wf_staff') || '[]')[0].weeklyRoster.mon;
    return { working: d.working, production: d.production };
  });
  check('#11 non-production is stored as rostered-on but not producing',
        rosterSaved.working === true && rosterSaved.production === false,
        JSON.stringify(rosterSaved));

  // ---- #59: turning Saturday on for the first time defaults to the
  // department's shortened 6h Saturday, not the ordinary 8h weekday shift ----
  const satSelect = page.locator('table select').nth(5); // DAY_COLS: mon,tue,wed,thu,fri,sat,sun
  await satSelect.selectOption('day');
  await page.waitForTimeout(500);
  const satRoster = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('wf::wf_staff') || '[]')[0].weeklyRoster.sat);
  check('#59 turning Saturday on defaults its hours to 6, not the ordinary 8h shift',
        satRoster.working === true && Number(satRoster.hours) === 6, JSON.stringify(satRoster));

  await page.locator('button:has-text("Absence for")').first().click();
  await page.waitForTimeout(500);
  const kindOpts = await modal().locator('select').first().locator('option').allInnerTexts();
  check('#11 absences can be typed (leave / sick / training / other duties)',
        kindOpts.length >= 4 && /training/i.test(kindOpts.join(' ')), JSON.stringify(kindOpts));
  await modal().locator('select').first().selectOption('training');
  await modal().locator('button:has-text("Save absence")').click();
  await page.waitForTimeout(800);
  const absSaved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('wf::wf_staff') || '[]').flatMap((s) => s.leavePeriods || []).map((p) => p.kind));
  check('#11 the absence type persists', absSaved.includes('training'), JSON.stringify(absSaved));

  // ---- #12: daily hours log ----
  await page.locator('button:has-text("Log hours")').click();
  await page.waitForTimeout(700);
  check('#12 the daily log opens', (await modal().count()) === 1);
  check('#12 it pre-lists jobs (or says none were scheduled)',
        (await modal().locator('table tbody tr').count()) >= 1);

  // if nothing was scheduled today (e.g. a weekend), add a job by hand
  const firstCell = await modal().locator('table tbody tr').first().innerText();
  if (/Nothing was scheduled/i.test(firstCell)) {
    await modal().locator('select').last().selectOption({ index: 1 });
    await modal().locator('button:has-text("Add")').click();
    await page.waitForTimeout(400);
  }
  await modal().locator('table tbody input[type=number]').first().fill('3.5');
  await page.waitForTimeout(200);
  await modal().locator('button:has-text("Save log")').click();
  await page.waitForTimeout(900);

  const log = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_timelog') || '[]'));
  check('#12 the log persists', log.length === 1 && log[0].hours === 3.5, JSON.stringify(log));
  await clearToast(page);

  await page.click('nav >> text=Job Backlog');
  await page.waitForTimeout(600);
  check('#12 logged hours show in the backlog',
        /3\.5h logged/.test(await page.locator('table').first().innerText()));

  // the backlog sorts by due date, so find the row by name rather than index
  const loggedName = await page.evaluate((jid) => {
    const j = JSON.parse(localStorage.getItem('wf::wf_jobs') || '[]').find((x) => x.id === jid);
    return j ? j.name : null;
  }, log[0].jobId);
  const jobRow = page.locator('table tbody tr').filter({ hasText: loggedName }).first();
  if (loggedName && (await jobRow.count())) {
    await jobRow.locator('button[title="Mark complete"]').click();
    await page.waitForTimeout(700);
    const val = await modal().locator('input[type=number]').first().inputValue();
    check('#12 completion pre-fills actual hours from the log', val === '3.5', `value="${val}"`);
    check('#12 completion says where the figure came from', /logged daily/i.test(await modal().innerText()));
  } else {
    check('#12 completion pre-fills actual hours from the log', false, `no row for ${loggedName}`);
  }

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

run.suiteName = 'templates-roster-timelog';
