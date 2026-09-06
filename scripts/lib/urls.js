/**
 * Google Flights search URLs.
 *
 * Google packs a full search into a `tfs` parameter, which is a base64url
 * protobuf. Building that by hand would be the most precise approach, but its
 * schema is private and reverse-engineered, and a wrong field number produces
 * a valid-looking URL that quietly searches for something else — the worst
 * possible failure for a price tracker.
 *
 * So we use the `q=` form instead, which Google parses server-side. It is
 * readable, and anyone can paste one into a browser to confirm the search is
 * the one we meant. Run `npm run urls` to print them all.
 *
 * The one thing q= cannot express is a multi-city open jaw. That costs us
 * nothing today: the seven one-way legs already price all twelve itineraries
 * as split tickets. Single-ticket pricing for the eight open jaws needs the
 * multi-city UI and is a later phase.
 */

const BASE = 'https://www.google.com/travel/flights';

function params(trip) {
  return new URLSearchParams({
    curr: trip.currency,
    hl: trip.locale,
    gl: trip.country,
  });
}

export function roundTripUrl(trip, { from, to, out, back }) {
  const p = params(trip);
  p.set('q', `Flights from ${from} to ${to} on ${out} through ${back}`);
  return `${BASE}?${p}`;
}

export function oneWayUrl(trip, { from, to, date }) {
  const p = params(trip);
  p.set('q', `Flights from ${from} to ${to} on ${date} one way`);
  return `${BASE}?${p}`;
}

/**
 * Every search this run will perform, in execution order. Each entry carries
 * the id it will be recorded under, so the collector never has to reconstruct
 * that from the URL.
 */
export function plannedSearches({ trip, itineraries, legs }) {
  const searches = [];

  for (const it of itineraries) {
    if (!it.isRoundTrip) continue; // open jaw — priced from legs instead
    searches.push({
      kind: 'round_trip',
      id: it.id,
      label: `${it.origin} ⇄ ${it.into}`,
      out: it.out,
      back: it.back,
      url: roundTripUrl(trip, {
        from: it.origin,
        to: it.into,
        out: it.out,
        back: it.back,
      }),
    });
  }

  for (const leg of legs) {
    searches.push({
      kind: 'one_way',
      id: leg.id,
      label: `${leg.from} → ${leg.to}`,
      date: leg.date,
      url: oneWayUrl(trip, { from: leg.from, to: leg.to, date: leg.date }),
    });
  }

  return searches;
}
