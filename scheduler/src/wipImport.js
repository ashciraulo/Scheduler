/* ============================================================================
   WIP IMPORT ENGINE
   ----------------------------------------------------------------------------
   Ported from the standalone `wip-importer/wip-importer.html` so the scheduler
   can read a Business Central WIP export (.xlsx) directly, instead of the user
   having to run a second tool and hand a JSON file across.

   Everything here is pure logic — no DOM rendering, no storage. The React
   layer (ImportJobsModal in WeldingScheduler.jsx) owns the UI and persistence.

   Two properties of the original tool are deliberately preserved:

   1. **Nothing leaves the machine.** No network calls. An .xlsx is a ZIP of
      XML, unpacked with the browser-native DecompressionStream and parsed with
      DOMParser — no SheetJS, no CDN. WIP data is commercially sensitive.
   2. **Nothing is dropped silently.** Duplicates, held and complete rows stay
      visible and tickable; only the analysis's default *selection* changes.

   The behavioural rules below each fixed a real bug against real BC output.
   Don't regress them — see wip-importer/CLAUDE.md for the full history.
   ============================================================================ */

/* ============================================================================
   XLSX READER  (no library — an .xlsx is a ZIP of XML)
   ============================================================================ */

async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function unzip(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const bytes = new Uint8Array(arrayBuffer);
  const files = {};

  // Locate End Of Central Directory record (scan back from the tail)
  let eocd = -1;
  const maxBack = Math.min(bytes.length, 66000);
  for (let i = bytes.length - 22; i >= bytes.length - maxBack && i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid .xlsx (no ZIP end record found).');

  const entryCount = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true); // start of central directory

  for (let n = 0; n < entryCount; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const cmtLen = view.getUint16(p + 32, true);
    const lho = view.getUint32(p + 42, true); // local header offset
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));

    // Read the local header to find where the data actually starts
    const lnLen = view.getUint16(lho + 26, true);
    const leLen = view.getUint16(lho + 28, true);
    const dataStart = lho + 30 + lnLen + leLen;
    files[name] = { method, raw: bytes.subarray(dataStart, dataStart + compSize) };
    p += 46 + nameLen + extraLen + cmtLen;
  }

  return {
    async read(name) {
      const f = files[name];
      if (!f) return null;
      const out = f.method === 0 ? f.raw : await inflateRaw(f.raw);
      return new TextDecoder().decode(out);
    },
    names: Object.keys(files),
  };
}

function colToIndex(ref) {
  // "BC12" -> 54 (0-based column index)
  let s = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c >= 65 && c <= 90) s = s * 26 + (c - 64);
    else break;
  }
  return s - 1;
}

// Excel serial date -> ISO yyyy-mm-dd. Excel's epoch is 1899-12-30 (accounts
// for the historical 1900 leap-year bug).
// IMPORTANT: serial 0 is NOT a date — it is how Business Central (and Excel)
// represent an EMPTY date field. Naively converting it yields "1899-12-30",
// which is truthy and makes empty dates look like real ones.
const MIN_SERIAL = 1;       // 1899-12-31; anything below this is empty/invalid
const MAX_SERIAL = 2958465; // 9999-12-31, Excel's ceiling
export function serialToISO(n) {
  if (typeof n !== 'number' || !isFinite(n)) return null;
  if (n < MIN_SERIAL || n > MAX_SERIAL) return null;
  const d = new Date(Math.round((n - 25569) * 86400 * 1000));
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function isDateFormat(fmt) {
  if (!fmt) return false;
  const f = fmt.toLowerCase();
  if (/(^|[^\]])[dmy]/.test(f.replace(/\[[^\]]*\]/g, '')) && /[dmy]/.test(f)) {
    return !/^[#0.,%\s]*$/.test(f);
  }
  return false;
}

/* ----------------------------------------------------------------------------
   Namespace-agnostic element lookup.
   getElementsByTagName() matches the literal tag name, so it finds <row> but
   NOT <x:row>. Both are valid OOXML: Excel writes the unprefixed form, while
   Business Central often declares the namespace with a prefix. Match on
   localName so either works.
   ---------------------------------------------------------------------------- */
