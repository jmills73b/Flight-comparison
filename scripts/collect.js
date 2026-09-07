import { chromium } from 'playwright';
import { loadConfig, legsFor } from './lib/config.js';
import { plannedSearches } from './lib/urls.js';
import { trueTotal, composeSplitTicket, round2 } from './lib/pricing.js';
import {
  runStamp,
  writeSnapshot,
  writeDebugHtml,
  appendHistory,
  pruneDebug,
} from './lib/store.js';
import { search as googleFlights, PROVIDER } from './providers/google-flights.js';
import { search as skyscanner, PROVIDER as SKYSCANNER } from './providers/skyscanner.js';
import {
  searchBA, searchVirgin, baUrl, virginUrl,
  PROVIDER_BA, PROVIDER_VS,
} from './providers/airline-direct.js';

// Every source, in preference order. Direct airline sites rank above
// aggregators: they are authoritative for their own fares and baggage rules.
// The order only decides which offer is shown; all outcomes are recorded.
export const SOURCE_LABELS = {
  [PROVIDER_BA]: 'British Airways (direct)',
  [PROVIDER_VS]: 'Virgin Atlantic (direct)',
  [PROVIDER]: 'Google Flights',
  [SKYSCANNER]: 'Skyscanner',
};

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
    `${cfg.party.total} passengers (BA: ${cfg.party.ba.adults}a/${cfg.party.ba.youngAdults}ya/` +
      `${cfg.party.ba.children}c · others: ${cfg.party.standard.adults}a/` +
      `${cfg.party.standard.childAges.length}c), ` +
      `${cfg.trip.checked_bags} hold bags, ${cfg.trip.cabin}\n`
  );
  for (const s of searches) {
    console.log(`${s.id.padEnd(4)} ${s.kind.padEnd(11)} ${s.label}`);
    console.log(`     ${s.url}\n`);
  }
  console.log('Paste any of these into a browser to confirm the search is right.\n');
  process.exit(0);
}

/**
 * A search for August 2027 returning nothing is ambiguous: the scraper may be
 * broken, or the fares may simply not be loaded yet. Both look identical — an
 * empty grid with no "no flights" message. This probes a date that is
 * definitely on sale, so the two can be told apart. It writes no history.
 */
