/**
 * Google Flights adapter.
 *
 * The guiding rule is that a wrong price is far worse than no price. A tracker
 * that silently records a one-adult fare as if it were the family total would
 * send you to book at the wrong moment. So every step that could go wrong
 * either confirms itself or fails the search outright, and the caller records
 * the failure rather than a number.
 */

import { parseStops, matchCarrier } from './shared.js';
import { bucketParty } from '../lib/config.js';

export const PROVIDER = 'google_flights';
export const PROVIDER_LABEL = 'Google Flights';

export async function search(page, { url, trip, passengers, directions = 1, timeoutMs = 45000 }) {
  const started = Date.now();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await dismissConsent(page);

    const partySet = await setPassengers(page, trip);
    if (!partySet.ok) {
      return fail('passenger_setup_failed', partySet.reason, page, started);
    }

    await submitSearch(page);

    const ready = await waitForResults(page, timeoutMs);
    if (!ready.ok) return fail(ready.status, ready.reason, page, started);

    const rows = await extractRows(page);
    // £50 per passenger per direction. A real transatlantic fare is far above
    // this; it exists only to reject parsing artefacts.
    const minPlausibleFare = 50 * passengers * directions;
    const offers = rows
      .map((r) => parseRow(r, minPlausibleFare))
      .filter((o) => o !== null);

    if (offers.length === 0) {
      return fail(
        'no_offers_parsed',
        `Found ${rows.length} candidate rows, but none survived validation ` +
          `(needs a carrier, times or duration, and a fare of at least ` +
          `£${minPlausibleFare})`,
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
}

async function fail(status, reason, page, started) {
  let html = null;
  try {
    html = await page.content();
  } catch {
    /* page may be gone; the reason still tells us what happened */
  }
  return { status, reason, offers: [], elapsedMs: Date.now() - started, html };
}

/** Google shows a consent interstitial in the EU/UK before anything renders. */
async function dismissConsent(page) {
  const labels = ['Accept all', 'Reject all', 'I agree', 'Agree to all'];
  for (const label of labels) {
    const button = page.getByRole('button', { name: label, exact: false });
    try {
      if (await button.first().isVisible({ timeout: 2500 })) {
        await button.first().click({ timeout: 5000 });
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
        return true;
      }
    } catch {
      /* not present — that is the common case outside the consent wall */
    }
  }
  return false;
}

/**
 * Confirms the party size. The q= URL states it in the query text, so this
 * usually just reads it back. Returns { ok } only once the control reports the
 * party we asked for; anything else fails the search.
 */
async function setPassengers(page, trip) {
  // Must come from the same bucketing the URL was built with. This read
  // trip.children directly and silently became 2 when the config moved to
  // real ages, so every search failed claiming the control was wrong.
  const { adults, childAges } = bucketParty(trip).standard;
  const wanted = adults + childAges.length;
  if (wanted === 1) return { ok: true, confirmed: 1, via: 'default' };

  // The URL already asked for the party size in the query text, so the usual
  // case is that it is right before we touch anything.
  const fromUrl = await readPassengerCount(page);
  if (fromUrl === wanted) return { ok: true, confirmed: fromUrl, via: 'query' };

  // Fall back to driving the stepper. Best effort: if it does not end up on
  // the right number, the search fails rather than recording a wrong party.
  try {
    const opener = passengerControl(page);
    await opener.click({ timeout: 10000 });
    await addPassengers(page, 'adult', adults - 1);
    await addPassengers(page, 'child', childAges.length);

    const done = page.getByRole('button', { name: /^done$/i }).first();
    if (await done.isVisible({ timeout: 2500 }).catch(() => false)) {
      await done.click({ timeout: 5000 });
    } else {
      await page.keyboard.press('Escape');
    }
  } catch (err) {
    return {
      ok: false,
      reason:
        `Query text gave ${fromUrl ?? 'no readable'} passengers, expected ${wanted}, ` +
        `and the stepper fallback failed: ${err.message}`,
    };
  }

  const confirmed = await readPassengerCount(page);
  if (confirmed !== wanted) {
    return {
      ok: false,
      reason: `Passenger control reads ${confirmed ?? 'unknown'}, expected ${wanted}`,
    };
  }
  return { ok: true, confirmed, via: 'stepper' };
}

function passengerControl(page) {
  return page.locator('[aria-label*="passenger" i]').first();
}

/** Reads the party size off the passenger button, or null if unreadable. */
async function readPassengerCount(page) {
  try {
    const control = passengerControl(page);
    if (!(await control.isVisible({ timeout: 8000 }).catch(() => false))) return null;
    const label =
      (await control.getAttribute('aria-label')) ?? (await control.innerText());
    const found = String(label ?? '').match(/(\d+)/);
    return found ? Number(found[1]) : null;
  } catch {
    return null;
  }
}

async function addPassengers(page, kind, times) {
  for (let i = 0; i < times; i++) {
    const plus = page.locator(`[aria-label*="Add ${kind}" i]`).first();
    await plus.click({ timeout: 6000 });
    await page.waitForTimeout(200);
  }
}

/**
 * The first live run landed on a page titled "London to Orlando | Google
 * Flights" — the route parsed correctly — but with no fares anywhere in 1.9MB
 * of HTML and no "no flights" message either. That points at the URL preparing
 * the search without running it, so press Search if the button is there.
 * Absent is fine: results may already be loading.
 */
async function submitSearch(page) {
  try {
    const button = page
      .getByRole('button', { name: /^(search|explore)$/i })
      .first();
    if (await button.isVisible({ timeout: 4000 }).catch(() => false)) {
      await button.click({ timeout: 6000 });
      return true;
    }
  } catch {
    /* fall through — waitForResults decides whether this mattered */
  }
  return false;
}

async function waitForResults(page, timeoutMs) {
  // A price string is the only thing worth waiting for — the results container
  // renders long before it has any fares in it.
  try {
    await page.waitForFunction(
      () => /[£$€]\s?[\d,]{2,}/.test(document.body.innerText),
      undefined,
      { timeout: timeoutMs }
    );
    return { ok: true };
  } catch {
    const text = await page.innerText('body').catch(() => '');
    if (/no (flights|results|options) found|we could not find/i.test(text)) {
      return { ok: false, status: 'not_on_sale', reason: 'Google reports no flights for these dates' };
    }
    if (/unusual traffic|are you a robot|captcha/i.test(text)) {
      return { ok: false, status: 'blocked', reason: 'Google served a bot check' };
    }
    return { ok: false, status: 'no_prices_rendered', reason: 'No price text appeared before timeout' };
  }
}

/**
 * Google's CSS class names are obfuscated and rotate, so selecting on them
 * guarantees breakage. Result rows are found structurally instead, and each
 * row's visible text is mined for the fields we need.
 */
async function extractRows(page) {
  return page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('li, [role="listitem"]'));
    return items
      .map((el) => ({
        text: (el.innerText || '').replace(/\s+/g, ' ').trim(),
        label: el.getAttribute('aria-label') || '',
        href: el.querySelector('a')?.getAttribute('href') || null,
      }))
      .filter((r) => /[£$€]\s?[\d,]{2,}/.test(r.text) && r.text.length < 1200);
  });
}