function els(parent, localName) {
  if (!parent) return [];
  let out = parent.getElementsByTagNameNS('*', localName);
  if (out && out.length) return Array.from(out);
  out = parent.getElementsByTagName(localName);
  if (out && out.length) return Array.from(out);
  return [];
}
function firstEl(parent, localName) {
  const a = els(parent, localName);
  return a.length ? a[0] : null;
}
// Attributes can be prefixed too (e.g. r:id). Try plain, then any namespace.
function attr(el, name) {
  if (!el) return null;
  const v = el.getAttribute(name);
  if (v != null) return v;
  for (const a of Array.from(el.attributes || [])) {
    if (a.localName === name || a.name === name) return a.value;
  }
  return null;
}

export async function parseXlsx(arrayBuffer) {
  const zip = await unzip(arrayBuffer);
  const parser = new DOMParser();

  // --- shared strings ---
  const sstXml = await zip.read('xl/sharedStrings.xml');
  const sst = [];
  if (sstXml) {
    const doc = parser.parseFromString(sstXml, 'application/xml');
    for (const si of els(doc, 'si')) {
      // concatenate all text nodes, skipping ruby/phonetic annotations
      let txt = '';
      for (const t of els(si, 't')) {
        const pn = t.parentNode;
        if (pn && (pn.localName === 'rPh' || pn.nodeName === 'rPh')) continue;
        txt += t.textContent;
      }
      sst.push(txt);
    }
  }

  // --- number formats, so we can tell dates from plain numbers ---
  const styXml = await zip.read('xl/styles.xml');
  const cellIsDate = [];
  if (styXml) {
    const doc = parser.parseFromString(styXml, 'application/xml');
    const custom = {};
    for (const nf of els(doc, 'numFmt')) {
      custom[attr(nf, 'numFmtId')] = attr(nf, 'formatCode') || '';
    }
    // Built-in date format ids per ECMA-376
    const builtinDates = new Set(['14', '15', '16', '17', '18', '19', '20', '21', '22', '45', '46', '47']);
    const xfs = firstEl(doc, 'cellXfs');
    if (xfs) {
      let i = 0;
      for (const xf of els(xfs, 'xf')) {
        const id = attr(xf, 'numFmtId') || '0';
        cellIsDate[i] = builtinDates.has(id) || isDateFormat(custom[id]);
        i++;
      }
    }
  }

  // --- find the first worksheet via the workbook rels ---
  const wbXml = await zip.read('xl/workbook.xml');
  const relsXml = await zip.read('xl/_rels/workbook.xml.rels');
  let sheetPath = 'xl/worksheets/sheet1.xml';
  let sheetName = 'Sheet1';
  if (wbXml && relsXml) {
    const wbDoc = parser.parseFromString(wbXml, 'application/xml');
    const relDoc = parser.parseFromString(relsXml, 'application/xml');
    const first = els(wbDoc, 'sheet')[0];
    if (first) {
      sheetName = attr(first, 'name') || sheetName;
      const rid = attr(first, 'id'); // matches r:id or id, any prefix
      for (const rel of els(relDoc, 'Relationship')) {
        if (attr(rel, 'Id') === rid) {
          let t = attr(rel, 'Target') || '';
          if (t.startsWith('/')) t = t.slice(1);
          else if (!t.startsWith('xl/')) t = 'xl/' + t;
          sheetPath = t;
        }
      }
    }
  }

  const sheetXml = await zip.read(sheetPath);
  if (!sheetXml) throw new Error('Could not find a worksheet inside the file.');
  const sheet = parser.parseFromString(sheetXml, 'application/xml');

  // DOMParser reports XML syntax errors as a <parsererror> element rather than
  // throwing, so check explicitly instead of silently reading an empty doc.
  const perr = sheet.getElementsByTagName('parsererror')[0];
  if (perr) throw new Error('The worksheet XML could not be parsed: ' + (perr.textContent || '').trim().slice(0, 160));

  if (els(sheet, 'row').length === 0) {
    throw new Error('The worksheet contains no rows at all (empty sheetData). Check that the export actually produced data.');
  }

  // --- read cells into a grid, indexed by the row's REAL row number ---
  // Excel omits empty rows from the XML entirely, so honour each row's `r`
  // attribute rather than pushing sequentially. But not every writer emits `r`:
  // BC and other server-side generators often omit it on <row> and/or <c> and
  // rely purely on document order. Both must work, so fall back to positional
  // counting whenever `r` is missing.
  const grid = [];
  let seqRow = 0;
  for (const row of els(sheet, 'row')) {
    const rAttr = attr(row, 'r');
    const rowIdx = rAttr ? parseInt(rAttr, 10) - 1 : seqRow;
    seqRow = rowIdx + 1;

    const cells = [];
    let maxCi = -1;
    let seqCol = 0;
    for (const c of els(row, 'c')) {
      const ref = attr(c, 'r') || '';
      // colToIndex returns -1 for a missing/unparseable ref; fall back to the
      // cell's position in the row, which is what writers that omit `r` intend.
      const parsed = ref ? colToIndex(ref) : -1;
      const ci = parsed >= 0 ? parsed : seqCol;
      seqCol = ci + 1;

      const t = attr(c, 't');
      const s = attr(c, 's');
      const vEl = firstEl(c, 'v');
      const isEl = firstEl(c, 'is');
      let val = null;

      if (t === 'inlineStr' && isEl) {
        val = els(isEl, 't').map((x) => x.textContent).join('');
      } else if (vEl) {
        const raw = vEl.textContent;
        if (t === 's') {
          // Shared-string index. If sharedStrings.xml was missing or the index
          // is out of range, keep the raw value rather than yielding undefined,
          // which would make the whole row look empty.
          const idx = parseInt(raw, 10);
          const hit = Number.isFinite(idx) ? sst[idx] : undefined;
          val = (hit !== undefined && hit !== null) ? hit : raw;
        } else if (t === 'b') val = raw === '1';
        else if (t === 'str' || t === 'e') val = raw;
        else {
          const num = parseFloat(raw);
          const styleIsDate = s != null && cellIsDate[parseInt(s, 10)];
          val = styleIsDate ? (serialToISO(num) ?? num) : num;
        }
      }
      cells[ci] = val;
      if (ci > maxCi) maxCi = ci;
    }
    // Fill holes with null so the array is dense. Sparse arrays are a trap:
    // every/filter SKIP holes, so a row whose first cell is in column C would
    // look "empty" and be discarded.
    for (let k = 0; k <= maxCi; k++) if (cells[k] === undefined) cells[k] = null;

    grid[rowIdx] = cells;
  }
  for (let k = 0; k < grid.length; k++) if (grid[k] === undefined) grid[k] = [];

  // --- find the header row: first row with >=3 non-empty cells ---
  const nonEmptyCount = (arr) =>
    Array.from(arr || []).filter((v) => v !== null && v !== undefined && String(v).trim() !== '').length;

  let headerIdx = -1;
  for (let i = 0; i < Math.min(grid.length, 30); i++) {
    const cells = Array.from(grid[i] || []);
    const strCells = cells.filter((v) => typeof v === 'string' && v.trim() !== '').length;
    if (strCells >= 3) { headerIdx = i; break; }
  }
  // Fallback: some writers emit headers as numbers or typed values.
  if (headerIdx === -1) {
    for (let i = 0; i < Math.min(grid.length, 30); i++) {
      if (nonEmptyCount(grid[i]) >= 3) { headerIdx = i; break; }
    }
  }
  if (headerIdx === -1) {
    // Report what we actually saw, so the failure is diagnosable, not opaque.
    const sample = [];
    for (let i = 0; i < Math.min(grid.length, 5); i++) {
      const cells = Array.from(grid[i] || []);
      sample.push(`row ${i + 1}: ${cells.length} cells [${cells.slice(0, 6).map((v) => JSON.stringify(v)).join(', ')}]`);
    }
    throw new Error(
      `No header row found. The sheet parsed to ${grid.length} row(s) but none had 3+ filled cells. `
      + `First rows seen — ${sample.join(' · ') || '(none)'}`
    );
  }

  const rawHeaders = Array.from(grid[headerIdx] || []).map((h, i) =>
    (h !== null && h !== undefined && String(h).trim()) ? String(h).trim() : `Column ${i + 1}`
  );
  // de-duplicate repeated header names so keys don't collide
  const seen = {};
  const headers = rawHeaders.map((h) => {
    if (seen[h] == null) { seen[h] = 0; return h; }
    seen[h]++; return `${h} (${seen[h] + 1})`;
  });

  const rows = [];
  for (let i = headerIdx + 1; i < grid.length; i++) {
    const cells = Array.from(grid[i] || []);
    if (nonEmptyCount(cells) === 0) continue; // genuinely blank row
    const obj = {};
    headers.forEach((h, ci) => {
      const v = cells[ci];
      obj[h] = (v === null || v === undefined) ? '' : v;
    });
    rows.push(obj);
  }

  if (!rows.length) {
    throw new Error(
      `Found a header row at row ${headerIdx + 1} with ${headers.length} columns, but no data rows beneath it. `
      + `The sheet reports ${grid.length} rows total.`
    );
  }

  return { headers, rows, sheetName, headerRowNumber: headerIdx + 1 };
}

