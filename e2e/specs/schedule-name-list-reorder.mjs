/* Issue #55: the job-name column drag added in #51 only let you drop a job
   onto a timeline day cell. This adds a second interaction on the same drag:
   dropping a job's name onto ANOTHER job's name row (within the list of
   names for one piece of equipment) takes that row's exact slot, reordering
   the list — the existing #51 drag-onto-the-timeline behaviour is kept
   alongside it, unchanged. */

export default async function run({ page, check, errors, baseUrl }) {
  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');

  // Seed three pinned jobs in a known order on one piece of equipment.
  await page.evaluate(() => {
    const today = new Date();
    const iso = (d) => { const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0'); return `${y}-${m}-${day}`; };
    const addDays = (base, n) => { const d = new Date(base); d.setDate(d.getDate() + n); return iso(d); };
    const staff = [{
      id: 'st_1', name: 'Alex', processes: ['Robotic MIG Welding'],
      weeklyRoster: {
        mon: { working: true, production: true, shift: 'day', hours: 8 },
        tue: { working: true, production: true, shift: 'day', hours: 8 },
        wed: { working: true, production: true, shift: 'day', hours: 8 },
        thu: { working: true, production: true, shift: 'day', hours: 8 },
        fri: { working: true, production: true, shift: 'day', hours: 8 },
        sat: { working: false, production: true, shift: 'day', hours: 0 },
        sun: { working: false, production: true, shift: 'day', hours: 0 },
      },
      leavePeriods: [], color: null,
    }];
    const equipment = [{ id: 'eq_1', name: 'Cell 1', type: 'Welding Robot', tags: [], processes: ['Robotic MIG Welding'], unavailableDates: [] }];
    const mk = (id, name, dayOffset) => ({
      id, name, process: 'Robotic MIG Welding', quantity: 1, hoursTotal: 8,
      dueDate: '2026-12-01', departmentDueDate: null, readyDate: iso(today), templateId: null, notes: '',
      totalValue: 0, departmentValue: 0, percentComplete: 0, needsFurtherProcessing: false,
      status: 'active', completedDate: null, batchId: null, batchOrder: null, tags: [], procedureId: '',
      bcJobNo: '', bcJobTaskNo: '', staffId: null, updatedAt: new Date().toISOString(),
      assignment: {
        equipmentId: 'eq_1', startDate: addDays(today, dayOffset), endDate: addDays(today, dayOffset), pinned: true, conflict: false,
        days: [{ date: addDays(today, dayOffset), shift: 'day', staffId: 'st_1', hours: 8 }], claimOrder: dayOffset,
      },
    });
    const jobs = [mk('job_a', 'Job A', 0), mk('job_b', 'Job B', 1), mk('job_c', 'Job C', 2)];
    localStorage.setItem('wf::wf_staff', JSON.stringify(staff));
    localStorage.setItem('wf::wf_equipment', JSON.stringify(equipment));
    localStorage.setItem('wf::wf_jobs', JSON.stringify(jobs));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.click('nav >> text=Schedule');
  await page.waitForTimeout(600);

  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_jobs') || '[]')
    .map((j) => ({ name: j.name, startDate: j.assignment.startDate })));

  const cCell = page.locator('div', { hasText: 'Job C' }).filter({ has: page.locator('span.font-mono') }).last();
  const aCell = page.locator('div', { hasText: 'Job A' }).filter({ has: page.locator('span.font-mono') }).last();
  const aBox = await aCell.boundingBox();

  await cCell.hover();
  await page.mouse.down();
  await page.mouse.move(aBox.x + aBox.width / 2, aBox.y + aBox.height / 2, { steps: 15 });
  await page.waitForTimeout(200);

  // The row being hovered over should show a drop hint (a distinct
  // background tint), same colour the timeline day cells already use.
  const aSticky = page.locator('div.sticky.left-0.z-10', { hasText: 'Job A' });
  const hintBg = await aSticky.evaluate((el) => getComputedStyle(el).backgroundColor);
  check('#55 the target row shows a drop hint while dragging over it', hintBg === 'rgb(247, 222, 216)', hintBg);

  await page.mouse.up();
  await page.waitForTimeout(600);

  const after = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_jobs') || '[]')
    .map((j) => ({ name: j.name, startDate: j.assignment.startDate, pinned: j.assignment.pinned })));
  const a = (name) => after.find((j) => j.name === name);
  const aStart = (name) => before.find((j) => j.name === name).startDate;

  check('#55 dropping Job C onto Job A takes A\'s original slot',
        a('Job C').startDate === aStart('Job A'), JSON.stringify({ before, after }));
  check('#55 the displaced jobs cascade forward, same as any other pin ("incumbent slides")',
        a('Job A').startDate === aStart('Job B') && a('Job B').startDate === aStart('Job C'),
        JSON.stringify(after));
  check('#55 the reordered job is pinned, same as a timeline drop would leave it', a('Job C').pinned === true);

  // The existing #51 behaviour — dropping a name onto a plain timeline day
  // cell — must still work exactly as before, unaffected by this addition.
  const bCell = page.locator('div', { hasText: 'Job B' }).filter({ has: page.locator('span.font-mono') }).last();
  const eqHeader = page.locator('span.font-semibold', { hasText: 'Cell 1' });
  const eqBox = await eqHeader.boundingBox();
  // Measured from the actual rendered day-header cell, not a hardcoded 76 —
  // colWidth scales with the zoom level's default (see "60% default" in
  // scheduler/CLAUDE.md), so a literal pixel width here would silently land
  // the drop on the wrong day column the next time that default changes,
  // same trap two other specs hit when it last moved.
  const dayHeaderRow = page.locator('div.border-b.border-slate-800.bg-slate-900.sticky.top-0.z-20');
  const colWidth = (await dayHeaderRow.locator('> div').nth(1).boundingBox()).width;
  const beforeTimelineDrop = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_jobs') || '[]').find((j) => j.name === 'Job B').assignment.startDate);
  await bCell.hover();
  await page.mouse.down();
  await page.mouse.move(eqBox.x + 6 * colWidth, eqBox.y + 40, { steps: 10 }); // a day column well past the seeded jobs, empty timeline space
  await page.mouse.move(eqBox.x + 6 * colWidth, eqBox.y + 40, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const afterTimelineDrop = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_jobs') || '[]').find((j) => j.name === 'Job B').assignment.startDate);
  check('#51 dragging a job name onto a plain timeline day cell still reassigns it there',
        afterTimelineDrop !== beforeTimelineDrop, `${beforeTimelineDrop} -> ${afterTimelineDrop}`);

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

run.suiteName = 'schedule-name-list-reorder';
