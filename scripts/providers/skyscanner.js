/**
 * Skyscanner adapter.
 *
 * Added because Google carries no August 2027 inventory yet while Skyscanner
 * does, aggregating OTAs and consolidators that sell further ahead.
 *
 * THE PRICE BASIS DIFFERS FROM GOOGLE. Skyscanner quotes per person; Google
 * quotes the party total. Every offer here is multiplied up to a party total
 * and stamped with `priceBasis`, because mixing the two silently would be a
 * fourfold error in the direction that makes a fare look like a bargain.
 *
 * Skyscanner also runs far more aggressive bot protection than Google. Being
 * blocked from a datacentre IP is an expected outcome, not a surprise, so it
 * is reported as its own status rather than looking like an empty market.
 */

const AIRLINE_CODES = [
  ['Norse Atlantic Airways', 'N0'],
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

export const PROVIDER = 'skyscanner';

export async function search(page, { url, trip, passengers, timeoutMs = 60000 }) {
  const started = Date.now();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await dismissConsent(page);

    const blocked = await detectBlock(page);
    if (blocked) return fail('blocked', blocked, page, started);

    const ready = await waitForResults(page, timeoutMs);
    if (!ready.ok) return fail(ready.status, ready.reason, page, started);

    // Guard again after results settle: the challenge can appear late.
    const lateBlock = await detectBlock(page);
    if (lateBlock) return fail('blocked', lateBlock, page, started);

    const rows = await extractRows(page);
    // Per person, so the floor is per person too — £50 for a transatlantic
    // leg is already implausibly low, which is the point.
    const minPerPerson = 50;
    const offers = rows
      .map((r) => parseRow(r, minPerPerson, passengers))
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
}

async function fail(status, reason, page, started) {
  let html = null;
  try {
    html = await page.content();
  } catch {
    /* page may be gone; the reason still says what happened */
  }
  return { status, reason, offers: [], elapsedMs: Date.now() - started, html };
}

async function dismissConsent(page) {
  for (const label of ['Accept all', 'Accept All', 'I agree', 'Got it']) {
    try {
      const b = page.getByRole('button', { name: label, exact: false }).first();
      if (await b.isVisible({ timeout: 2500 })) {
        await b.click({ timeout: 5000 });
        return true;
      }
    } catch {
      /* usually absent */
    }
  }
  return false;
}

/**
 * Skyscanner's challenge pages are ordinary HTML, so they parse as "a page
 * with no flights" unless looked for explicitly. Being told we were blocked is
 * far more useful than being told the market is empty.
 */
async function detectBlock(page) {
  const text = await page.innerText('body').catch(() => '');
  const patterns = [
    [/press\s*(&|and)\s*hold/i, 'Press & Hold challenge'],
    [/verify (you are|you're) (a )?human/i, 'Human verification challenge'],
    [/unusual traffic|automated queries/i, 'Unusual traffic block'],
    [/access denied|blocked/i, 'Access denied'],
    [/checking your browser/i, 'Cloudflare interstitial'],
  ];
  for (const [re, name] of patterns) if (re.test(text)) return name;

  const title = await page.title().catch(() => '');
  if (/just a moment|attention required/i.test(title)) return `Challenge page: ${title}`;
  return null;
}

async function waitForResults(page, timeoutMs) {
  try {
    // Skyscanner streams results in, so wait for a price rather than for the
    // network to go idle — it may never fully settle.
    await page.waitForFunction(
      () => /£\s?[\d,]{2,}/.test(document.body.innerText),
      undefined,
      { timeout: timeoutMs }
    );
    // Let the list finish populating before reading it.
    await page.waitForTimeout(3500);
    return { ok: true };
  } catch {
    const text = await page.innerText('body').catch(() => '');
    if (/no flights found|no results|couldn't find any flights/i.test(text)) {
      return { ok: false, status: 'not_on_sale', reason: 'Skyscanner reports no flights for these dates' };
    }
    return { ok: false, status: 'no_prices_rendered', reason: 'No price appeared before timeout' };
  }
}

async function extractRows(page) {
  return page.evaluate(() => {
    const nodes = Array.from(
      document.querySelectorAll('[class*="FlightsTicket"], [data-testid*="itinerary"], li, article')
    );
    return nodes
      .map((el) => ({
        text: (el.innerText || '').replace(/\s+/g, ' ').trim(),
        href: el.querySelector('a')?.getAttribute('href') || null,
      }))
      .filter((r) => /£\s?[\d,]{2,}/.test(r.text) && r.text.length > 20 && r.text.length < 1200);
  });
}

export function parseRow(row, minPerPerson, passengers) {
  const text = row.text;

  const price = text.match(/£\s?([\d,]+)/);
  if (!price) return null;
  const perPerson = Number(price[1].replace(/,/g, ''));
  if (!Number.isFinite(perPerson) || perPerson < minPerPerson) return null;

  const times = [...text.matchAll(/\b(\d{1,2}:\d{2})\b/g)].map((m) => m[1]);
  const duration = text.match(/(\d+)\s*h(?:r|ours?)?\s*(?:(\d+)\s*m)?/i);
  const durationMin = duration
    ? Number(duration[1]) * 60 + Number(duration[2] ?? 0)
    : null;
  const stops = /direct|non-?stop/i.test(text)
    ? 0
    : text.match(/(\d+)\s*stop/i)
      ? Number(text.match(/(\d+)\s*stop/i)[1])
      : null;

  let carrier = null;
  for (const [name, code] of AIRLINE_CODES) {
    if (new RegExp(`\\b${name}\\b`, 'i').test(text)) {
      carrier = code;
      break;
    }
  }

  // Same rule as the Google adapter: a price alone is not a flight.
  if (carrier === null && durationMin === null && times.length < 2) return null;

  return {
    // Normalised to a party total so it is directly comparable with Google.
    fare: perPerson * passengers,
    perPersonFare: perPerson,
    priceBasis: 'per_person_x_passengers',
    carrier,
    fareBrand: null,
    stops,
    depLocal: times[0] ?? null,
    arrLocal: times[1] ?? null,
    durationMin,
    deepLink: row.href,
    rawText: text.slice(0, 400),
  };
}