/* ============================================================================
   FIELD DETECTION
   ============================================================================ */

export const FIELDS = [
  { key: 'jobNo', label: 'Job No.', need: true, pats: [/^job\s*no/i, /job\s*number/i] },
  { key: 'taskNo', label: 'Job Task No.', need: false, pats: [/job\s*task\s*no/i, /task\s*no/i] },
  { key: 'desc', label: 'Description (keyword-matched)', need: true, pats: [/^description$/i, /^desc(ription)?\.?$/i] },
  { key: 'taskDesc', label: 'Job Task Description', need: false, pats: [/job\s*task\s*desc/i, /task\s*desc/i] },
  { key: 'value', label: 'Total value', need: false, pats: [/total\s*contract\s*value/i, /contract\s*value/i, /value.*lcy/i, /^value$/i] },
  { key: 'qty', label: 'Quantity', need: false, pats: [/^quantity$/i, /^qty$/i] },
  { key: 'target', label: 'Target completion', need: false, pats: [/target\s*completion/i, /planned\s*end/i] },
  { key: 'status', label: 'Operational status', need: false, pats: [/operational\s*status/i, /job\s*task\s*status/i, /posting\s*status/i] },
  { key: 'customer', label: 'Customer', need: false, pats: [/bill.?to\s*name/i, /end\s*customer\s*name/i, /customer/i] },
  { key: 'actualDone', label: 'Actual completion', need: false, pats: [/actual\s*completion/i] },
];

