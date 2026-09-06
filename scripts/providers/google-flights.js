/**
 * Google Flights adapter.
 *
 * The guiding rule is that a wrong price is far worse than no price. A tracker
 * that silently records a one-adult fare as if it were the family total would
 * send you to book at the wrong moment. So every step that could go wrong
 * either confirms itself or fails the search outright, and the caller records
 * the failure rather than a number.
 */

const AIRLINE_CODES = {
  'British Airways': 'BA',
  'Virgin Atlantic': 'VS',
  'Norse Atlantic Airways': 'N0',
  'Norse Atlantic': 'N0',
  'American Airlines': 'AA',
  American: 'AA',
  Delta: 'DL',
  'Delta Air Lines': 'DL',
  United: 'UA',
  'Aer Lingus': 'EI',
  KLM: 'KL',
  'Air France': 'AF',
  Lufthansa: 'LH',
  Iberia: 'IB',
  Finnair: 'AY',
  'TUI Airways': 'TOM',
  Icelandair: 'FI',
  'Play': 'OG',
  JetBlue: 'B6',
};

export const PROVIDER = 'google_flights';

export async function search(page, { url, trip, passengers, timeoutMs = 45000 }) {
  const started = Date.now();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await dismissConsent(page);

    const partySet = await setPassengers(page, trip);
    if (!partySet.ok) {
      return fail('passenger_setup_failed', partySet.reason, page, started);
    }

    const ready = await waitForResults(page, timeoutMs);
    if (!ready.ok) return fail(ready.status, ready.reason, page, started);

    const rows = await extractRows(page);
    const offers = rows.map(parseRow).filter((o) => o !== null);

    if (offers.length === 0) {
      return fail(
        'no_offers_parsed',
        `Found ${rows.length} candidate rows but parsed no prices`,
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
 * The q= URL carries route and dates but not party size, so passengers are set
 * through the UI. This returns { ok } only once the control reports the party
 * we asked for; anything else fails the search.
 */
async function setPassengers(page, trip) {
  const wanted = trip.adults + (trip.children?.length ?? 0);
  if (wanted === 1) return { ok: true, confirmed: 1 };

  try {
    const opener = page
      .locator('[aria-label*="passenger" i], [aria-label*="Passengers" i]')
      .first();
    await opener.click({ timeout: 12000 });

    await addPassengers(page, 'Adult', trip.adults - 1);
    await addPassengers(page, 'Child', (trip.children ?? []).length);

    // Close the menu, then read back what the control now says.
    const done = page.getByRole('button', { name: /done/i }).first();
    if (await done.isVisible({ timeout: 3000 }).catch(() => false)) {
      await done.click({ timeout: 5000 });
    } else {
      await page.keyboard.press('Escape');
    }

    const label =
      (await opener.getAttribute('aria-label')) ?? (await opener.innerText());
    const found = String(label).match(/(\d+)/);
    const confirmed = found ? Number(found[1]) : null;

    if (confirmed !== wanted) {
      return {
        ok: false,
        reason: `Passenger control reads ${confirmed ?? 'unknown'}, expected ${wanted} (from "${label}")`,
      };
    }
    return { ok: true, confirmed };
  } catch (err) {
    return { ok: false, reason: `Could not set passengers: ${err.message}` };
  }
}

async function addPassengers(page, kind, times) {
  for (let i = 0; i < times; i++) {
    const plus = page
      .locator(`[aria-label*="Add ${kind}" i], button[aria-label*="${kind}" i]`)
      .filter({ hasText: /^$/ })
      .first();
    await plus.click({ timeout: 8000 });
    await page.waitForTimeout(180);
  }
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

export function parseRow(row) {
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

  const stops = /nonstop|direct/i.test(text)
    ? 0
    : (text.match(/(\d+)\s*stop/i) ? Number(text.match(/(\d+)\s*stop/i)[1]) : null);

  let carrier = null;
  let carrierName = null;
  for (const [name, code] of Object.entries(AIRLINE_CODES)) {
    if (text.includes(name)) {
      carrier = code;
      carrierName = name;
      break;
    }
  }

  return {
    fare,
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
