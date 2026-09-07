/**
 * Airline diagnostic — run by hand, writes no price history.
 *
 * The collector runs against the real trip dates, which is the right thing for
 * tracking and the wrong thing for debugging: most of those dates are not on
 * sale yet, so a failure tells you nothing about whether the adapter works.
 *
 * This runs the same adapters against dates that are KNOWN bookable — taken
 * from searches actually performed in a browser — so a failure here is always
 * the adapter's fault and never the market's. It reports what came back, and
 * on any failure saves the page so the parser can be fixed from evidence.
 *
 *   node scripts/probe-airlines.js            # all four
 *   node scripts/probe-airlines.js --only ba-return
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { ROOT, loadConfig } from './lib/config.js';
import {
  searchBA, searchVirgin, baUrl, virginUrl,
  PROVIDER_BA, PROVIDER_VS,
} from './providers/airline-direct.js';

const cfg = loadConfig();
const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;

/**
 * Dates proven bookable in a browser, per airline. BA sells further ahead than
 * Virgin — a real BA search reached 27 Aug 2027 while Virgin's own test search
 * had to fall back to July — so they get different dates rather than one set
 * that half of them cannot answer.
 */
const CASES = [
  {
    id: 'ba-return',
    label: 'BA · return · LON ⇄ MCO',
    provider: PROVIDER_BA,
    run: searchBA,
    url: () => baUrl(cfg.trip, cfg.party, {
      from: 'LON', to: 'MCO', out: '2027-08-11', back: '2027-08-26',
    }),
  },
  {
    id: 'ba-openjaw',
    label: 'BA · open jaw · LON → MCO, MIA → LON',
    provider: PROVIDER_BA,
    run: searchBA,
    url: () => baUrl(cfg.trip, cfg.party, {
      slices: [
        { from: 'LON', to: 'MCO', date: '2027-08-11' },
        { from: 'MIA', to: 'LON', date: '2027-08-27' },
      ],
    }),
  },
  {
    id: 'vs-return',
    label: 'VS · return · LON ⇄ TPA (July — Virgin sells less far ahead)',
    provider: PROVIDER_VS,
    run: searchVirgin,
    url: () => virginUrl(cfg.trip, cfg.party, {
      from: 'LON', to: 'TPA', out: '2027-07-22', back: '2027-07-29',
    }),
  },
  {
    id: 'vs-openjaw',
    label: 'VS · open jaw · LON → TPA, MIA → LON',
    provider: PROVIDER_VS,
    run: searchVirgin,
    url: () => virginUrl(cfg.trip, cfg.party, {
      slices: [
        { from: 'LON', to: 'TPA', date: '2027-07-22' },
        { from: 'MIA', to: 'LON', date: '2027-08-01' },
      ],
    }),
  },
];

const cases = only ? CASES.filter((c) => c.id === only) : CASES;
const outDir = join(ROOT, 'data', 'probe');
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--disable-blink-features=AutomationControlled'],
});
const context = await browser.newContext({
  locale: cfg.trip.locale,
  timezoneId: 'Europe/London',
  viewport: { width: 1440, height: 1000 },
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
});

console.log(
  `Airline probe — ${cfg.party.total} passengers ` +
    `(BA ${cfg.party.ba.adults}a/${cfg.party.ba.youngAdults}ya/${cfg.party.ba.children}c, ` +
    `VS a${cfg.party.virgin.adults}t${cfg.party.virgin.teens}c${cfg.party.virgin.children}), ` +
    `direct only\n`
);

const summary = [];

for (const c of cases) {
  const url = c.url();
  console.log(`── ${c.label}`);
  console.log(`   ${url}`);

  const page = await context.newPage();
  const r = await c.run(page, {
    url,
    trip: cfg.trip,
    passengers: cfg.passengers,
    timeoutMs: 45000,
  });

  console.log(`   status   ${r.status}${r.reason ? ` — ${r.reason}` : ''}`);
  console.log(`   offers   ${r.offers.length}`);
  for (const o of r.offers.slice(0, 6)) {
    console.log(
      `     ${(o.depAirport ?? '???')}→${(o.arrAirport ?? '???')} ` +
        `${o.depLocal ?? '--:--'}–${o.arrLocal ?? '--:--'} ` +
        `${String(o.durationMin ?? '?').padStart(4)}min ${o.stops ?? '?'} stop ` +
        `£${o.perPassengerFare ?? o.perPersonFare ?? '?'}/pax → £${o.fare} party ` +
        `[${o.fareBrand ?? 'brand unknown'}]`
    );
  }
  if (r.ribbon?.length) {
    console.log(
      `   ribbon   ` +
        r.ribbon.map((x) => `£${x.perPassengerFare} ${x.day} ${x.month}`).join('  ')
    );
  }

  // Always keep the page for a probe — learning the structure is the point,
  // and a success is as informative as a failure when writing a parser.
  let html = r.html;
  if (!html) html = await page.content().catch(() => null);
  if (html) {
    const f = join(outDir, `${c.id}.html.gz`);
    writeFileSync(f, gzipSync(Buffer.from(html)));
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    console.log(`   page     ${(html.length / 1024).toFixed(0)} KB · title "${(html.match(/<title>([^<]*)</) ?? [, '?'])[1]}"`);
    console.log(`   prices   ${(text.match(/£\s?[\d,]{2,}/g) ?? []).slice(0, 10).join(' ') || 'none found'}`);
    if (r.status !== 'ok') console.log(`   says     ${text.slice(0, 220)}`);
    console.log(`   saved    data/probe/${c.id}.html.gz`);
  }
  console.log();

  summary.push({ id: c.id, status: r.status, offers: r.offers.length });
  await page.close();
  await new Promise((res) => setTimeout(res, 4000 + Math.random() * 3000));
}

await browser.close();

console.log('Summary');
for (const s of summary) {
  console.log(`  ${s.id.padEnd(12)} ${s.status.padEnd(28)} ${s.offers} offers`);
}
const working = summary.filter((s) => s.status === 'ok').length;
console.log(`\n${working}/${summary.length} adapters returned offers on known-bookable dates.`);
console.log('Pages saved under data/probe/ for parser work.');
