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

/**
 * Party size stated in the query text, so Google parses it server-side. The
 * first run drove the passenger stepper through the UI instead, and every
 * search died retrying that click. The UI is still read afterwards, but only
 * to confirm the number — clicking is now the fallback, not the mechanism.
 */
function partyPhrase(trip) {
  const bits = [];
  if (trip.adults > 0) bits.push(`${trip.adults} adult${trip.adults === 1 ? '' : 's'}`);
  const kids = trip.children?.length ?? 0;
  if (kids > 0) bits.push(`${kids} child${kids === 1 ? '' : 'ren'}`);
  return bits.length ? ` for ${bits.join(' and ')}` : '';
}

export function roundTripUrl(trip, { from, to, out, back }) {
  const p = params(trip);
  p.set('q', `Flights from ${from} to ${to} on ${out} through ${back}${partyPhrase(trip)}`);
  return `${BASE}?${p}`;
}

export function oneWayUrl(trip, { from, to, date }) {
  const p = params(trip);
  p.set('q', `Flights from ${from} to ${to} on ${date} one way${partyPhrase(trip)}`);
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
      signature: it.signature,
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
      signature: leg.signature,
      label: `${leg.from} → ${leg.to}`,
      date: leg.date,
      url: oneWayUrl(trip, { from: leg.from, to: leg.to, date: leg.date }),
    });
  }

  return searches;
}
