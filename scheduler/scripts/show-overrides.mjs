/* ============================================================================
   Show what the override history has captured so far.
   ----------------------------------------------------------------------------
   Step 1 records corrections but deliberately builds no UI for them, so this
   is the only way to look at what's accumulating. That matters more than it
   sounds: data being collected that nobody has ever eyeballed is exactly how a
   learning system ends up confidently trained on a bug.

   Usage:
     npm run show-overrides -- path/to/scheduler-data.json

   Accepts the same file shapes as compare-scoring: a shared-mode
   `scheduler-data.json` ({version, entries}) or a plain object of storage keys.
   In LOCAL (localStorage) mode there is no file to point at — export from the
   browser first, or run the host server.

   Read-only. Writes nothing.
   ============================================================================ */

import { readFileSync } from 'node:fs';
import { summariseOverrides, equipmentFlow, attributeAffinity } from '../src/overrides.js';

const unwrap = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

function load(path) {
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  const entries = raw && typeof raw === 'object' && raw.entries ? raw.entries : raw;
  return {
    overrides: unwrap(entries.wf_overrides) || [],
    equipment: unwrap(entries.wf_equipment) || [],
    templates: unwrap(entries.wf_templates) || [],
    procedures: unwrap(entries.wf_procedures) || [],
  };
}

function main() {
  const path = process.argv[2];
  if (!path) {
    console.error('Usage: npm run show-overrides -- path/to/scheduler-data.json');
    process.exit(1);
  }
  const { overrides, equipment, templates, procedures } = load(path);
  const name = (id) => equipment.find((e) => e.id === id)?.name || id || '—';
  const labels = {
    templateId: (id) => templates.find((t) => t.id === id)?.name || id,
    procedureId: (id) => procedures.find((p) => p.id === id)?.name || id,
    process: (v) => v,
    tags: (v) => v,
  };

  if (!overrides.length) {
    console.log('\nNo overrides recorded yet.');
    console.log('They accumulate as jobs are dragged, pinned from the job modal, or locked.\n');
    return;
  }

  const s = summariseOverrides(overrides);
  console.log(`\n${s.n} correction(s) recorded, ${s.nComparable} with a comparable feature delta.`);
  console.log(`By source: ${JSON.stringify(s.bySource)}`);
  console.log(`By what changed: ${JSON.stringify(s.byChange)}\n`);

  console.log('Where work gets moved:');
  const flow = equipmentFlow(overrides);
  const ids = Object.keys(flow).sort((a, b) =>
    (flow[b].movedFrom + flow[b].movedTo) - (flow[a].movedFrom + flow[a].movedTo));
  ids.forEach((id) => {
    console.log(`  ${name(id).padEnd(22)} moved OFF ${String(flow[id].movedFrom).padStart(3)}   moved ONTO ${String(flow[id].movedTo).padStart(3)}`);
  });

  // The findings most likely to read as immediately true, and whose output is
  // a value for a field the scheduler already honours rather than a learned
  // number. Printed before the weight evidence for that reason.
  for (const key of ['templateId', 'process', 'procedureId', 'tags']) {
    const groups = attributeAffinity(overrides, key);
    const notable = Object.entries(groups)
      .filter(([, g]) => g.n >= 2 && g.top && g.top.share >= 0.6)
      .sort((a, b) => b[1].n - a[1].n);
    if (!notable.length) continue;
    console.log(`\nBy ${key}:`);
    notable.forEach(([value, g]) => {
      const already = g.existingPreferences[g.top.equipmentId];
      // These two cases mean opposite things and must not be printed alike:
      // one asks you to record a preference, the other says a preference you
      // already recorded keeps losing — which is a weights problem, not a
      // missing-preference problem.
      const note = already
        ? `already prefers ${name(g.top.equipmentId)} — the scheduler keeps not honouring it`
        : `consider setting preferred equipment = ${name(g.top.equipmentId)}`;
      console.log(`  ${labels[key](value)}`);
      console.log(`    ${g.top.count} of ${g.n} equipment moves → ${name(g.top.equipmentId)} (${Math.round(g.top.share * 100)}%)`);
      console.log(`    ${note}`);
    });
  }

  console.log('\nMean feature delta (user’s pick minus the scheduler’s):');
  if (!s.nComparable) {
    console.log('  — none of the recorded picks were among the scheduler’s own candidates.');
  } else {
    const terms = Object.keys(s.meanDelta).sort((a, b) => Math.abs(s.meanDelta[b]) - Math.abs(s.meanDelta[a]));
    terms.forEach((t) => {
      const v = s.meanDelta[t];
      // Reading, not instruction. A positive mean means the user's picks keep
      // having MORE of this term than the scheduler's, which is *evidence*
      // that its weight is too low — not a decision to change it.
      const lean = Math.abs(v) < 0.05 ? '' : v > 0 ? '  ← user consistently accepts more of this' : '  ← user consistently avoids this';
      console.log(`  ${t.padEnd(20)} ${v >= 0 ? '+' : ''}${v.toFixed(2)}${lean}`);
    });
  }

  console.log('\nRecent corrections:');
  overrides.slice(-8).reverse().forEach((r) => {
    const when = (r.at || '').slice(0, 10);
    console.log(`  ${when}  ${r.jobName}`);
    console.log(`            ${name(r.scheduler?.equipmentId)} ${r.scheduler?.startDate || ''}  →  ${name(r.user?.equipmentId)} ${r.user?.startDate || ''}   (${r.source}, ${(r.changed || []).join('+')})`);
  });

  console.log(`\n${s.nComparable} comparable record(s). Nothing here changes how the scheduler behaves —`);
  console.log('these are observations, and a handful of them is an anecdote, not a pattern.\n');
}

main();
