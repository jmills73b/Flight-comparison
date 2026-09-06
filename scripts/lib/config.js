import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function readYaml(relPath) {
  return parse(readFileSync(join(ROOT, relPath), 'utf8'));
}

/** YAML turns bare dates into Date objects; everything downstream wants a string. */
function isoDate(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const s = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`Expected a YYYY-MM-DD date, got "${s}"`);
  }
  return s;
}

function nightsBetween(from, to) {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / 86400000);
}

/**
 * A signature identifies what was actually searched, independent of the short
 * display id. Changing a return date changes the signature, which is how the
 * dashboard knows to start a fresh price series rather than splicing a
 * different trip onto the old one.
 */
const itinerarySignature = (o) =>
  `${o.out}|${o.origin}>${o.into}|${o.home_from}>${o.origin}|${o.back}`;
const legSignature = (l) => `${l.date}|${l.from}>${l.to}`;

/**
 * Build the itinerary matrix from the declarative outbound/returns config.
 *
 * Home airports are ordered so the true round trip comes first for each
 * arrival airport, and open jaws follow — which is why A1 is MCO/MCO and A2 is
 * MCO/TPA rather than an arbitrary order.
 */
function buildItineraries(outbound, returns) {
  const itineraries = [];
  const counters = {};

  for (const ret of returns) {
    const shape = ret.shape;
    const back = isoDate(ret.date);

    for (const out of outbound.dates.map(isoDate)) {
      for (const into of outbound.into) {
        const homes = [...ret.from].sort((a, b) => {
          if (a === into) return -1;
          if (b === into) return 1;
          return String(a).localeCompare(String(b));
        });

        for (const home_from of homes) {
          counters[shape] = (counters[shape] ?? 0) + 1;
          const it = {
            id: `${shape}${counters[shape]}`,
            shape,
            out,
            back,
            origin: outbound.origin,
            into,
            home_from,
            nights: nightsBetween(out, back),
            isRoundTrip: into === home_from,
          };
          it.signature = itinerarySignature(it);
          itineraries.push(it);
        }
      }
    }
  }

  if (itineraries.some((it) => it.nights <= 0)) {
    throw new Error('A return date is on or before its outbound date');
  }
  return itineraries;
}

/**
 * The one-way legs every itinerary is composed from. Deduplicated, so adding a
 * second arrival airport costs one extra leg rather than one per itinerary.
 */
function buildLegs(itineraries) {
  const out = new Map();
  const back = new Map();

  for (const it of itineraries) {
    const o = { date: it.out, from: it.origin, to: it.into };
    const r = { date: it.back, from: it.home_from, to: it.origin };
    for (const [map, leg] of [[out, o], [back, r]]) {
      const key = legSignature(leg);
      if (!map.has(key)) map.set(key, { ...leg, signature: key, composes: [] });
      map.get(key).composes.push(it.id);
    }
  }

  const number = (entries, prefix) =>
    [...entries].map((leg, i) => ({ ...leg, id: `${prefix}${i + 1}` }));

  return [...number(out.values(), 'O'), ...number(back.values(), 'R')];
}

/** TUI sells matched same-airport return rotations from Gatwick. */
function buildTuiSearches(tui, outbound, returns) {
  if (!tui) return [];
  const ret = returns.find((r) => r.shape === tui.return_shape);
  if (!ret) {
    throw new Error(`TUI references return shape "${tui.return_shape}", which does not exist`);
  }
  const back = isoDate(ret.date);
  const searches = [];
  let n = 0;

  for (const out of outbound.dates.map(isoDate)) {
    for (const dest of tui.destinations) {
      const nights = nightsBetween(out, back);
      searches.push({
        id: `T${++n}`,
        airport: tui.airport,
        dest,
        out,
        back,
        nights,
        rotationFit: nights === tui.preferred_nights,
      });
    }
  }
  return searches;
}

/**
 * Buckets the party by each provider's own rules.
 *
 * Airlines disagree about where childhood ends. A real BA search URL uses
 * adults=2&youngAdults=1&children=1 for this family, bucketing 12-15 as
 * "young adults"; Google has no such category and counts 12 as an adult.
 * Storing ages and bucketing per provider keeps both correct, where storing
 * one conclusion would silently misprice on the other.
 */
export function bucketParty(trip) {
  const ages = [...(trip.children_ages ?? [])].sort((a, b) => b - a);
  const youngAdults = ages.filter((a) => a >= 12 && a <= 15);
  const children = ages.filter((a) => a >= 2 && a <= 11);
  const infants = ages.filter((a) => a < 2);
  const unaccounted = ages.filter((a) => a > 15);

  return {
    // BA and other carriers with a young-adult band.
    ba: {
      adults: trip.adults + unaccounted.length,
      youngAdults: youngAdults.length,
      children: children.length,
      infants: infants.length,
    },
    // Virgin: passengers=a2t1c1i0 — adults, teens, children, infants. Same
    // 12-15 band as BA under a different name; kept separate so the two can
    // diverge if either changes its rules.
    virgin: {
      adults: trip.adults + unaccounted.length,
      teens: youngAdults.length,
      children: children.length,
      infants: infants.length,
    },
    // Skyscanner: a real search reads adultsv2=2&childrenv2=12|9 — it accepts
    // a 12-year-old as a child, where Google counts the same age as an adult.
    // Fourth scheme, fourth bucket.
    skyscanner: {
      adults: trip.adults + unaccounted.length,
      childAges: [...youngAdults, ...children].sort((a, b) => b - a),
      infants: infants.length,
    },
    // Google and anything else with only adult/child/infant:
    // a young adult is an adult.
    standard: {
      adults: trip.adults + unaccounted.length + youngAdults.length,
      childAges: children,
      infants: infants.length,
    },
    total: trip.adults + ages.length,
  };
}

export function loadConfig() {
  const searches = readYaml('config/searches.yml');
  const fees = readYaml('config/carrier-fees.yml');
  const trip = searches.trip;

  const party = bucketParty(trip);
  const passengers = party.total;
  if (passengers < 1) throw new Error('Trip has no passengers');
  if (trip.checked_bags > passengers) {
    throw new Error(
      `checked_bags (${trip.checked_bags}) exceeds passengers (${passengers})`
    );
  }

  const itineraries = buildItineraries(searches.outbound, searches.returns);
  const legs = buildLegs(itineraries);
  const tui = buildTuiSearches(searches.tui, searches.outbound, searches.returns);

  validateLegCoverage(itineraries, legs);

  return {
    trip,
    party,
    passengers,
    itineraries,
    legs,
    tui,
    airports: searches.airports,
    fees,
  };
}

/**
 * Legs are generated, so this should never fail — but it is the invariant the
 * whole split-ticket price rests on, and a silent break would show up as
 * missing prices rather than an error. Cheap to assert, expensive to miss.
 */
function validateLegCoverage(itineraries, legs) {
  for (const it of itineraries) {
    const { out, back } = legsFor(it, legs);
    if (!out || !back) {
      throw new Error(`Itinerary ${it.id} has no matching leg pair`);
    }
    if (!out.composes.includes(it.id) || !back.composes.includes(it.id)) {
      throw new Error(`Legs ${out.id}/${back.id} do not list ${it.id} in composes`);
    }
  }
}

export function legsFor(itinerary, legs) {
  const wantOut = `${itinerary.out}|${itinerary.origin}>${itinerary.into}`;
  const wantBack = `${itinerary.back}|${itinerary.home_from}>${itinerary.origin}`;
  return {
    out: legs.find((l) => l.signature === wantOut),
    back: legs.find((l) => l.signature === wantBack),
  };
}
