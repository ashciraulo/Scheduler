/* Issues #7 (modal close-on-drag), #10 (stale capabilities), #19 (confirm
   before losing unsaved changes) and most of #8 (combination rules, dialog
   sizing, sticky ticks, import-time splitting, +proc). */

import { modalSel, clearToast } from '../lib/harness.mjs';
import { makeWipXlsx } from '../fixtures/make-wip-xlsx.mjs';

export default async function run({ page, check, errors, offOrigin, baseUrl }) {
  const XLSX = makeWipXlsx();
  const modal = () => page.locator(modalSel);

  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');

  // ---- #7: a genuine backdrop click on an untouched modal still closes it
  // immediately — no confirmation for a modal nothing has been typed into.
  // Must run before anything below changes a field, or it isn't testing what
  // it says it is.
  await page.click('nav >> text=Job Backlog');
  await page.waitForTimeout(400);
  await page.locator('table tbody tr').first().locator('button[title="Edit"]').click();
  await page.waitForSelector(modalSel, { timeout: 5000 });
  await page.mouse.click(5, 5);
  await page.waitForTimeout(300);
  check('#7 a real backdrop click on an unchanged modal closes it immediately',
        (await modal().count()) === 0);

  // ---- #7: a text-drag released outside a modal must not close it ----
  await page.locator('table tbody tr').first().locator('button[title="Edit"]').click();
  await page.waitForSelector(modalSel, { timeout: 5000 });

  const nameInput = modal().getByLabel(/job name/i);
  await nameInput.fill('Drag test job');
  const box = await nameInput.boundingBox();
  await page.mouse.move(box.x + 10, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(5, 5, { steps: 15 }); // drag well outside the dialog
  await page.mouse.up();
  await page.waitForTimeout(200);

  const stillOpen = await modal().count();
  check('#7 modal survives a text-drag released outside it', stillOpen === 1);
  const keptText = stillOpen ? await modal().getByLabel(/job name/i).inputValue() : '';
  check('#7 typed text is not lost', keptText === 'Drag test job', `value="${keptText}"`);

  const nfpLabel = modal().locator('label', { hasText: /needs further processing/i });
  check('#8 JobModal has the needs-further-processing control', (await nfpLabel.count()) > 0);
  if (await nfpLabel.count()) {
    await nfpLabel.locator('input[type=checkbox]').check();
    check('#8 flag is tickable', await nfpLabel.locator('input[type=checkbox]').isChecked());
  }

  // ---- #19: the modal is now genuinely dirty (name typed, checkbox ticked)
  // — a backdrop click must ask before discarding it, not close outright.
  await page.mouse.click(5, 5);
  await page.waitForTimeout(300);
  check('#19 backdrop click on a changed modal asks before closing, and does not close',
        (await modal().count()) === 1
        && (await modal().locator('text=Discard unsaved changes?').count()) === 1);

  // "Keep editing" dismisses the prompt without losing anything
  await modal().locator('button:has-text("Keep editing")').click();
  await page.waitForTimeout(200);
  check('#19 "Keep editing" returns to the form with changes intact',
        (await modal().count()) === 1
        && (await modal().locator('text=Discard unsaved changes?').count()) === 0
        && (await modal().getByLabel(/job name/i).inputValue()) === 'Drag test job');

  // "Discard changes" actually closes it, and nothing was saved
  await page.mouse.click(5, 5);
  await page.waitForTimeout(200);
  await modal().locator('button:has-text("Discard changes")').click();
  await page.waitForTimeout(400);
  check('#19 "Discard changes" closes the modal', (await modal().count()) === 0);
  const savedNames = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('wf::wf_jobs') || '[]').map((j) => j.name));
  check('#19 the discarded edit was never saved', !savedNames.includes('Drag test job'),
        JSON.stringify(savedNames));

  // ---- #10: deleting a process clears it from resources ----
  await page.click('nav >> text=Templates');
  await page.waitForTimeout(300);
  const tigRow = page.locator('div.flex.items-center.justify-between', { hasText: 'Robotic TIG Welding' }).first();
  await tigRow.locator('button').click();
  await page.waitForTimeout(500);

  const toastText = await page.locator('div.fixed.bottom-5').textContent().catch(() => '');
  check('#10 removing a process reports what it cleaned up',
        /Robotic TIG Welding/.test(toastText || ''), `toast="${(toastText || '').slice(0, 120)}"`);

  await page.click('nav >> text=Equipment');
  // the toast names the process and lingers ~3.2s — wait it out, or the
  // assertion below reads the toast rather than the resource list
  await clearToast(page);
  await page.waitForTimeout(300);
  const mainTxt = await page.locator('main, body').first().innerText();
  check('#10 deleted process no longer shows as a capability on resources',
        !/Robotic TIG Welding/.test(mainTxt),
        (mainTxt.match(/.{0,40}Robotic TIG Welding.{0,40}/) || [''])[0]);

  // ---- #8: the WIP import ----
  await page.click('nav >> text=Job Backlog');
  await page.click('button:has-text("Import from BC WIP export")');
  await page.waitForSelector(modalSel);
  await modal().locator('input[type="file"]').setInputFiles(XLSX);
  await page.waitForTimeout(1200);

  const comboPanel = modal().locator('div', { hasText: /Exclude only in combination/ }).last();
  check('#8 combination-rule editor is present', (await comboPanel.count()) > 0);

  // #8 (reopened): still cramped even at the old 'lg' (1024px) width — the
  // dialog needed to be genuinely wider, not just less noisy.
  const dlgWidth = (await modal().locator('> div').boundingBox()).width;
  check('#8 the import dialog is wider than the old lg cap (1024px)', dlgWidth > 1200, `${dlgWidth}px`);

  // #8 (reopened): the "Qty 0" warning fired on most rows in real BC exports
  // (department jobs are often legitimately quantity-less) and was pure noise
  // eating vertical space — removed outright, qty stays visible in its column.
  const step2Text = await modal().locator('table tbody').innerText();
  check('#8 the noisy "Qty 0" warning is gone', !/Qty 0/.test(step2Text));

  // the dialog must hold its size while keywords are edited
  const dlg = modal().locator('> div');
  const before = await dlg.boundingBox();
  const comboInput = modal().locator('input[placeholder="body + elbow"]');
  await comboInput.fill('body + elbow');
  await comboInput.press('Enter');
  await page.waitForTimeout(600);
  const after = await dlg.boundingBox();
  check('#8 dialog does not resize when a rule is added',
        Math.abs(before.width - after.width) < 1 && Math.abs(before.height - after.height) < 1,
        `${before.width}x${before.height} -> ${after.width}x${after.height}`);

  check('#8 the rule renders as a chip',
        (await modal().locator('span', { hasText: /^body \+ elbow/ }).count()) > 0);

  await modal().getByRole('button', { name: /^Not matched/ }).click();
  await page.waitForTimeout(400);
  const notMatched = await modal().locator('table tbody').innerText();
  check('#8 a row matching the combination is excluded into Not matched',
        /Body elbow spray/i.test(notMatched), notMatched.replace(/\s+/g, ' ').slice(0, 160));

  // a manual untick must survive the next keyword change
  await modal().getByRole('button', { name: /^Ours/ }).click();
  await page.waitForTimeout(400);
  const firstRow = modal().locator('table tbody tr').first();
  const firstName = (await firstRow.innerText()).replace(/\s+/g, ' ').slice(0, 60);
  const cb = firstRow.locator('input[type=checkbox]');
  // plain click + poll: uncheck() asserts the flip within the same tick and
  // doesn't retry, which races the re-render after a re-analysis
  await cb.click();
  await page.waitForFunction(
    (sel) => !document.querySelector(`${sel} table tbody tr input[type=checkbox]`).checked,
    'div.fixed.inset-0', { timeout: 5000 },
  ).catch(() => {});
  check('#8 row unticked by hand', !(await cb.isChecked()), firstName);

  const incInput = modal().locator('input[placeholder="weld, spray, hvof…"]');
  await incInput.fill('coat');
  await incInput.press('Enter');
  await page.waitForTimeout(700);
  const cbAfter = modal().locator('table tbody tr').first().locator('input[type=checkbox]');
  check('#8 the manual untick survives adding a keyword', !(await cbAfter.isChecked()));

  // ---- #8: import-time splitting ----
  await modal().getByRole('button', { name: /Next: set hours/ }).click();
  await page.waitForTimeout(600);
  const rowsBefore = await modal().locator('table tbody tr').count();
  await modal().locator('table tbody tr').first().locator('button[title^="Split"]').click();
  await page.waitForTimeout(400);
  const rowsAfter = await modal().locator('table tbody tr').count();
  check('#8 splitting a row adds an independent row', rowsAfter === rowsBefore + 1,
        `${rowsBefore} -> ${rowsAfter}`);

  const n1 = await modal().locator('table tbody tr').nth(0).locator('input[type=text]').inputValue();
  const n2 = await modal().locator('table tbody tr').nth(1).locator('input[type=text]').inputValue();
  check('#8 the split pieces get distinct, editable names',
        n1 !== n2 && /— 1$/.test(n1) && /— 2$/.test(n2), `"${n1}" / "${n2}"`);

  const procCb = modal().locator('table tbody tr').first().locator('input[type=checkbox]').last();
  await procCb.check();
  check('#8 +proc is settable per row on import', await procCb.isChecked());

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  check('nothing left the origin (WIP stays local)', offOrigin.length === 0, offOrigin.slice(0, 3).join(' | '));
}

run.suiteName = 'import-and-modals';