export function autoMap(headers) {
  const m = {};
  for (const f of FIELDS) {
    for (const p of f.pats) {
      const hit = headers.find((h) => p.test(h));
      if (hit && !Object.values(m).includes(hit)) { m[f.key] = hit; break; }
    }
    if (!m[f.key]) m[f.key] = '';
  }
  return m;
}

/* ============================================================================
   MATCHING SETTINGS
   ============================================================================ */

export const DEFAULT_INCLUDE = ['weld', 'welding', 'mig', 'tig', 'spray', 'hvof', 'plasma', 'arc spray', 'clad', 'cladding', 'coating', 'overlay'];
export const DEFAULT_EXCLUDE = [];
export const DEFAULT_COMBOS = [];

/* ----------------------------------------------------------------------------
   Operational statuses that genuinely mean "this job is finished".
   BC's Actual Completion Date is unreliable on its own (it turns up on jobs
   that have not started). But when it appears ALONGSIDE one of these statuses
   the two corroborate each other. Matched loosely (case-insensitive substring)
   so minor wording differences in BC still land.
   ---------------------------------------------------------------------------- */
const DONE_STATUSES = [
  'ready for dispatch',
  'ready for invoicing',
  'ready for invoice',
  'finance to invoice',
  'complete',
];

// Statuses that positively indicate work has NOT started. A completion date on
// one of these is a direct contradiction and always worth surfacing.
const UNSTARTED_STATUSES = ['on order', 'not started', 'planned', 'quote'];

function statusMatches(status, list) {
  const s = (status || '').trim().toLowerCase();
  if (!s) return false;
  return list.some((k) => s.includes(k));
}
function isDoneStatus(status) { return statusMatches(status, DONE_STATUSES); }
function isUnstartedStatus(status) { return statusMatches(status, UNSTARTED_STATUSES); }

/* ============================================================================
   ANALYSIS: match, dedupe, flag
   ============================================================================ */

