/**
 * Direct airline adapters: British Airways and Virgin Atlantic.
 *
 * These two are the realistic carriers for London to Orlando or Tampa, so
 * their own sites are the most authoritative source available — and unlike an
 * aggregator, a fare read here comes with the airline's own baggage rules
 * rather than the curated estimates in config/carrier-fees.yml.
 *
 * They are also the fallback for the two problems that emerged in testing:
 * Google carries no August 2027 inventory yet, and Skyscanner cannot be read
 * headlessly from a datacentre IP at all.
 *
 * BOTH QUOTE PER PERSON. Like Skyscanner and unlike Google, so offers are
 * multiplied up to a party total and stamped with the basis, because mixing
 * bases silently is a fourfold error in the flattering direction.
 *
 * Each adapter reports the single carrier it searched, so a price from here is
 * never attributed to the wrong airline: `carrier` is fixed, not inferred.
 *
 * BRITISH AIRWAYS: the URL below is REAL, read off an actual search rather
 * than invented. An earlier guessed URL timed out; this one is the genuine
 * /nx/b/airselect/ search path with its real parameter names.
 *
 * VIRGIN ATLANTIC: the URL is now REAL too, read off an actual search. It uses
 * a slice model — origin, destination and departing repeat once per leg — and
 * a packed passenger string, passengers=a2t1c1i0 for adults, teens, children
 * and infants. Because each leg is stated separately, Virgin can express an
 * open jaw, which Google's q= form cannot.
 */
import {
  parseMoney,
  parseStops,
  parseDuration,
  parseTimes,
  looksLikeFlight,
  detectBlock,
  dismissConsent,
  waitForPrice,
  fail,
  filterByStops,
  stopsReason,
} from './shared.js';
import { parseBaOffer, parseBaRibbon } from './ba-parse.js';

const MIN_PER_PERSON = 50;

/**
 * Real British Airways search URL, taken verbatim from a performed search:
 *
 *   /nx/b/airselect/en/gbr/book/search/?trip=round&arrivalDate=2027-08-26
 *   &departureDate=2027-08-12&from=LON&to=MCO&travelClass=economy
 *   &adults=2&youngAdults=1&children=1&infants=0&bound=outbound
 *
 * Note `youngAdults`: BA bands 12-15 separately from adults and children, so
 * the party is bucketed for BA rather than reusing Google's adult/child split.
 * Dates are plain ISO, and `from`/`to` take IATA codes including the LON metro
 * code — so the same two-airport coverage works here.
 */
function baSearchUrl(trip, party, { from, to, out, back }) {
  const p = new URLSearchParams({
    trip: back ? 'round' : 'oneway',
    departureDate: out,
    from,
    to,
    travelClass: trip.cabin,
    adults: String(party.ba.adults),
    youngAdults: String(party.ba.youngAdults),
    children: String(party.ba.children),
    infants: String(party.ba.infants),
    bound: 'outbound',
  });
  if (back) p.set('arrivalDate', back);
  return `${CARRIERS.ba.search}?${p}`;
}

/**
 * Real Virgin Atlantic search URL, taken verbatim from a performed search:
 *
 *   /flights/search/slice?passengers=a2t1c1i0
 *     &origin=LHR&origin=MCO&destination=MCO&destination=LHR
 *     &departing=2027-07-22&departing=2027-07-29
 *
 * Each leg is a "slice": origin, destination and departing repeat once per
 * leg, in order. That makes an open jaw expressible — fly into Orlando, home
 * from Miami — which Google's q= form cannot do, so `slices` is accepted
 * directly as well as the simple from/to/out/back shape.
 *
 * Virgin DOES take the LON metro code — a real search URL reads origin=LON.
 * An earlier version narrowed London to Heathrow on the assumption it did not,
 * which would have silently missed any Gatwick service. Assumption removed.
 *
 * Multi-city uses this same path: the slice list simply describes different
 * legs, so an open jaw needs no separate URL builder.
 *
 * SELECTING A FARE BRAND CANNOT BE DONE BY URL. A real fare-selected URL reads
 * .../slice/1?...&id=16ddbe26-35c4-...&fareId=c95f0e16-...|dcb01a6a-...-FL-2 —
 * both are session GUIDs minted server-side for that one search, and they
 * expire. So the Economy Classic price (hold bag, not refundable) can only be
 * had by driving the page: run the search, then click the brand. Noted here so
 * the URL route is not attempted again.
 */
