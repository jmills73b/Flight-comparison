/**
 * Virgin Atlantic, driven through its own search form.
 *
 * WHY NOT A URL
 * Virgin answers a constructed search URL with "We're sorry, there was a
 * problem processing your request. Please go back and try the entry again."
 * The URL is real — it was captured from a search performed in a browser — but
 * it carries session state Virgin creates itself, so it is not a cold entry
 * point and never will be. The homepage form is. This fills it in the way a
 * person does and presses Search.
 *
 * EVERY SELECTOR HERE CAME OUT OF A DUMP of the live DOM, saved under
 * data/probe/form-virgin*.json. None is from memory. That distinction is the
 * whole reason this file exists: the invented BA and Virgin URLs cost a week
 * and were only fixed when real ones were supplied.
 *
 *   #trip_type                     opens One way / Round trip / Multi-city
 *   #flights_from,   #flights_to   round trip
 *   #flights_from_0, #flights_to_0 multi-city leg 1  (_1 for leg 2)
 *   #flights_departing[_n]         the date field
 *   #flights_who                   opens adults-plus-btn / children-plus-btn
 *   "Search flights"               submits
 *
 * WHAT IS STILL UNKNOWN is what the airport autocomplete offers, what the date
 * field accepts, and whether child ages are asked for. So every step reports
 * what it saw and what it chose, and a step that cannot find its control fails
 * by name rather than pressing on. A failed run should say which control and
 * what was on screen instead, so the next attempt is a fix and not a guess.
 */
import { dismissConsent, waitForPrice, fail, filterByStops, stopsReason } from './shared.js';
import { parseRow } from './airline-direct.js';

const HOME = 'https://www.virginatlantic.com/en-gb';

/** What to type for each airport, and which suggestion to prefer. */
const AIRPORT_QUERY = {
  LON: { type: 'London', prefer: /all airports|LON/i },
  LHR: { type: 'Heathrow', prefer: /LHR/i },
  LGW: { type: 'Gatwick', prefer: /LGW/i },
  MCO: { type: 'Orlando', prefer: /international|MCO/i },
  TPA: { type: 'Tampa', prefer: /TPA/i },
  MIA: { type: 'Miami', prefer: /MIA/i },
};

/** Every place a combobox might put its suggestions. Widened deliberately. */
const OPTION_SELECTORS = [
  '[role="option"]',
  '[role="listbox"] li',
  '[role="listbox"] button',
  'ul[id*="listbox"] li',
  'li[id*="option"]',
  '[class*="suggestion"] li',
  '[class*="autocomplete"] li',
];

async function visibleOptions(page) {
  return page.evaluate((selectors) => {
    const seen = new Set();
    const out = [];
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (!(el.offsetWidth || el.offsetHeight)) continue;
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text || seen.has(text)) continue;
        seen.add(text);
        out.push({ text: text.slice(0, 80), selector: sel });
      }
    }
    return out.slice(0, 25);
  }, OPTION_SELECTORS);
}

/**
 * Type into an airport combobox and choose a suggestion.
 *
 * pressSequentially, not fill: fill() sets a value and fires one input event,
 * where a combobox listens for keystrokes. An earlier attempt used fill() and
 * captured no suggestions at all, which looked like the site refusing and was
 * actually the page never being told anything had been typed.
 */
async function chooseAirport(page, selector, iata, log) {
  const q = AIRPORT_QUERY[iata];
  if (!q) return { ok: false, why: `no search text known for ${iata}` };

  const field = page.locator(selector).first();
  if (!(await field.count())) return { ok: false, why: `${selector} not on the page` };

  await field.click({ timeout: 15000 });
  await field.fill('');
  await field.pressSequentially(q.type, { delay: 120 });
  await page.waitForTimeout(2000);

  const options = await visibleOptions(page);
  log(`${selector} typed "${q.type}" → ${options.length} suggestions` +
      (options.length ? `: ${options.slice(0, 6).map((o) => o.text).join(' | ')}` : ''));

  if (!options.length) return { ok: false, why: `no suggestions for "${q.type}"` };

  const chosen = options.find((o) => q.prefer.test(o.text)) ?? options[0];
  await page
    .locator(chosen.selector)
    .filter({ hasText: chosen.text.slice(0, 30) })
    .first()
    .click({ timeout: 10000 })
    .catch(async () => {
      // Falling back to the keyboard is legitimate: it is how the control is
      // meant to be used, and it sidesteps an overlay intercepting the click.
      await field.press('ArrowDown');
      await field.press('Enter');
    });
  await page.waitForTimeout(800);
  log(`${selector} chose "${chosen.text}"`);
  return { ok: true, chosen: chosen.text };
}