function textOf(row, mapping, key) {
  const h = mapping[key];
  if (!h) return '';
  const v = row[h];
  return v == null ? '' : String(v);
}
function numOf(row, mapping, key) {
  const h = mapping[key];
  if (!h) return null;
  const v = row[h];
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const cleaned = v.replace(/[^0-9.\-]/g, '');
    if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
    const n = parseFloat(cleaned);
    return isFinite(n) ? n : null;
  }
  return null;
}
function dateOf(row, mapping, key) {
  const h = mapping[key];
  if (!h) return null;
  const v = row[h];
  if (v === null || v === undefined || v === '') return null;
  // BC writes an empty date as 0. serialToISO rejects that, but guard here too
  // in case the value arrived as a string "0" or a stray 0 date.
  if (typeof v === 'number') return serialToISO(v);
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '' || s === '0') return null;
    // Reject the Excel zero-date and anything before it — "empty", not real.
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s <= '1899-12-31' ? null : s;
    if (/^\d+(\.\d+)?$/.test(s)) return serialToISO(parseFloat(s));
  }
  return null;
}

function findHits(haystack, words) {
  const low = haystack.toLowerCase();
  return words.filter((w) => w && low.includes(w.toLowerCase()));
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Whole-word test, used by combination rules. Substring matching is too blunt
// here: a rule on "body" should not fire on "bodywork", because the whole point
// of a combination rule is precision about which words co-occur.
function hasWord(haystack, word) {
  if (!word) return false;
  const re = new RegExp('(^|[^a-z0-9])' + escapeRe(word.toLowerCase()) + '($|[^a-z0-9])', 'i');
  return re.test(haystack.toLowerCase());
}

function firedCombos(haystack, rules) {
  return rules.filter((rule) =>
    (rule.words || []).length >= 2 && rule.words.every((w) => hasWord(haystack, w))
  );
}

function completeness(row, mapping) {
  // Counts how many fields a row actually has, used to pick which duplicate to
  // keep. The Actual Completion Date column is excluded: it is unreliable (BC
  // populates it on unstarted jobs), so counting it would let a row win purely
  // because it carries a bogus date.
  const skip = mapping && mapping.actualDone ? mapping.actualDone : null;
  let n = 0;
  for (const k in row) {
    if (k === skip) continue;
    if (row[k] !== '' && row[k] != null) n++;
  }
  return n;
}

/**
 * Analyse parsed rows against the mapping and keyword settings.
 * Returns { records, defaultSelected } — `defaultSelected` is a Set of record
 * ids that should start ticked. Nothing is ever removed from `records`.
 */
export function analyse(rows, mapping, settings) {
  const includeKw = settings?.include || [];
  const excludeKw = settings?.exclude || [];
  const comboRules = settings?.combos || [];

  const recs = rows.map((row, i) => {
    const desc = textOf(row, mapping, 'desc');
    const taskDesc = textOf(row, mapping, 'taskDesc');
    // Keywords are matched against the Description column only. Job Task
    // Description in BC holds WIP/progress text (e.g. "WIP 50%"), not what the
    // work actually is, so it is carried through for reference but not searched.
    const hay = desc.trim();

    const incHits = findHits(hay, includeKw);
    const excHits = findHits(hay, excludeKw);
    const combos = firedCombos(hay, comboRules);
    // Precedence: a hard exclusion wins outright; then a fired combination rule
    // holds the row back for review (NOT auto-included, NOT discarded);
    // otherwise an include keyword matches it in.
    const matched = incHits.length > 0 && excHits.length === 0 && combos.length === 0;

    return {
      id: i,
      row,
      jobNo: textOf(row, mapping, 'jobNo').trim(),
      taskNo: textOf(row, mapping, 'taskNo'),
      taskDesc, desc, hay,
      customer: textOf(row, mapping, 'customer'),
      value: numOf(row, mapping, 'value'),
      qty: numOf(row, mapping, 'qty'),
      target: dateOf(row, mapping, 'target'),
      actualDone: dateOf(row, mapping, 'actualDone'),
      status: textOf(row, mapping, 'status'),
      incHits, excHits, combos, matched,
      // A job is treated as genuinely finished only when BOTH a completion date
      // and a corroborating "done" status are present. Either alone is not
      // sufficient: the date is unreliable, and a status can be set ahead of
      // the work actually finishing.
      doneConfirmed: false,
      isDupe: false, dupeOf: null,
      warnings: [],
      completeness: completeness(row, mapping),
    };
  });

  // --- resolve genuine completion (date corroborated by a "done" status) ---
  for (const r of recs) r.doneConfirmed = !!(r.actualDone && isDoneStatus(r.status));

  // --- duplicates on Job No. (keep the most complete row) ---
  const byJob = {};
  for (const r of recs) {
    if (!r.jobNo) continue;
    (byJob[r.jobNo] = byJob[r.jobNo] || []).push(r);
  }
  for (const jobNo in byJob) {
    const group = byJob[jobNo];
    if (group.length < 2) continue;
    // prefer a matched row, then the most complete
    const sorted = [...group].sort((a, b) =>
      (b.matched - a.matched) || (b.completeness - a.completeness) || (a.id - b.id));
    const keeper = sorted[0];
    for (const r of group) {
      if (r !== keeper) { r.isDupe = true; r.dupeOf = keeper.id; }
    }
  }

  // --- per-row warnings ---
  for (const r of recs) {
    if (!r.jobNo) r.warnings.push('No job number');
    if (r.matched && (r.value == null || r.value === 0)) r.warnings.push('No value');
    if (r.matched && !r.target) r.warnings.push('No target date');
    // BC's Actual Completion Date is not reliable on its own. How we treat it
    // depends on whether the operational status corroborates it:
    //   - a "done" status confirms it -> genuinely finished, no review needed;
    //   - an "unstarted" status contradicts it -> always flag;
    //   - anything else is ambiguous -> flag for a look.
    if (r.matched && r.actualDone && !r.doneConfirmed) {
      if (isUnstartedStatus(r.status)) {
        r.warnings.push(`Has completion date ${r.actualDone} but status is "${r.status}" — check`);
      } else {
        r.warnings.push(`BC completion date ${r.actualDone} — check if really done`);
      }
    }
    if (r.matched && r.qty != null && r.qty === 0) r.warnings.push('Qty 0');
  }

  // Default selection: matched, non-duplicate rows, minus jobs whose completion
  // is corroborated by BOTH a completion date AND a "done" status. A completion
  // date alone never deselects — it has proven unreliable, and silently
  // dropping a live job is far worse than including one that is finished.
  // Anything deselected here is still visible and tickable.
  const defaultSelected = new Set(
    recs.filter((r) => r.matched && !r.isDupe && !r.doneConfirmed).map((r) => r.id)
  );

  return { records: recs, defaultSelected };
}

/* ============================================================================
   EXPORT CONTRACT
   ----------------------------------------------------------------------------
   Produces the scheduler's job shape. Deliberate choices, unchanged from the
   standalone tool so a .json produced by it and a .xlsx read here land
   identically:
   - `hoursTotal: 0` / `process: ''` — BC WIP has no shop-floor hours; these
     come from a scheduler template or are set per job.
   - `departmentValue: 0` — BC's Total Contract Value is the whole-job value to
     the company, not this department's share. Guessing a split would corrupt
     the value report.
   - `status: 'active'`, `completedDate: null` — always. BC's completion date is
     recorded in notes as unverified, never mapped to completion.
   ============================================================================ */

function todayISO() { return new Date().toISOString().slice(0, 10); }
function addDaysISO(iso, n) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

export function buildSchedulerJobs(records, selectedIds) {
  return records.filter((r) => selectedIds.has(r.id)).map((r) => ({
    name: (r.desc || r.taskDesc || 'Untitled job').trim(),
    process: '',
    quantity: (r.qty != null && r.qty > 0) ? r.qty : 1,
    hoursTotal: 0,
    readyDate: todayISO(),
    dueDate: r.target || addDaysISO(todayISO(), 14),
    templateId: null,
    notes: [
      r.customer ? `Customer: ${r.customer}` : '',
      r.status ? `BC status: ${r.status}` : '',
      r.taskDesc ? `BC task: ${r.taskDesc}` : '',
      // Recorded for traceability only. NOT mapped to completedDate, because
      // BC populates it on jobs that have not started.
      r.actualDone ? `BC actual completion date: ${r.actualDone} (unverified)` : '',
    ].filter(Boolean).join(' · '),
    totalValue: r.value || 0,
    departmentValue: 0,
    percentComplete: 0,
    status: 'active',
    completedDate: null,
    bcJobNo: r.jobNo || '',
    bcJobTaskNo: r.taskNo || '',
    // Imported work is unassigned — the scheduler picks the person. The user
    // can override it per job afterwards (job.staffId).
    staffId: null,
    updatedAt: new Date().toISOString(),
    assignment: null,
  }));
}