function virginPassengers(party) {
  const v = party.virgin;
  return `a${v.adults}t${v.teens}c${v.children}i${v.infants}`;
}

// No place mapping needed: Virgin takes plain IATA codes, LON included.
const vsPlace = (iata) => iata;

function virginSearchUrl(trip, party, route) {
  // Either an explicit list of legs, or the usual out-and-back pair.
  const slices = route.slices ?? [
    { from: route.from, to: route.to, date: route.out },
    ...(route.back ? [{ from: route.to, to: route.from, date: route.back }] : []),
  ];

  const p = new URLSearchParams();
  p.set('passengers', virginPassengers(party));
  for (const s of slices) p.append('origin', vsPlace(s.from));
  for (const s of slices) p.append('destination', vsPlace(s.to));
  for (const s of slices) p.append('departing', s.date);
  // The working URL carried this; a search without it returned Virgin's
  // "there was a problem processing your request" error page.
  p.set('CTA', 'AbTest_SP_Flights');
  return `${CARRIERS.virgin.search}?${p}`;
}

/**
 * What a page that never produced a price is actually saying.
 *
 * "No price appeared" is the observation, not the diagnosis, and the three
 * possibilities behind it need entirely different fixes: the site refused the
 * request, the site is still loading, or there genuinely are no flights. Read
 * it out of the DOM rather than guessing.
 */
async function classifyStalledPage(page, carrier) {
  const body = await page.innerText('body').catch(() => '');

  if (/problem processing your request|please go back and try/i.test(body)) {
    return {
      status: 'request_rejected',
      reason: `${carrier.code} returned its "problem processing your request" page`,
    };
  }
  if (/no flights|no results|nothing available|sold out/i.test(body)) {
    return { status: 'no_flights', reason: `${carrier.code} reported no flights on this date` };
  }

  // Still showing placeholder bars means the results request never came back:
  // the shell rendered and then waited, which is a different failure from a
  // page that finished and had nothing to show.
  const skeletons = await page
    .locator('ba-loading-skeleton, [class*="loading-skeleton"], [class*="skeleton"]')
    .count()
    .catch(() => 0);
  if (skeletons > 0) {
    return {
      status: 'results_never_loaded',
      reason:
        `${carrier.code} still showing ${skeletons} loading placeholders — ` +
        'the results request never returned',
    };
  }

  return null;
}

/**
 * Real British Airways MULTI-CITY URL, taken verbatim from a performed search:
 *
 *   /travel/book/public/en_gb/flightList
 *     ?onds=LON-MCO_2027-08-11,MIA-LON_2027-08-26
 *     &ad=2&yad=1&ch=1&inf=0&cabin=M&flex=LOWEST&ond=1
 *
 * A different path from the single-trip search, and a tidier shape: `onds` is
 * a comma-separated list of ORIGIN-DESTINATION_DATE triples, one per leg, so
 * it expresses an open jaw directly. Passenger counts are abbreviated —
 * ad/yad/ch/inf — and `cabin=M` is economy.
 *
 * `flex=LOWEST` asks for the cheapest fares, which is consistent with the
 * "price from" figure the results page shows; a stricter fare brand would need
 * a different value, and finding that is what a true Economy Standard price
 * still depends on.
 *
 * Round trips keep using the airselect URL, which is separately verified and
 * returning real fares. This form could very likely serve both — a return is
 * just LON-MCO_out,MCO-LON_back — but switching a working search on an
 * untested hunch is how the earlier guessed URLs wasted runs.
 */
const BA_CABIN = { economy: 'M', premium_economy: 'W', business: 'C', first: 'F' };

function baMultiCityUrl(trip, party, legs) {
  const onds = legs.map((l) => `${l.from}-${l.to}_${l.date}`).join(',');
  const p = new URLSearchParams({
    ad: String(party.ba.adults),
    yad: String(party.ba.youngAdults),
    ch: String(party.ba.children),
    inf: String(party.ba.infants),
    cabin: BA_CABIN[trip.cabin] ?? 'M',
    flex: 'LOWEST',
    ond: '1',
  });
  // `onds` is appended rather than set, with its comma left literal. BA's own
  // URLs separate the legs with a bare comma; URLSearchParams would percent-
  // encode it to %2C. The two are equivalent by the standard, but matching
  // what BA actually emits removes a whole class of "it worked in the browser
  // but not here" doubt for free.
  return `${CARRIERS.ba.multiCity}?onds=${onds}&${p}`;
}

