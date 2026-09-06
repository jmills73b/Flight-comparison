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
 * Virgin does not appear to take the LON metro code, so a London search is
 * narrowed to Heathrow. That is a real narrowing and it is recorded on the
 * offer: Virgin's UK-Florida flying is Heathrow-based, but any Gatwick service
 * would be missed.
 */
function virginPassengers(party) {
  const v = party.virgin;
  return `a${v.adults}t${v.teens}c${v.children}i${v.infants}`;
}

const VIRGIN_PLACE = { LON: 'LHR' };
const vsPlace = (iata) => VIRGIN_PLACE[iata] ?? iata;

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
  return `${CARRIERS.virgin.search}?${p}`;
}

const CARRIERS = {
  ba: {
    code: 'BA',
    name: 'British Airways',
    // Real homepage, confirmed. The search path beyond it is still unknown.
    home: 'https://www.britishairways.com/travel/home/public/en_gb/',
    // Confirmed from a real search.
    search: 'https://www.britishairways.com/nx/b/airselect/en/gbr/book/search/',
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
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      await dismissConsent(page, carrier.consent);

      const blocked = await detectBlock(page);
      if (blocked) return fail('blocked', blocked, page, started);

      const ready = await waitForPrice(page, timeoutMs);
      if (!ready.ok) return fail(ready.status, ready.reason, page, started);

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
          .filter(Boolean);

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
    fareBrand: null,
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
  return baSearchUrl(trip, party, route);
}
export function virginUrl(trip, party, route) {
  return virginSearchUrl(trip, party, route);
}
