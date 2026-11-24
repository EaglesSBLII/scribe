// Builds src/colleges/us-colleges.json from the federal IPEDS directory file
// ("Institutional Characteristics, Directory information", HDyyyy.csv, public domain).
// Run with: node scripts/make-us-colleges.mjs /path/to/HD2023.csv
// It keeps only the name, city, state and official website of each school.
// It never writes essay prompts or anything about what a school wants.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** The 50 states and DC. Territories and outlying areas are left out. */
export const STATES = new Set(
  ('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY').split(' '),
);

/** IPEDS SECTOR codes, for the printed breakdown only. */
export const SECTOR_NAMES = {
  1: 'Public, 4-year or above',
  2: 'Private not-for-profit, 4-year or above',
  3: 'Private for-profit, 4-year or above',
};

/** The file is UTF-8 when it starts with a byte-order mark or decodes cleanly; otherwise Windows-1252. */
export function decodeCsv(bytes) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** Plain CSV: quoted fields may hold commas, line breaks and doubled quotes. Returns one object per data row. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim().toUpperCase());
  return rows.slice(1).map((cells) => Object.fromEntries(header.map((h, i) => [h, (cells[i] ?? '').trim()])));
}

/**
 * A school's website as https://host/path, or '' when the directory has none
 * or the value is not a usable web address.
 */
export function normaliseWebsite(raw) {
  // The part after # is never needed, and in the directory it sometimes holds spaces.
  let s = String(raw ?? '').replace(/#.*$/s, '').trim();
  if (!s || /\s/.test(s)) return '';
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\/+/i, '').replace(/^\/+/, '');
  if (!s) return '';
  let url;
  try {
    url = new URL(`https://${s}`);
  } catch {
    return '';
  }
  if (url.username || url.password || url.port) return '';
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(url.hostname)) return '';
  url.hash = '';
  return url.href;
}

/** Four-year, degree-granting, active schools that offer undergraduate degrees, in a state or DC. */
export function keep(r) {
  return r.ICLEVEL === '1' && r.CYACTIVE === '1' && r.DEGGRANT === '1' && r.UGOFFER === '1' && r.INSTCAT === '2' && STATES.has(r.STABBR);
}

const tidy = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const sortKey = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Turns directory records into the checked-in list: [unitid, name, city, state, website], sorted by name. */
export function buildList(records) {
  const need = ['UNITID', 'INSTNM', 'CITY', 'STABBR', 'WEBADDR', 'SECTOR', 'ICLEVEL', 'CYACTIVE', 'DEGGRANT', 'UGOFFER', 'INSTCAT'];
  const missing = records.length ? need.filter((k) => !(k in records[0])) : [];
  if (missing.length) throw new Error(`The file is missing these columns: ${missing.join(', ')}`);
  const sectors = {};
  const seen = new Set();
  const rows = [];
  for (const r of records) {
    if (!keep(r)) continue;
    const unitid = Number(r.UNITID);
    const name = tidy(r.INSTNM);
    if (!Number.isInteger(unitid) || unitid <= 0 || !name || seen.has(unitid)) continue;
    seen.add(unitid);
    sectors[r.SECTOR] = (sectors[r.SECTOR] ?? 0) + 1;
    rows.push([unitid, name, tidy(r.CITY), r.STABBR, normaliseWebsite(r.WEBADDR)]);
  }
  rows.sort((a, b) => {
    const x = sortKey(a[1]);
    const y = sortKey(b[1]);
    return x < y ? -1 : x > y ? 1 : a[0] - b[0];
  });
  return { rows, sectors };
}

function main(argv) {
  const csv = argv[0];
  if (!csv) throw new Error('Usage: node scripts/make-us-colleges.mjs /path/to/HD2023.csv [YYYY-MM-DD]');
  const file = path.basename(csv);
  const year = Number(/(\d{4})/.exec(file)?.[1]);
  if (!year) throw new Error(`Cannot read the IPEDS year from the file name "${file}".`);
  const generatedOn = argv[1] ?? new Date().toISOString().slice(0, 10);
  const { rows, sectors } = buildList(parseCsv(decodeCsv(fs.readFileSync(csv))));
  const out = path.resolve(import.meta.dirname, '../src/colleges/us-colleges.json');
  const head = {
    source: `IPEDS Institutional Characteristics, Directory information (${file}), National Center for Education Statistics. Public domain.`,
    sourceFile: file,
    ipedsYear: year,
    generatedOn,
    columns: ['unitid', 'name', 'city', 'state', 'website'],
    count: rows.length,
  };
  // One school per line, so a yearly refresh is easy to review.
  const json = `${JSON.stringify(head).slice(0, -1)},"rows":[\n${rows.map((r) => JSON.stringify(r)).join(',\n')}\n]}\n`;
  fs.writeFileSync(out, json);
  console.log(`Wrote ${rows.length} colleges to ${path.relative(process.cwd(), out)} (${Buffer.byteLength(json)} bytes)`);
  for (const [code, n] of Object.entries(sectors).sort()) console.log(`  sector ${code} (${SECTOR_NAMES[code] ?? 'other'}): ${n}`);
  console.log(`  without a website: ${rows.filter((r) => !r[4]).length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
