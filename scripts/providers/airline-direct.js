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
 * STATUS: THE BOOKING URLS BELOW ARE UNVERIFIED GUESSES AND DO NOT WORK.
 * On the first live run British Airways timed out navigating and Virgin
 * rendered no price. The parameter names here were written from memory, not
 * from a real booking URL — the same mistake this project deliberately avoided
 * with Google's private `tfs` protobuf, where a wrong guess produces a
 * plausible URL that quietly searches for the wrong thing.
 *
 * These adapters are therefore scaffolding, not a working source. Fixing them
 * needs a genuine search URL copied from a browser that has just performed the
 * search, so the real parameter names and date format can be read off rather
 * than invented. The parsing and safety logic below is sound and reusable; it
 * is only `bookingUrl` that is fiction.
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

/** IATA codes as each airline's own booking form expects them. */
function bookingUrl(base, { from, to, out, back, trip }) {
  const p = new URLSearchParams({
    departurePoint: from,
    destinationPoint: to,
    departInputDate: out,
    ad: String(trip.adults),
    cabin: trip.cabin === 'economy' ? 'M' : 'W',
  });
  if (back) {
    p.set('returnInputDate', back);
    p.set('journeyType', 'RETURN');
  } else {
    p.set('journeyType', 'ONEWAY');
  }
  const kids = trip.children ?? [];
  if (kids.length) p.set('ch', String(kids.length));
  return `${base}?${p}`;
}

const CARRIERS = {
  ba: {
    code: 'BA',
    name: 'British Airways',
    // Real homepage, confirmed. The search path beyond it is still unknown.
    home: 'https://www.britishairways.com/travel/home/public/en_gb/',
    base: 'https://www.britishairways.com/travel/booking/public/en_gb',
    consent: ['Accept all cookies', 'Accept All Cookies', 'Allow all'],
  },
  virgin: {
    code: 'VS',
    name: 'Virgin Atlantic',
    // Real homepage, confirmed. The search path beyond it is still unknown.
    home: 'https://www.virginatlantic.com/en-gb',
    base: 'https://www.virginatlantic.com/gb/en/book/flights',
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

export function baUrl(trip, { from, to, out, back }) {
  return bookingUrl(CARRIERS.ba.base, { from, to, out, back, trip });
}
export function virginUrl(trip, { from, to, out, back }) {
  return bookingUrl(CARRIERS.virgin.base, { from, to, out, back, trip });
}
