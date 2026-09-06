import { chromium } from 'playwright';
import { loadConfig, legsFor } from './lib/config.js';
import { plannedSearches } from './lib/urls.js';
import { trueTotal, composeSplitTicket, round2 } from './lib/pricing.js';
import {
  runStamp,
  writeSnapshot,
  writeDebugHtml,
  appendHistory,
} from './lib/store.js';
import { search as googleFlights, PROVIDER } from './providers/google-flights.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

const cfg = loadConfig();
const only = value('--only');
let searches = plannedSearches(cfg);
if (only) searches = searches.filter((s) => s.id === only);

if (flag('--urls')) {
  console.log(`\n${searches.length} searches for ${cfg.trip.name}`);
  console.log(
    `${cfg.trip.adults} adults + ${cfg.trip.children.length} child, ` +
      `${cfg.trip.checked_bags} hold bags, ${cfg.trip.cabin}\n`
  );
  for (const s of searches) {
    console.log(`${s.id.padEnd(4)} ${s.kind.padEnd(11)} ${s.label}`);
    console.log(`     ${s.url}\n`);
  }
  console.log('Paste any of these into a browser to confirm the search is right.\n');
  process.exit(0);
}

const stamp = runStamp();
const collectedAt = new Date().toISOString();
console.log(`Run ${stamp} — ${searches.length} searches`);

// CI installs the browser build that matches the pinned Playwright version, so
// no path is needed there. CHROMIUM_PATH lets a machine with a pre-installed
// Chromium of a different build run the collector without re-downloading.
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

const results = [];
const historyRows = [];

for (const s of searches) {
  const page = await context.newPage();
  const outcome = await googleFlights(page, {
    url: s.url,
    trip: cfg.trip,
    passengers: cfg.passengers,
  });

  const directions = s.kind === 'round_trip' ? 2 : 1;
  const priced = outcome.offers
    .map((o) => ({
      ...o,
      ...trueTotal({
        fare: o.fare,
        carrier: o.carrier,
        fareBrand: o.fareBrand,
        fees: cfg.fees,
        trip: cfg.trip,
        passengers: cfg.passengers,
        directions,
      }),
    }))
    .sort((a, b) => a.trueTotal - b.trueTotal)
    .slice(0, 5); // top 5 keeps history.csv small over 11 months

  results.push({ ...s, status: outcome.status, reason: outcome.reason ?? null, offers: priced });

  const icon = outcome.status === 'ok' ? '✓' : '·';
  const detail =
    outcome.status === 'ok'
      ? `${priced.length} offers, best £${priced[0]?.trueTotal ?? '—'}`
      : `${outcome.status}${outcome.reason ? ` — ${outcome.reason}` : ''}`;
  console.log(`  ${icon} ${s.id.padEnd(4)} ${s.label.padEnd(14)} ${detail}`);

  if (outcome.html) writeDebugHtml(stamp, s.id, outcome.html);

  if (priced.length === 0) {
    historyRows.push({
      collected_at: collectedAt,
      search_id: s.id,
      signature: s.signature,
      kind: s.kind,
      status: outcome.status,
      out_date: s.out ?? s.date ?? '',
      back_date: s.back ?? '',
    });
  } else {
    for (const o of priced) {
      historyRows.push({
        collected_at: collectedAt,
        search_id: s.id,
        signature: s.signature,
        kind: s.kind,
        status: 'ok',
        out_date: s.out ?? s.date ?? '',
        back_date: s.back ?? '',
        carrier: o.carrier ?? '',
        fare_brand: o.fareBrand ?? '',
        fare: o.fare,
        bag_cost: o.bagCost,
        true_total: o.trueTotal,
        stops: o.stops ?? '',
        dep_local: o.depLocal ?? '',
        arr_local: o.arrLocal ?? '',
        duration_min: o.durationMin ?? '',
        bags_included_pp: o.bagsIncludedPerPassenger,
        deep_link: o.deepLink ?? '',
      });
    }
  }

  await page.close();
  await sleep(3000 + Math.random() * 4000); // stay unhurried and unremarkable
}

await browser.close();

// Every itinerary gets a split-ticket price by composing its two legs, which
// is why the eight open jaws need no search of their own.
const best = (id) => {
  const r = results.find((x) => x.id === id);
  return r?.offers?.[0] ?? null;
};

const itineraries = cfg.itineraries.map((it) => {
  const { out, back } = legsFor(it, cfg.legs);
  const split = composeSplitTicket(best(out.id), best(back.id));
  const single = it.isRoundTrip ? best(it.id) : null;
  const options = [
    single && { mode: 'single_ticket', ...single },
    split && { mode: 'two_one_ways', ...split },
  ].filter(Boolean);
  const cheapest = options.length
    ? options.reduce((a, b) => (a.trueTotal <= b.trueTotal ? a : b))
    : null;

  return {
    id: it.id,
    shape: it.shape,
    nights: it.nights,
    out: it.out,
    back: it.back,
    route: `${it.origin} → ${it.into}${it.into === it.home_from ? '' : ` · ${it.home_from}`} → ${it.origin}`,
    isRoundTrip: it.isRoundTrip,
    singleTicket: single ? round2(single.trueTotal) : null,
    splitTicket: split ? round2(split.trueTotal) : null,
    cheapest: cheapest ? round2(cheapest.trueTotal) : null,
    cheapestMode: cheapest?.mode ?? null,
    legs: [out.id, back.id],
  };
});

const okCount = results.filter((r) => r.status === 'ok').length;
const snapshot = {
  collected_at: collectedAt,
  provider: PROVIDER,
  trip: cfg.trip,
  passengers: cfg.passengers,
  summary: { searches: results.length, ok: okCount, failed: results.length - okCount },
  searches: results,
  itineraries,
};

const snapFile = writeSnapshot(stamp, snapshot);
const written = appendHistory(historyRows);

console.log(`\n${okCount}/${results.length} searches returned offers`);
console.log(`Snapshot  ${snapFile.replace(process.cwd() + '/', '')}`);
console.log(`History   +${written} rows`);

const priced = itineraries.filter((i) => i.cheapest !== null);
if (priced.length) {
  const top = [...priced].sort((a, b) => a.cheapest - b.cheapest).slice(0, 3);
  console.log('\nCheapest so far:');
  for (const t of top) {
    console.log(`  ${t.id}  £${t.cheapest}  ${t.route}  (${t.cheapestMode})`);
  }
} else {
  console.log('\nNo itinerary priced yet — expected while fares are not on sale.');
}

// A run where nothing at all worked is a broken scraper, not an empty market:
// fail the job so it is visible rather than quietly committing nothing.
if (okCount === 0 && results.length > 0) {
  console.error('\nNo search returned any offer. Treating this run as a failure.');
  process.exit(1);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
