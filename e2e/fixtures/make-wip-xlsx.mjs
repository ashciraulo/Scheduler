/* ============================================================================
   Throwaway BC-style WIP export for the import suites.
   ----------------------------------------------------------------------------
   Real WIP exports are commercially sensitive and must never be committed
   (`*.xlsx` is gitignored), so the fixture is generated instead.

   It deliberately reproduces the quirks the parser exists to handle, because
   each of them fixed a real bug against real BC output:
     - namespace-prefixed tags (<x:row>, <x:c>)
     - no r= attributes on rows or cells
     - an empty date written as the serial 0
     - a repeated Job No. (duplicate detection)
     - a completion date on a row whose status says it hasn't started
     - rows that match no keyword at all, which are what the parked list keeps
     - a matched row with quantity 0 — legitimate in BC for a quantity-less
       department job, and used to trigger a "Qty 0" warning on nearly every
       real row before that was removed as noise (#8)

   An .xlsx is a ZIP of XML. Entries are written STORED (no compression), which
   is valid and what wipImport.js's unzip() reads as method 0 — so this needs no
   zip library and no Python.
   ============================================================================ */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const HEADERS = ['Job No.', 'Job Task No.', 'Description', 'Job Task Description',
  'Bill-to Name', 'Quantity', 'Line Amount', 'Target Date',
  'Actual Completion Date', 'Status'];

const ROWS = [
  ['J001', '1000', 'Weld bracket assembly', 'WIP 20%', 'Acme', '10', '4800', '45900', '0', 'In Progress'],
  ['J002', '1000', 'HVOF coat hydraulic shaft', 'WIP 0%', 'Borg', '6', '7680', '45905', '0', 'Planned'],
  ['J003', '1000', 'Body elbow spray', '', 'Cyclo', '4', '3200', '45910', '0', 'Planned'],
  ['J004', '1000', 'Machining only - no weld', '', 'Delta', '2', '1500', '45912', '0', 'Planned'],
  ['J005', '1000', 'Elbow weld repair', '', 'Echo', '0', '2100', '45915', '0', 'Planned'],
  ['J001', '1000', 'Weld bracket assembly', 'WIP 20%', 'Acme', '10', '4800', '45900', '0', 'In Progress'],
  ['J006', '1000', 'Spray body section', '', 'Foxtrot', '5', '5000', '45920', '45880', 'Not Started'],
  // genuinely no keyword match — these are what should end up parked
  ['J007', '1000', 'Turned shaft - lathe only', '', 'Golf', '8', '2400', '45925', '0', 'Planned'],
  ['J008', '1000', 'Assembly and paint', '', 'Hotel', '1', '900', '45930', '0', 'Planned'],
];

const xmlEscape = (v) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const cell = (v) => (/^-?\d+(\.\d+)?$/.test(v)
  ? `<x:c><x:v>${v}</x:v></x:c>`
  : `<x:c t="inlineStr"><x:is><x:t>${xmlEscape(v)}</x:t></x:is></x:c>`);

const rowsXml = [HEADERS, ...ROWS]
  .map((r) => `<x:row>${r.map(cell).join('')}</x:row>`)
  .join('');

const SHEET = '<?xml version="1.0" encoding="UTF-8"?>'
  + '<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  + `<x:sheetData>${rowsXml}</x:sheetData></x:worksheet>`;

const WORKBOOK = '<?xml version="1.0" encoding="UTF-8"?>'
  + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
  + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
  + '<sheets><sheet name="WIP" sheetId="1" r:id="rId1"/></sheets></workbook>';

const WB_RELS = '<?xml version="1.0" encoding="UTF-8"?>'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
  + 'relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>';

const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8"?>'
  + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="xml" ContentType="application/xml"/>'
  + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-'
  + 'officedocument.spreadsheetml.sheet.main+xml"/>'
  + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-'
  + 'officedocument.spreadsheetml.worksheet+xml"/></Types>';

const ROOT_RELS = '<?xml version="1.0" encoding="UTF-8"?>'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
  + 'relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';

/* ---- minimal STORED-only ZIP writer ---- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function zip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const [name, text] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(text, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // local file header signature
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0, 6);            // flags
    local.writeUInt16LE(0, 8);            // method 0 = stored
    local.writeUInt16LE(0, 10);           // mod time
    local.writeUInt16LE(0, 12);           // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);           // extra length
    chunks.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);      // central directory signature
    cd.writeUInt16LE(20, 4);              // version made by
    cd.writeUInt16LE(20, 6);              // version needed
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);              // extra
    cd.writeUInt16LE(0, 32);              // comment
    cd.writeUInt16LE(0, 34);              // disk number
    cd.writeUInt16LE(0, 36);              // internal attrs
    cd.writeUInt32LE(0, 38);              // external attrs
    cd.writeUInt32LE(offset, 42);         // local header offset
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, cdBuf, eocd]);
}

export function makeWipXlsx(outPath = join(HERE, 'wip.xlsx')) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, zip([
    ['[Content_Types].xml', CONTENT_TYPES],
    ['_rels/.rels', ROOT_RELS],
    ['xl/workbook.xml', WORKBOOK],
    ['xl/_rels/workbook.xml.rels', WB_RELS],
    ['xl/worksheets/sheet1.xml', SHEET],
  ]));
  return outPath;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(makeWipXlsx());
}
