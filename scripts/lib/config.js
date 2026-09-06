import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function readYaml(relPath) {
  return parse(readFileSync(join(ROOT, relPath), 'utf8'));
}

/**
 * A date in searches.yml may be parsed by YAML into a Date. Everything
 * downstream wants a plain YYYY-MM-DD string, so normalise once, here.
 */
function isoDate(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const s = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`Expected a YYYY-MM-DD date, got "${s}"`);
  }
  return s;
}

export function loadConfig() {
  const searches = readYaml('config/searches.yml');
  const fees = readYaml('config/carrier-fees.yml');

  const trip = searches.trip;
  const passengers = trip.adults + (trip.children?.length ?? 0);
  if (passengers < 1) throw new Error('Trip has no passengers');
  if (trip.checked_bags > passengers) {
    throw new Error(
      `checked_bags (${trip.checked_bags}) exceeds passengers (${passengers})`
    );
  }

  const itineraries = searches.itineraries.map((it) => ({
    ...it,
    out: isoDate(it.out),
    back: isoDate(it.back),
    // A true round trip returns from the airport it flew into. Anything else
    // is an open jaw, which Google's q= URL cannot express as one ticket.
    isRoundTrip: it.into === it.home_from,
  }));

  const legs = searches.legs.map((l) => ({ ...l, date: isoDate(l.date) }));

  const tui = (searches.tui ?? []).map((t) => ({
    ...t,
    out: isoDate(t.out),
    back: isoDate(t.back),
  }));

  validateLegCoverage(itineraries, legs);

  return { trip, passengers, itineraries, legs, tui, airports: searches.airports, fees };
}

/**
 * Every itinerary must be composable from exactly one outbound and one return
 * leg, because that composition is how split-ticket prices are produced. A
 * config edit that breaks this would otherwise show up as silently missing
 * prices, so fail loudly at load instead.
 */
function validateLegCoverage(itineraries, legs) {
  for (const it of itineraries) {
    const out = legs.filter(
      (l) => l.date === it.out && l.from === it.origin && l.to === it.into
    );
    const back = legs.filter(
      (l) => l.date === it.back && l.from === it.home_from && l.to === it.origin
    );
    if (out.length !== 1 || back.length !== 1) {
      throw new Error(
        `Itinerary ${it.id} is not covered by exactly one leg pair ` +
          `(found ${out.length} outbound, ${back.length} return). ` +
          `Check config/searches.yml.`
      );
    }
    if (!out[0].composes.includes(it.id) || !back[0].composes.includes(it.id)) {
      throw new Error(
        `Legs ${out[0].id}/${back[0].id} do not list ${it.id} in composes`
      );
    }
  }
}

export function legsFor(itinerary, legs) {
  return {
    out: legs.find(
      (l) =>
        l.date === itinerary.out &&
        l.from === itinerary.origin &&
        l.to === itinerary.into
    ),
    back: legs.find(
      (l) =>
        l.date === itinerary.back &&
        l.from === itinerary.home_from &&
        l.to === itinerary.origin
    ),
  };
}