if (flag('--probe')) {
  const soon = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
  const { oneWayUrl } = await import('./lib/urls.js');
  const { skyscannerOneWayUrl } = await import('./lib/urls.js');
  const url = oneWayUrl(cfg.trip, { from: 'LON', to: 'MCO', date: soon });
  console.log(`Probe: LON → MCO on ${soon} (60 days out, certainly on sale)`);
  console.log(url + '\n');

  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = await browser.newPage({ locale: cfg.trip.locale });
  const out = await googleFlights(page, {
    url,
    trip: cfg.trip,
    passengers: cfg.passengers,
    directions: 1,
  });

  console.log(`status        ${out.status}`);
  if (out.reason) console.log(`reason        ${out.reason}`);
  console.log(`offers        ${out.offers.length}`);
  for (const o of out.offers.slice(0, 5)) {
    console.log(`  £${o.fare}  ${o.carrier ?? '—'}  ${o.stops ?? '—'} stops  ${o.durationMin ?? '—'}min`);
  }
  if (out.offers[0]) {
    console.log(`\nrow text      ${out.offers[0].rawText}`);
  }

  // Is a quoted price the whole party or one seat? Google shows each in
  // different contexts, and getting it wrong is a four-fold error in every
  // number this tool produces. Run the identical search as a single adult and
  // compare: roughly 4x means the figures above are party totals.
  if (out.status === 'ok' && cfg.passengers > 1) {
    const soloTrip = { ...cfg.trip, adults: 1, children_ages: [] };
    const soloPage = await browser.newPage({ locale: cfg.trip.locale });
    const solo = await googleFlights(soloPage, {
      url: oneWayUrl(soloTrip, { from: 'LON', to: 'MCO', date: soon }),
      trip: soloTrip,
      passengers: 1,
      directions: 1,
    });
    const cheapest = (r) => (r.offers.length ? Math.min(...r.offers.map((o) => o.fare)) : null);
    const party = cheapest(out);
    const one = cheapest(solo);
    console.log(`\ncheapest, ${cfg.passengers} pax   £${party ?? '—'}`);
    console.log(`cheapest, 1 pax   £${one ?? '—'}`);
    if (party && one) {
      const ratio = party / one;
      console.log(`ratio             ${ratio.toFixed(2)}x`);
      console.log(
        ratio > 2.5
          ? `PRICES ARE PARTY TOTALS — correct as used.`
          : `PRICES ARE PER PERSON — every total is understated ${cfg.passengers}x and must be multiplied.`
      );
    }
    await soloPage.close();
  }
  if (out.html) {
    const text = out.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    console.log(`\nhtml          ${out.html.length} bytes`);
    console.log(`prices seen   ${(text.match(/£\s?[\d,]{2,}/g) ?? []).slice(0, 8).join(', ') || 'none'}`);
    console.log(`page says     ${text.slice(0, 300)}`);
  }
  console.log(
    out.status === 'ok'
      ? '\nGoogle: adapter works on a near date.'
      : '\nGoogle: adapter is broken — this date is definitely bookable.'
  );

  // Skyscanner, on the dates that actually matter. Google has no inventory
  // for these; the question is whether Skyscanner does and whether we can
  // read it without being blocked.
  for (const target of [
    { label: `near date ${soon}`, date: soon },
    { label: `real trip ${cfg.itineraries[0].out}`, date: cfg.itineraries[0].out },
  ]) {
    const ssUrl = skyscannerOneWayUrl(cfg.trip, { from: 'LON', to: 'MCO', date: target.date });
    console.log(`\n--- Skyscanner, ${target.label} ---`);
    console.log(ssUrl);
    const ssPage = await browser.newPage({ locale: cfg.trip.locale });
    const ss = await skyscanner(ssUrl ? ssPage : ssPage, {
      url: ssUrl,
      trip: cfg.trip,
      passengers: cfg.passengers,
    });
    console.log(`status        ${ss.status}`);
    if (ss.reason) console.log(`reason        ${ss.reason}`);
    console.log(`offers        ${ss.offers.length}`);
    for (const o of ss.offers.slice(0, 5)) {
      console.log(
        `  £${o.perPersonFare}/person → £${o.fare} party  ${o.carrier ?? '—'}  ${o.durationMin ?? '—'}min`
      );
    }
    if (ss.offers[0]) console.log(`row text      ${ss.offers[0].rawText.slice(0, 200)}`);
    await ssPage.close();
  }

  await browser.close();
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

/**
 * Circuit breaker. Four providers over eleven searches is 44 attempts, and a
 * provider that cannot be read costs a full timeout every time — enough to
 * blow the job's 30 minute budget on nothing but waiting. Two consecutive
 * failures with no offer at all is sufficient evidence; stop asking, and
 * record why so the dashboard shows the provider as tripped rather than
 * silently absent.
 */
const FAILURES_BEFORE_GIVING_UP = 2;
const consecutiveFailures = {};
const tripped = {};

for (const s of searches) {
  const page = await context.newPage();
  const directions = s.kind === 'round_trip' ? 2 : 1;
  // An open jaw is expressed as explicit legs; everything else as out-and-back.
  const routeArgs = s.slices
    ? { slices: s.slices }
    : { from: s.from, to: s.to, out: s.out ?? s.date, back: s.back ?? null };

  const providers = [
    { name: PROVIDER_BA, run: searchBA, url: baUrl(cfg.trip, cfg.party, routeArgs) },
    { name: PROVIDER_VS, run: searchVirgin, url: virginUrl(cfg.trip, cfg.party, routeArgs) },
    { name: PROVIDER, run: googleFlights, url: s.url },
    { name: SKYSCANNER, run: skyscanner, url: s.skyscannerUrl },
  ];

  const attempts = [];
  for (const p of providers) {
    if (!p.url) continue;
    if (tripped[p.name]) {
      attempts.push({ provider: p.name, status: 'skipped_provider_down', offers: [],
                      reason: tripped[p.name] });
      continue;
    }

    const r = await p.run(page, {
      url: p.url,
      trip: cfg.trip,
      passengers: cfg.passengers,
      directions,
    });
    attempts.push({ provider: p.name, ...r });

    if (r.status === 'ok') {
      consecutiveFailures[p.name] = 0;
    } else {
      consecutiveFailures[p.name] = (consecutiveFailures[p.name] ?? 0) + 1;
      if (consecutiveFailures[p.name] >= FAILURES_BEFORE_GIVING_UP) {
        tripped[p.name] = `${consecutiveFailures[p.name]} consecutive failures (last: ${r.status})`;
        console.log(`  ! ${p.name} given up on for this run — ${tripped[p.name]}`);
      }
      // Only the first failure per provider is worth keeping HTML for; after
      // that it is the same page over and over.
      if (r.html && consecutiveFailures[p.name] === 1) {
        writeDebugHtml(stamp, `${s.id}-${p.name}`, r.html);
      }
    }
    await sleep(2000 + Math.random() * 2000);
  }

  // Prefer whichever provider actually returned offers. Both are kept in the
  // snapshot so a provider going quiet is visible rather than silently
  // covered for by the other.
  const outcome =
    attempts.find((a) => a.status === 'ok') ?? attempts[0] ?? { status: 'no_provider', offers: [] };

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

  results.push({
    ...s,
    status: outcome.status,
    provider: outcome.provider ?? null,
    reason: outcome.reason ?? null,
    attempts: attempts.map((a) => ({ provider: a.provider, status: a.status, reason: a.reason ?? null, offers: a.offers.length })),
    offers: priced,
  });

  const icon = outcome.status === 'ok' ? '✓' : '·';
  const detail =
    outcome.status === 'ok'
      ? `${outcome.provider} — ${priced.length} offers, best £${priced[0]?.trueTotal ?? '—'}`
      : `${outcome.status}${outcome.reason ? ` — ${outcome.reason}` : ''}`;
  console.log(`  ${icon} ${s.id.padEnd(4)} ${s.label.padEnd(14)} ${detail}`);

  if (priced.length === 0) {
    // One row per source, not one for the search. Recording only the first
    // provider's outcome attributed every failure to whichever ran first and
    // hid what the other three actually did — the opposite of making the
    // source clear.
    for (const a of attempts) {
      historyRows.push({
        collected_at: collectedAt,
        search_id: s.id,
        signature: s.signature,
        provider: a.provider,
        kind: s.kind,
        status: a.status,
        out_date: s.out ?? s.date ?? '',
        back_date: s.back ?? '',
      });
    }
  } else {
    for (const o of priced) {
      historyRows.push({
        collected_at: collectedAt,
        search_id: s.id,
        signature: s.signature,
        provider: outcome.provider ?? '',
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

const pruned = pruneDebug();
if (pruned.removed) {
  console.log(
    `Pruned    ${pruned.removed} debug captures older than 14 days ` +
      `(${(pruned.freedBytes / 1048576).toFixed(1)} MB)`
  );
}

const snapFile = writeSnapshot(stamp, snapshot);
const written = appendHistory(historyRows);

const byProvider = {};
for (const r of results) {
  for (const a of r.attempts ?? []) {
    byProvider[a.provider] ??= { ok: 0, failed: 0, skipped: 0 };
    if (a.status === 'ok') byProvider[a.provider].ok++;
    else if (a.status === 'skipped_provider_down') byProvider[a.provider].skipped++;
    else byProvider[a.provider].failed++;
  }
}
console.log('\nBy source:');
for (const [name, c] of Object.entries(byProvider)) {
  console.log(`  ${(SOURCE_LABELS[name] ?? name).padEnd(26)} ok ${c.ok}  failed ${c.failed}  skipped ${c.skipped}`);
}

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