export function parseRow(row, minPlausibleFare = 0) {
  const text = `${row.label} ${row.text}`;

  const price = text.match(/£\s?([\d,]+)/);
  if (!price) return null;
  const fare = Number(price[1].replace(/,/g, ''));
  if (!Number.isFinite(fare) || fare <= 0) return null;

  const times = [...text.matchAll(/\b(\d{1,2}:\d{2})\s?(AM|PM)?/gi)].map(
    (m) => `${m[1]}${m[2] ? ' ' + m[2].toUpperCase() : ''}`
  );

  const duration = text.match(/(\d+)\s*hr(?:\s*(\d+)\s*min)?/i);
  const durationMin = duration
    ? Number(duration[1]) * 60 + Number(duration[2] ?? 0)
    : null;

  // Google writes "Non-stop" with a hyphen, which an earlier /nonstop/ test
  // missed, leaving stops null on every direct flight.
  const stops = parseStops(text);

  const { carrier, carrierName } = matchCarrier(text);

  // A price on its own is not a flight. The first live run proved this the
  // expensive way: a stray "£28" elsewhere on the page was recorded as a
  // one-way Orlando to London fare for four people, with no carrier, no times
  // and no duration. An offer must look like one.
  const looksLikeFlight =
    carrier !== null || durationMin !== null || times.length >= 2;
  if (!looksLikeFlight) return null;

  // Second guard, on magnitude. Anything this far below a plausible
  // transatlantic fare is a parsing artefact, not a bargain.
  if (fare < minPlausibleFare) return null;

  return {
    fare,
    priceBasis: 'party_total',
    carrier,
    carrierName,
    fareBrand: null, // q= results do not expose a fare brand; see carrier-fees.yml
    stops,
    depLocal: times[0] ?? null,
    arrLocal: times[1] ?? null,
    durationMin,
    deepLink: row.href,
    rawText: row.text.slice(0, 400),
  };
}
