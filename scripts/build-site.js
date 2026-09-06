/**
 * Rebuilds docs/data.json from data/history.csv.
 *
 * The dashboard reads only this file, and this file is derived only from the
 * CSV — so the site can always be rebuilt from history alone, and a bad run
 * never leaves the dashboard in a state you cannot reproduce.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadConfig, legsFor } from './lib/config.js';
import { readHistory } from './lib/store.js';
import { composeSplitTicket, round2 } from './lib/pricing.js';

const cfg = loadConfig();
const rows = readHistory();

const num = (v) => (v === '' || v == null ? null : Number(v));
const runs = [...new Set(rows.map((r) => r.collected_at))].sort();
const latestRun = runs.at(-1) ?? null;

/** Cheapest priced offer for a search id within one run. */
function bestFor(searchId, collectedAt) {
  const candidates = rows.filter(
    (r) =>
      r.search_id === searchId &&
      r.collected_at === collectedAt &&
      r.status === 'ok' &&
      num(r.true_total) !== null
  );
  if (candidates.length === 0) return null;
  const best = candidates.reduce((a, b) =>
    num(a.true_total) <= num(b.true_total) ? a : b
  );
  return {
    fare: num(best.fare),
    bagCost: num(best.bag_cost),
    trueTotal: num(best.true_total),
    carrier: best.carrier || null,
    stops: num(best.stops),
    depLocal: best.dep_local || null,
    arrLocal: best.arr_local || null,
    durationMin: num(best.duration_min),
    deepLink: best.deep_link || null,
  };
}

/** Cheapest total for one itinerary in one run, by either ticket structure. */
function itineraryPrice(it, collectedAt) {
  const { out, back } = legsFor(it, cfg.legs);
  const split = composeSplitTicket(bestFor(out.id, collectedAt), bestFor(back.id, collectedAt));
  const single = it.isRoundTrip ? bestFor(it.id, collectedAt) : null;
  const options = [
    single && { mode: 'single_ticket', trueTotal: single.trueTotal, detail: single },
    split && { mode: 'two_one_ways', trueTotal: split.trueTotal, detail: split },
  ].filter(Boolean);
  if (options.length === 0) return null;
  const cheapest = options.reduce((a, b) => (a.trueTotal <= b.trueTotal ? a : b));
  return {
    cheapest: round2(cheapest.trueTotal),
    mode: cheapest.mode,
    singleTicket: single ? round2(single.trueTotal) : null,
    splitTicket: split ? round2(split.trueTotal) : null,
    detail: cheapest.detail,
  };
}

const itineraries = cfg.itineraries.map((it) => {
  const series = runs
    .map((run) => {
      const p = itineraryPrice(it, run);
      return p ? { at: run, price: p.cheapest, mode: p.mode } : null;
    })
    .filter(Boolean);

  const current = latestRun ? itineraryPrice(it, latestRun) : null;
  const first = series[0] ?? null;

  return {
    id: it.id,
    shape: it.shape,
    nights: it.nights,
    out: it.out,
    back: it.back,
    origin: it.origin,
    into: it.into,
    homeFrom: it.home_from,
    isRoundTrip: it.isRoundTrip,
    current: current?.cheapest ?? null,
    mode: current?.mode ?? null,
    singleTicket: current?.singleTicket ?? null,
    splitTicket: current?.splitTicket ?? null,
    detail: current?.detail ?? null,
    firstSeen: first ? { at: first.at, price: first.price } : null,
    changeSinceFirst:
      current && first ? round2(current.cheapest - first.price) : null,
    series,
  };
});

// A search that has never once returned an offer is either not on sale yet or
// broken. The dashboard has to be able to tell those apart, so carry the last
// status verbatim rather than collapsing everything to "no price".
const searchStatus = {};
for (const id of [...new Set(rows.map((r) => r.search_id))]) {
  const last = rows.filter((r) => r.search_id === id).at(-1);
  searchStatus[id] = { status: last?.status ?? 'unknown', at: last?.collected_at ?? null };
}

const priced = itineraries.filter((i) => i.current !== null);
const data = {
  generated_at: new Date().toISOString(),
  trip: {
    name: cfg.trip.name,
    adults: cfg.trip.adults,
    children: cfg.trip.children,
    checkedBags: cfg.trip.checked_bags,
    cabin: cfg.trip.cabin,
    currency: cfg.trip.currency,
  },
  lastCollected: latestRun,
  runCount: runs.length,
  carHire: cfg.fees.one_way_car_hire ?? null,
  best: priced.length
    ? priced.reduce((a, b) => (a.current <= b.current ? a : b))
    : null,
  itineraries,
  searchStatus,
};

mkdirSync(join(ROOT, 'docs'), { recursive: true });
writeFileSync(join(ROOT, 'docs', 'data.json'), JSON.stringify(data, null, 2));

console.log(
  `docs/data.json — ${runs.length} runs, ${priced.length}/${itineraries.length} itineraries priced`
);