/**
 * Set the date. The field is a plain text input, so typing is tried first —
 * it is far more robust than driving a calendar across month boundaries. The
 * calendar is the fallback, and its day buttons are labelled "2nd of October",
 * which is what the dump showed.
 */
async function chooseDate(page, selector, iso, log) {
  const field = page.locator(selector).first();
  if (!(await field.count())) return { ok: false, why: `${selector} not on the page` };

  const [y, m, d] = iso.split('-').map(Number);
  const uk = `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;

  await field.click({ timeout: 15000 });
  await page.waitForTimeout(500);
  await field.pressSequentially(uk, { delay: 90 }).catch(() => {});
  await page.waitForTimeout(800);

  const typed = await field.inputValue().catch(() => '');
  if (typed && /\d/.test(typed)) {
    log(`${selector} typed "${uk}" → field reads "${typed}"`);
    await field.press('Escape').catch(() => {});
    return { ok: true, via: 'typed' };
  }

  // Calendar fallback: page forward to the right month, then click the day.
  const monthName = new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-GB', {
    month: 'long',
    timeZone: 'UTC',
  });
  const ordinal =
    d % 10 === 1 && d !== 11 ? 'st' : d % 10 === 2 && d !== 12 ? 'nd' : d % 10 === 3 && d !== 13 ? 'rd' : 'th';
  const dayLabel = `${d}${ordinal} of ${monthName}`;

  for (let hop = 0; hop < 26; hop++) {
    const day = page.locator(`button[aria-label="${dayLabel}"]`).first();
    if (await day.count()) {
      await day.click({ timeout: 8000 });
      log(`${selector} clicked "${dayLabel}" after ${hop} month hops`);
      return { ok: true, via: 'calendar' };
    }
    const next = page
      .locator('button[aria-label*="Next month" i], button[aria-label*="next month" i]')
      .first();
    if (!(await next.count())) break;
    await next.click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(350);
  }
  return { ok: false, why: `could not reach "${dayLabel}" in the calendar` };
}

/**
 * Set the party. The homepage widget offers adults and children only — no
 * "teens" band, unlike the deep link's a2t1c1i0 — so the 12 year old is a
 * child here. If ages are asked for, they are given; the real ages are what
 * the config stores, precisely so each provider can bucket them its own way.
 */
async function choosePassengers(page, party, log) {
  const who = page.locator('#flights_who').first();
  if (!(await who.count())) return { ok: false, why: '#flights_who not on the page' };
  await who.click({ timeout: 15000 });
  await page.waitForTimeout(1200);

  const bump = async (testid, times, label) => {
    const btn = page.locator(`[data-testid="${testid}"]`).first();
    if (!(await btn.count())) return `${testid} missing`;
    for (let i = 0; i < times; i++) {
      await btn.click({ timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(250);
    }
    log(`${label}: pressed ${testid} ${times}×`);
    return null;
  };

  // The widget starts at 1 adult, 0 children.
  const wantAdults = party.virgin.adults;
  const childAges = [
    ...Array(party.virgin.teens).fill(null),
    ...Array(party.virgin.children).fill(null),
  ].length;

  const e1 = await bump('adults-plus-btn', Math.max(0, wantAdults - 1), 'adults');
  const e2 = await bump('children-plus-btn', childAges, 'children');
  if (e1 || e2) return { ok: false, why: [e1, e2].filter(Boolean).join('; ') };

  // Ages, if asked for. Unknown until a run sees them, so it is reported
  // either way rather than assumed absent.
  const ageSelects = page.locator('select[id*="age" i], select[name*="age" i]');
  const ageCount = await ageSelects.count();
  log(`age selects on screen: ${ageCount}`);
  if (ageCount) {
    const ages = ['12', '9'];
    for (let i = 0; i < Math.min(ageCount, ages.length); i++) {
      await ageSelects.nth(i).selectOption(ages[i]).catch(() => {});
    }
  }

  await page.keyboard.press('Escape').catch(() => {});
  return { ok: true };
}

/**
 * Drive the whole search.
 *
 * `legs` is one entry for a one-way, two for a return or an open jaw. A return
 * and an open jaw differ only in whether leg two starts where leg one landed,
 * so both go through Multi-city, which states each leg explicitly and cannot
 * quietly assume the return airport.
 */
export async function searchVirginByForm(page, { trip, party, passengers, legs, timeoutMs = 45000 }) {
  const started = Date.now();
  const steps = [];
  const log = (m) => {
    steps.push(m);
    console.log(`      · ${m}`);
  };

  const stop = (status, why) => {
    log(`FAILED at: ${why}`);
    return fail(status, `${why} (steps: ${steps.length})`, page, started);
  };

  try {
    await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await dismissConsent(page, ['Accept All Cookies', 'Accept all', 'I agree']);
    await page.waitForTimeout(3000);

    const tripType = page.locator('#trip_type').first();
    if (!(await tripType.count())) return stop('form_missing', '#trip_type not on the homepage');
    await tripType.click({ timeout: 15000 });
    await page.waitForTimeout(1200);

    const wanted = legs.length > 1 ? 'Multi-city' : 'One way';
    const option = page.locator(`button:has-text("${wanted}")`).first();
    if (!(await option.count())) return stop('form_missing', `no "${wanted}" option in #trip_type`);
    await option.click({ timeout: 15000 });
    await page.waitForTimeout(2000);
    log(`journey type: ${wanted}`);

    // Multi-city numbers its fields from zero; a single leg uses the plain ids.
    const multi = legs.length > 1;
    for (const [i, leg] of legs.entries()) {
      const suffix = multi ? `_${i}` : '';
      const from = await chooseAirport(page, `#flights_from${suffix}`, leg.from, log);
      if (!from.ok) return stop('form_airport_failed', `leg ${i + 1} origin — ${from.why}`);
      const to = await chooseAirport(page, `#flights_to${suffix}`, leg.to, log);
      if (!to.ok) return stop('form_airport_failed', `leg ${i + 1} destination — ${to.why}`);
      const when = await chooseDate(page, `#flights_departing${suffix}`, leg.date, log);
      if (!when.ok) return stop('form_date_failed', `leg ${i + 1} date — ${when.why}`);
    }

    const who = await choosePassengers(page, party, log);
    if (!who.ok) return stop('form_passengers_failed', who.why);

    const submit = page.locator('button:has-text("Search flights")').first();
    if (!(await submit.count())) return stop('form_missing', 'no "Search flights" button');
    await submit.click({ timeout: 15000 });
    log('submitted');

    await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => {});
    const ready = await waitForPrice(page, timeoutMs * 2);
    if (!ready.ok) {
      const body = await page.innerText('body').catch(() => '');
      if (/problem processing your request|please go back and try/i.test(body)) {
        return stop('request_rejected', 'Virgin rejected the search even from its own form');
      }
      return stop(ready.status, ready.reason);
    }

    const rows = await page.evaluate(() =>
      Array.from(document.querySelectorAll('li, tr, article, [class*="flight"], [class*="fare"]'))
        .map((el) => ({
          text: (el.innerText || '').replace(/\s+/g, ' ').trim(),
          href: el.querySelector('a')?.getAttribute('href') || null,
        }))
        .filter((r) => /£\s?[\d,]{2,}/.test(r.text) && r.text.length > 20 && r.text.length < 1200)
    );
    const parsed = rows
      .map((r) => parseRow(r, passengers, { code: 'VS', name: 'Virgin Atlantic' }))
      .filter(Boolean);

    const dropped = filterByStops(parsed, trip.max_stops);
    if (!dropped.kept.length && parsed.length) {
      return stop('no_offers_within_stop_limit', stopsReason(trip.max_stops, dropped));
    }
    if (!dropped.kept.length) return stop('no_offers_parsed', 'No offer survived validation');

    log(`parsed ${dropped.kept.length} direct offers from ${rows.length} rows`);
    return {
      status: 'ok',
      offers: dropped.kept,
      html: await page.content().catch(() => null),
      elapsedMs: Date.now() - started,
      steps,
    };
  } catch (e) {
    return stop('form_error', e.message.split('\n')[0]);
  }
}
