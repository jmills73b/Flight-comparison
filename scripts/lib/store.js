import { gzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './config.js';

const SNAPSHOT_DIR = join(ROOT, 'data', 'snapshots');
const HISTORY = join(ROOT, 'data', 'history.csv');
const DEBUG_DIR = join(ROOT, 'data', 'debug');

export const HISTORY_COLUMNS = [
  'collected_at',
  'search_id',
  // What was actually searched, e.g. "2027-08-19|MCO>LON". The short id can be
  // reused for a different search if the trip dates change; this cannot, so
  // series are grouped on it rather than on the id.
  'signature',
  'provider',
  'kind',
  'status',
  'out_date',
  'back_date',
  'from_airport',
  'to_airport',
  'carrier',
  'fare_brand',
  'fare',
  'bag_cost',
  'true_total',
  'stops',
  'dep_local',
  'arr_local',
  'duration_min',
  'bags_included_pp',
  'deep_link',
];

export function runStamp(date = new Date()) {
  const iso = date.toISOString();
  return `${iso.slice(0, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}`;
}

export function writeSnapshot(stamp, payload) {
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const file = join(SNAPSHOT_DIR, `${stamp}.json.gz`);
  writeFileSync(file, gzipSync(Buffer.from(JSON.stringify(payload, null, 2))));
  return file;
}

/**
 * Raw HTML is only kept when parsing failed. Keeping it for every successful
 * run would dominate the repository size for no benefit, but on a failure it
 * is the only way to work out what changed.
 */
export function writeDebugHtml(stamp, searchId, html) {
  mkdirSync(DEBUG_DIR, { recursive: true });
  const file = join(DEBUG_DIR, `${stamp}-${searchId}.html.gz`);
  writeFileSync(file, gzipSync(Buffer.from(html)));
  return file;
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function appendHistory(rows) {
  if (rows.length === 0) return 0;
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  const lines = [];
  if (!existsSync(HISTORY)) lines.push(HISTORY_COLUMNS.join(','));
  for (const row of rows) {
    lines.push(HISTORY_COLUMNS.map((c) => csvCell(row[c])).join(','));
  }
  appendFileSync(HISTORY, lines.join('\n') + '\n');
  return rows.length;
}

export function readHistory() {
  if (!existsSync(HISTORY)) return [];
  const text = readFileSync(HISTORY, 'utf8').trim();
  if (!text) return [];
  const [header, ...body] = text.split('\n');
  const cols = parseCsvLine(header);
  return body.filter(Boolean).map((line) => {
    const cells = parseCsvLine(line);
    return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? '']));
  });
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