const CARRIERS = {
  ba: {
    code: 'BA',
    name: 'British Airways',
    // Real homepage, confirmed. The search path beyond it is still unknown.
    home: 'https://www.britishairways.com/travel/home/public/en_gb/',
    // Confirmed from a real search.
    search: 'https://www.britishairways.com/nx/b/airselect/en/gbr/book/search/',
    // Confirmed from a real multi-city search — a different path entirely.
    multiCity: 'https://www.britishairways.com/travel/book/public/en_gb/flightList',
    consent: ['Accept all cookies', 'Accept All Cookies', 'Allow all'],
  },
  virgin: {
    code: 'VS',
    name: 'Virgin Atlantic',
    // Real homepage, confirmed. The search path beyond it is still unknown.
    home: 'https://www.virginatlantic.com/en-gb',
    // Confirmed from a real search.
    search: 'https://www.virginatlantic.com/flights/search/slice',
    consent: ['Accept All Cookies', 'Accept all', 'I agree'],
  },
};

function makeAdapter(key) {
  const carrier = CARRIERS[key];

  return async function search(page, { url, trip, passengers, timeoutMs = 30000 }) {
    const started = Date.now();
    try {
      // Virgin answered a cold search URL with "there was a problem processing
      // your request" — an error page, not a slow one. Loading the homepage
      // first gives it the cookies a real visitor would already have.
      if (carrier.code === 'VS') {
        await page
          .goto(carrier.home, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
          .catch(() => {});
        await dismissConsent(page, carrier.consent);
        await page.waitForTimeout(1500);
      }

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      await dismissConsent(page, carrier.consent);

      // Virgin's error page is a normal 200 with a normal title, so it parses
      // as "no flights" unless looked for by name.
      if (carrier.code === 'VS') {
        const body = await page.innerText('body').catch(() => '');
        if (/problem processing your request|please go back and try/i.test(body)) {
          return fail(
            'request_rejected',
            'Virgin returned its "problem processing your request" page',
            page,
            started
          );
        }
      }

      const blocked = await detectBlock(page);
      if (blocked) return fail('blocked', blocked, page, started);

      // BA's multi-city page was still showing "Loading flight results" at 45s
      // while the round-trip page renders in a couple. Give it longer rather
      // than concluding there are no fares.
      const isMulti = /flightList/.test(url);
      const ready = await waitForPrice(page, isMulti ? timeoutMs * 2.5 : timeoutMs);
      if (!ready.ok) {
        // Re-read the page before naming the failure. Both sites are
        // single-page apps: at domcontentloaded the body is a shell, so the
        // rejection check above ran too early to see anything. Whatever the
        // page has to say, it has said by now — and a saved Virgin page
        // carrying "there was a problem processing your request" while the run
        // reported "no prices rendered" is a misdiagnosis that sent me looking
        // at browser fingerprints for a day.
        const late = await classifyStalledPage(page, carrier);
        if (late) return fail(late.status, late.reason, page, started);
        return fail(ready.status, ready.reason, page, started);
      }

      // BA's multi-city page states "Prices are per adult, EXCLUDING taxes,
      // fees and carrier charges", where the round-trip page says INCLUDING.
      // Recording both as if they were the same figure would understate an
      // open jaw by the entire tax component, which on a transatlantic fare is
      // hundreds of pounds. Detect the wording rather than assume either way.
      const pageText = await page.innerText('body').catch(() => '');
      const excludesTaxes = /excluding taxes, fees and carrier charges/i.test(pageText);

      let offers = [];
      let ribbon = [];

      if (carrier.code === 'BA') {
        // BA states the party on the page; confirm it rather than trust it,
        // the same rule the Google adapter follows.
        const partyText = await page
          .locator('[data-testid="edit-search-passengers-amount"]')
          .first()
          .innerText()
          .catch(() => '');
        const shown = String(partyText).match(/(\d+)/);
        if (shown && Number(shown[1]) !== passengers) {
          return fail(
            'passenger_setup_failed',
            `BA shows ${shown[1]} passengers, expected ${passengers}`,
            page,
            started
          );
        }

        const raw = await page.evaluate(() =>
          Array.from(document.querySelectorAll('[data-testid^="offerFlightHeader-"]')).map(
            (el) => ({
              testid: el.getAttribute('data-testid'),
              text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
            })
          )
        );
        offers = raw
          .map((r) => parseBaOffer(r.text, r.testid, { passengers }))
          .filter(Boolean)
          .map((o) => ({
            ...o,
            excludesTaxes,
            priceBasis: excludesTaxes
              ? 'per_passenger_excluding_taxes_estimate'
              : o.priceBasis,
          }));

        // A tax-exclusive figure is not comparable with the tax-inclusive ones
        // the rest of the tracker records, so it is not passed off as one.
        if (excludesTaxes && offers.length) {
          return fail(
            'price_excludes_taxes',
            `BA quoted ${offers.length} fares EXCLUDING taxes and charges ` +
              `(cheapest £${Math.min(...offers.map((o) => o.perPassengerFare))}/pax). ` +
              `Not comparable with the tax-inclusive prices tracked elsewhere.`,
            page,
            started
          );
        }

        // Free with every BA search: prices for the days either side.
        const ribbonText = await page
          .locator('[data-testid="ribbon-calendar-desktop"]')
          .first()
          .innerText()
          .catch(() => '');
        ribbon = parseBaRibbon(String(ribbonText).replace(/\s+/g, ' '));
      } else {
        const rows = await page.evaluate(() =>
          Array.from(document.querySelectorAll('li, tr, article, [class*="flight"], [class*="fare"]'))
            .map((el) => ({
              text: (el.innerText || '').replace(/\s+/g, ' ').trim(),
              href: el.querySelector('a')?.getAttribute('href') || null,
            }))
            .filter((r) => /£\s?[\d,]{2,}/.test(r.text) && r.text.length > 20 && r.text.length < 1200)
        );
        offers = rows.map((r) => parseRow(r, passengers, carrier)).filter(Boolean);
      }

      const dropped = filterByStops(offers, trip.max_stops);
      const withinLimit = dropped.kept;

      if (withinLimit.length === 0 && offers.length > 0) {
        return fail('no_offers_within_stop_limit', stopsReason(trip.max_stops, dropped), page, started);
      }
      if (withinLimit.length === 0) {
        return fail('no_offers_parsed', 'No offer survived validation', page, started);
      }
      offers = withinLimit;

      return {
        status: 'ok',
        offers,
        ribbon,
        candidateRows: offers.length,
        elapsedMs: Date.now() - started,
        html: null,
      };
    } catch (err) {
      return fail('exception', err.message, page, started);
    }
  };
}

export function parseRow(row, passengers, carrier) {
  const text = row.text;
  const perPerson = parseMoney(text);
  if (perPerson === null || perPerson < MIN_PER_PERSON) return null;

  const times = parseTimes(text);
  const durationMin = parseDuration(text);
  if (!looksLikeFlight({ carrier: carrier.code, durationMin, times })) return null;

  return {
    fare: perPerson * passengers,
    perPersonFare: perPerson,
    priceBasis: 'per_person_x_passengers',
    // Fixed, not inferred: this adapter only ever searched this airline.
    carrier: carrier.code,
    carrierName: carrier.name,
    // The brand to actually book on Virgin is Economy Classic, which includes
    // hold luggage. A results list quotes the cheapest brand, Economy Light,
    // which does not — the same teaser-price trap as BA's Economy Basic. Named
    // so carrier-fees.yml adds the bag rather than assuming one is included.
    // Unverified: no Virgin results page has been captured yet.
    fareBrand: carrier.code === 'VS' ? 'Economy Light (lowest available)' : null,
    isFromPrice: carrier.code === 'VS',
    stops: parseStops(text),
    depLocal: times[0] ?? null,
    arrLocal: times[1] ?? null,
    durationMin,
    deepLink: row.href,
    rawText: text.slice(0, 400),
  };
}

export const PROVIDER_BA = 'british_airways';
export const PROVIDER_VS = 'virgin_atlantic';

export const searchBA = makeAdapter('ba');
export const searchVirgin = makeAdapter('virgin');

export function baUrl(trip, party, route) {
  // An open jaw arrives as explicit legs and needs the multi-city form.
  if (route.slices) return baMultiCityUrl(trip, party, route.slices);
  return baSearchUrl(trip, party, route);
}
export function virginUrl(trip, party, route) {
  return virginSearchUrl(trip, party, route);
}
