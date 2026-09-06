/**
 * Parsing and safety helpers shared by every provider adapter.
 *
 * Four adapters repeating this would drift apart, and the rules here are the
 * ones that keep bad data out — they need to be identical everywhere.
 */

/**
 * Longest names first, matched on word boundaries. Bare "United" and
 * "American" are deliberately absent: a captured Google page contained
 * "United Kingdom", "United States" and "United Arab Emirates" 23 times
 * between them, and a looser matcher labelled those offers United Airlines.
 */
export const AIRLINE_CODES = [
  ['Norse Atlantic Airways', 'N0'],
  ['Norse Atlantic UK', 'N0'],
  ['Norse Atlantic', 'N0'],
  ['American Airlines', 'AA'],
  ['United Airlines', 'UA'],
  ['Delta Air Lines', 'DL'],
  ['British Airways', 'BA'],
  ['Virgin Atlantic', 'VS'],
  ['Aer Lingus', 'EI'],
  ['Air France', 'AF'],
  ['TUI Airways', 'TOM'],
  ['Icelandair', 'FI'],
  ['Lufthansa', 'LH'],
  ['JetBlue', 'B6'],
  ['Finnair', 'AY'],
  ['Iberia', 'IB'],
  ['Delta', 'DL'],
  ['KLM', 'KL'],
];

export function matchCarrier(text) {
  for (const [name, code] of AIRLINE_CODES) {
    if (new RegExp(`\\b${name}\\b`, 'i').test(text)) return { carrier: code, carrierName: name };
  }
  return { carrier: null, carrierName: null };
}

/** Handles "Non-stop", "Nonstop" and "Direct" — the hyphen cost a run. */
export function parseStops(text) {
  if (/non-?\s?stop|direct/i.test(text)) return 0;
  const m = text.match(/(\d+)\s*stop/i);
  return m ? Number(m[1]) : null;
}

export function parseDuration(text) {
  const m = text.match(/(\d+)\s*h(?:r|rs|our|ours)?\.?\s*(?:(\d+)\s*m)?/i);
  return m ? Number(m[1]) * 60 + Number(m[2] ?? 0) : null;
}

export function parseTimes(text) {
  return [...text.matchAll(/\b(\d{1,2}:\d{2})\s?(AM|PM)?/gi)].map(
    (m) => `${m[1]}${m[2] ? ' ' + m[2].toUpperCase() : ''}`
  );
}

export function parseMoney(text) {
  const m = text.match(/£\s?([\d,]+)/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * A price on its own is not a flight. A stray "£28" was once recorded as a
 * one-way Orlando to London fare for four people; this is the rule that stops
 * it, and every adapter applies it.
 */
export function looksLikeFlight({ carrier, durationMin, times }) {
  return carrier !== null || durationMin !== null || (times?.length ?? 0) >= 2;
}

/**
 * Challenge pages are ordinary HTML, so without looking for them explicitly
 * they parse as "a page with no flights" — indistinguishable from an empty
 * market, which is the confusion that cost several rounds on Google.
 */
export async function detectBlock(page) {
  const text = await page.innerText('body').catch(() => '');
  const patterns = [
    [/press\s*(&|and)\s*hold/i, 'Press & Hold challenge'],
    [/verify (you are|you're) (a )?human/i, 'Human verification'],
    [/unusual traffic|automated queries/i, 'Unusual traffic block'],
    [/access denied|request blocked/i, 'Access denied'],
    [/checking your browser|just a moment/i, 'Cloudflare interstitial'],
    [/enable javascript and cookies/i, 'JS/cookie gate'],
  ];
  for (const [re, name] of patterns) if (re.test(text)) return name;
  const title = await page.title().catch(() => '');
  if (/just a moment|attention required|access denied/i.test(title)) {
    return `Challenge page: ${title}`;
  }
  return null;
}

export async function fail(status, reason, page, started) {
  let html = null;
  try {
    html = await page.content();
  } catch {
    /* page may be gone; the reason still says what happened */
  }
  return { status, reason, offers: [], elapsedMs: Date.now() - started, html };
}

export async function dismissConsent(page, labels = ['Accept all', 'Accept All Cookies', 'Accept all cookies', 'I agree', 'Got it', 'Allow all']) {
  for (const label of labels) {
    try {
      const b = page.getByRole('button', { name: label, exact: false }).first();
      if (await b.isVisible({ timeout: 2000 })) {
        await b.click({ timeout: 5000 });
        await page.waitForTimeout(800);
        return true;
      }
    } catch {
      /* usually absent */
    }
  }
  return false;
}

export async function waitForPrice(page, timeoutMs) {
  try {
    await page.waitForFunction(
      () => /£\s?[\d,]{2,}/.test(document.body.innerText),
      undefined,
      { timeout: timeoutMs }
    );
    return { ok: true };
  } catch {
    const text = await page.innerText('body').catch(() => '');
    if (/no flights|no results|couldn'?t find|not available for these dates/i.test(text)) {
      return { ok: false, status: 'not_on_sale', reason: 'Provider reports no flights for these dates' };
    }
    return { ok: false, status: 'no_prices_rendered', reason: 'No price appeared before timeout' };
  }
}
