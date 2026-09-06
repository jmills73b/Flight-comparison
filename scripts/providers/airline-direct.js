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
 * VIRGIN ATLANTIC: still a guess, and still marked as such. It rendered no
 * price on the first run and needs a real search URL before it can be trusted.
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
} from './shared.js';

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
 * Virgin's real search URL is not known yet, so this remains a guess and will
 * probably fail. Kept so the adapter is wired and ready the moment a genuine
 * search URL is available, rather than pretending it works.
 */
function virginSearchUrl(trip, party, { from, to, out, back }) {
  const p = new URLSearchParams({
    origin: from,
    destination: to,
    departureDate: out,
    passengerCount: String(party.total),
    cabinClass: trip.cabin,
  });
  if (back) p.set('returnDate', back);
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
    // Still a guess — no real search URL yet.
    search: 'https://www.virginatlantic.com/gb/en/book/flights',
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

      const rows = await page.evaluate(() =>
        Array.from(document.querySelectorAll('li, tr, article, [class*="flight"], [class*="fare"]'))
          .map((el) => ({
            text: (el.innerText || '').replace(/\s+/g, ' ').trim(),
            href: el.querySelector('a')?.getAttribute('href') || null,
          }))
          .filter((r) => /£\s?[\d,]{2,}/.test(r.text) && r.text.length > 20 && r.text.length < 1200)
      );

      const offers = rows
        .map((r) => parseRow(r, passengers, carrier))
        .filter(Boolean);

      if (offers.length === 0) {
        return fail(
          'no_offers_parsed',
          `Found ${rows.length} candidate rows, none survived validation`,
          page,
          started
        );
      }

      return {
        status: 'ok',
        offers,
        candidateRows: rows.length,
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
