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

import { bucketParty } from './config.js';

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
  const { adults, childAges } = bucketParty(trip).standard;
  const bits = [];
  if (adults > 0) bits.push(`${adults} adult${adults === 1 ? '' : 's'}`);
  if (childAges.length) {
    bits.push(`${childAges.length} child${childAges.length === 1 ? '' : 'ren'}`);
  }
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

// ---------------------------------------------------------------------------
// Skyscanner
//
// Added because Google carries no August 2027 inventory yet while Skyscanner
// does — it aggregates OTAs and consolidators that sell further ahead. Its
// URLs are path-based and stable, so no query parsing is involved.
//
// Skyscanner quotes PER PERSON where Google quotes the party total. The
// adapter normalises to a party total and records which basis it came from,
// because silently mixing the two would be a fourfold error.
// ---------------------------------------------------------------------------

const SKYSCANNER = 'https://www.skyscanner.net/transport/flights';

/** Skyscanner uses its own metro codes; only London differs from IATA here. */
const SKYSCANNER_PLACE = { LON: 'lond' };

const place = (iata) => (SKYSCANNER_PLACE[iata] ?? iata).toLowerCase();

/** Skyscanner dates are YYMMDD. */
const ssDate = (iso) => iso.slice(2, 4) + iso.slice(5, 7) + iso.slice(8, 10);

function skyscannerParams(trip, rtn) {
  const { adults, childAges } = bucketParty(trip).standard;
  const p = new URLSearchParams({
    adultsv2: String(adults),
    cabinclass: trip.cabin,
    rtn: rtn ? '1' : '0',
    currency: trip.currency,
    market: 'UK',
    locale: trip.locale,
    preferdirects: 'false',
  });
  if (childAges.length) p.set('childrenv2', childAges.join('|'));
  return p;
}

export function skyscannerRoundTripUrl(trip, { from, to, out, back }) {
  return (
    `${SKYSCANNER}/${place(from)}/${place(to)}/${ssDate(out)}/${ssDate(back)}/` +
    `?${skyscannerParams(trip, true)}`
  );
}

export function skyscannerOneWayUrl(trip, { from, to, date }) {
  return (
    `${SKYSCANNER}/${place(from)}/${place(to)}/${ssDate(date)}/` +
    `?${skyscannerParams(trip, false)}`
  );
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
      from: it.origin,
      to: it.into,
      out: it.out,
      back: it.back,
      url: roundTripUrl(trip, {
        from: it.origin,
        to: it.into,
        out: it.out,
        back: it.back,
      }),
      skyscannerUrl: skyscannerRoundTripUrl(trip, {
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
      from: leg.from,
      to: leg.to,
      date: leg.date,
      url: oneWayUrl(trip, { from: leg.from, to: leg.to, date: leg.date }),
      skyscannerUrl: skyscannerOneWayUrl(trip, {
        from: leg.from,
        to: leg.to,
        date: leg.date,
      }),
    });
  }

  return searches;
}
