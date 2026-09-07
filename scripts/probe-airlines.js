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
 * It also sweeps BROWSER PROFILES. Three of the four adapters load the right
 * page and never see a price, which points at the browser being recognised
 * rather than at the parser — so the probe runs each case under each profile
 * and prints a case-by-profile matrix. That turns "try stealth and hope" into
 * a measurement: either a profile changes the answer or it does not.
 *
 *   node scripts/probe-airlines.js                         # all cases, all profiles
 *   node scripts/probe-airlines.js --only ba-return
 *   node scripts/probe-airlines.js --profiles stealth-headed
 */
import { launchBrowser, describeLaunch, PROFILES } from './lib/browser.js';
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

const profileArg = args.includes('--profiles') ? args[args.indexOf('--profiles') + 1] : null;
const profiles = profileArg ? profileArg.split(',').map((p) => p.trim()) : PROFILES;
for (const p of profiles) {
  if (!PROFILES.includes(p)) {
    console.error(`Unknown profile "${p}". Known: ${PROFILES.join(', ')}`);
    process.exit(2);
  }
}

const outDir = join(ROOT, 'data', 'probe');
mkdirSync(outDir, { recursive: true });

console.log(
  `Airline probe — ${cfg.party.total} passengers ` +
    `(BA ${cfg.party.ba.adults}a/${cfg.party.ba.youngAdults}ya/${cfg.party.ba.children}c, ` +
    `VS a${cfg.party.virgin.adults}t${cfg.party.virgin.teens}c${cfg.party.virgin.children}), ` +
    `direct only`
);
console.log(`Profiles: ${profiles.join(', ')} × ${cases.length} cases\n`);

const results = [];

for (const profileName of profiles) {
  const launched = await launchBrowser({ profile: profileName, locale: cfg.trip.locale });
  const { browser, context } = launched;
  console.log(`══ ${describeLaunch(launched)}\n`);

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
    // and a success is as informative as a failure when writing a parser. The
    // profile is in the filename so two profiles never overwrite each other's
    // evidence, which is the whole basis of the comparison.
    let html = r.html;
    if (!html) html = await page.content().catch(() => null);
    let prices = 0;
    if (html) {
      const f = join(outDir, `${c.id}.${launched.profile}.html.gz`);
      writeFileSync(f, gzipSync(Buffer.from(html)));
      const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const found = text.match(/£\s?[\d,]{2,}/g) ?? [];
      prices = found.length;
      console.log(`   page     ${(html.length / 1024).toFixed(0)} KB · title "${(html.match(/<title>([^<]*)</) ?? [, '?'])[1]}"`);
      console.log(`   prices   ${found.slice(0, 10).join(' ') || 'none found'}`);
      if (r.status !== 'ok') console.log(`   says     ${text.slice(0, 220)}`);
      console.log(`   saved    data/probe/${c.id}.${launched.profile}.html.gz`);
    }
    console.log();

    results.push({
      profile: launched.profile,
      id: c.id,
      status: r.status,
      offers: r.offers.length,
      prices,
    });
    await page.close();
    await new Promise((res) => setTimeout(res, 4000 + Math.random() * 3000));
  }

  await browser.close();
}

// The matrix is the point of the sweep: reading down a column says whether a
// profile helped, reading across a row says whether a case is hopeless
// everywhere. `prices` counts pound figures anywhere on the page — an adapter
// can score 0 offers while the page clearly has prices, which is a parser bug
// and not a blocking one, and the two must not be confused.
const ranProfiles = [...new Set(results.map((r) => r.profile))];
const width = Math.max(...cases.map((c) => c.id.length), 4);

console.log('Matrix — offers (prices seen on page)\n');
console.log(`  ${'case'.padEnd(width)}  ${ranProfiles.map((p) => p.padEnd(16)).join('')}`);
for (const c of cases) {
  const cells = ranProfiles.map((p) => {
    const r = results.find((x) => x.profile === p && x.id === c.id);
    return (r ? `${r.offers} (${r.prices})` : '—').padEnd(16);
  });
  console.log(`  ${c.id.padEnd(width)}  ${cells.join('')}`);
}

console.log('\nDetail');
for (const r of results) {
  console.log(
    `  ${r.profile.padEnd(15)} ${r.id.padEnd(width)} ${r.status.padEnd(28)} ${r.offers} offers`
  );
}

for (const p of ranProfiles) {
  const working = results.filter((r) => r.profile === p && r.status === 'ok').length;
  const total = results.filter((r) => r.profile === p).length;
  console.log(`\n${p}: ${working}/${total} adapters returned offers on known-bookable dates.`);
}

console.log('Pages saved under data/probe/ for parser work.');
