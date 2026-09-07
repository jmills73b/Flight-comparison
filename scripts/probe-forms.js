/**
 * Form reconnaissance — run by hand, writes no price history.
 *
 * The evidence says the two failing pages are not valid cold entry points:
 * Virgin answers a deep link with "please go back and try the entry again",
 * and BA's multi-city results page waits on a request that never returns.
 * Both URLs were captured AFTER a search performed in a browser, so both
 * expect state the site created itself. The fix is to drive the search form
 * the way a person does.
 *
 * Writing those selectors from memory would repeat exactly the mistake that
 * cost the first week here — the invented BA and Virgin URLs, which only got
 * fixed when real ones were supplied. So this dumps what the forms ACTUALLY
 * contain: every control with its test id, name, aria-label, placeholder and
 * role, plus every button. The adapter is then written from the dump.
 *
 *   node scripts/probe-forms.js
 *   node scripts/probe-forms.js --only virgin
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { ROOT, loadConfig } from './lib/config.js';
import { launchBrowser, describeLaunch } from './lib/browser.js';
import { dismissConsent } from './providers/shared.js';

const cfg = loadConfig();
const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;

/**
 * `steps` are actions performed before the dump — a click, or typing into a
 * field. The fields that matter are behind them and simply do not exist in the
 * DOM until they are performed: Virgin's per-leg inputs appear only once
 * Multi-city is chosen, and an airport autocomplete list exists only while
 * something is being typed into it.
 *
 * Every selector below came out of a previous dump. None is from memory.
 */
const SITES = [
  {
    id: 'ba',
    label: 'British Airways — book a flight',
    url: 'https://www.britishairways.com/travel/home/public/en_gb/',
    consent: ['Accept all cookies', 'Accept all', 'I accept'],
  },
  {
    id: 'ba-multicity',
    label: 'British Airways — multi-city tab (the open-jaw entry point)',
    url: 'https://www.britishairways.com/travel/home/public/en_gb/',
    consent: ['Accept all cookies', 'Accept all', 'I accept'],
    // Clicking this by test id changed nothing twice over: afterwards the tab
    // still read aria-controls="" and tabindex="-1", the URL was unchanged and
    // Flights was still selected. So try it by its accessible name instead,
    // and report the tab state directly rather than inferring it from the
    // fields that did or did not appear.
    steps: [{ click: 'button[aria-label*="Multi city"]' }],
    report: 'tabs',
  },
  {
    id: 'virgin-multicity-airports',
    label: 'Virgin — multi-city, typing an airport (what does autocomplete offer?)',
    url: 'https://www.virginatlantic.com/en-gb',
    consent: ['Accept All Cookies', 'Accept all', 'I agree'],
    steps: [
      { click: '#trip_type' },
      { click: 'button:has-text("Multi-city")' },
      { type: ['#flights_from_0', 'London'] },
    ],
  },
  {
    id: 'virgin-multicity-dates',
    label: 'Virgin — multi-city, the date picker',
    url: 'https://www.virginatlantic.com/en-gb',
    consent: ['Accept All Cookies', 'Accept all', 'I agree'],
    steps: [
      { click: '#trip_type' },
      { click: 'button:has-text("Multi-city")' },
      { click: '#flights_departing_0' },
    ],
  },
  {
    id: 'virgin-passengers',
    label: 'Virgin — the passenger picker (2 adults, a 12 and a 9 year old)',
    url: 'https://www.virginatlantic.com/en-gb',
    consent: ['Accept All Cookies', 'Accept all', 'I agree'],
    steps: [{ click: '#flights_who' }],
  },
];

const sites = only ? SITES.filter((s) => s.id === only) : SITES;
const outDir = join(ROOT, 'data', 'probe');
mkdirSync(outDir, { recursive: true });

const launched = await launchBrowser({ locale: cfg.trip.locale });
const { browser, context } = launched;
console.log(`${describeLaunch(launched)}\n`);

for (const site of sites) {
  console.log(`── ${site.label}`);
  console.log(`   ${site.url}`);
  const page = await context.newPage();

  try {
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await dismissConsent(page, site.consent);
    // The search widget is usually the last thing to hydrate.
    await page.waitForTimeout(6000);

    for (const step of site.steps ?? []) {
      const before = page.url();
      const [action, arg] = Object.entries(step)[0];
      const selector = Array.isArray(arg) ? arg[0] : arg;

      // pressSequentially, not fill. fill() sets the value and fires one input
      // event; an airport combobox listens for keystrokes, so filling it looks
      // like nothing was typed — which is exactly why the first attempt at
      // this captured no suggestions at all. Click first so the field is
      // focused the way a person's would be.
      const done = await (action === 'type'
        ? page
            .locator(selector)
            .first()
            .click({ timeout: 15000 })
            .then(() =>
              page.locator(selector).first().pressSequentially(arg[1], { delay: 120 })
            )
        : page.locator(selector).first().click({ timeout: 15000 })
      )
        .then(() => true)
        .catch(() => false);

      // Whether a click NAVIGATES is the question the earlier dumps could not
      // answer. A control that changes the URL is an entry point in its own
      // right, and a better one than any URL captured after a search.
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2500);
      const after = page.url();
      console.log(
        `   ${action.padEnd(5)} ${selector}${action === 'type' ? ` = "${arg[1]}"` : ''}` +
          ` → ${done ? 'ok' : 'NOT FOUND'}`
      );
      if (after !== before) console.log(`         url CHANGED to ${after}`);
    }

    // Some questions are about a control's state, not about which fields
    // appeared — a tab that claims to be unselected after being clicked is
    // saying something the field list cannot.
    if (site.report === 'tabs') {
      const tabs = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid^="flight-search-tabs-li-"]')].map((e) => ({
          testid: e.getAttribute('data-testid'),
          selected: e.getAttribute('aria-selected'),
          controls: e.getAttribute('aria-controls'),
          tabindex: e.getAttribute('tabindex'),
          label: e.getAttribute('aria-label'),
        }))
      );
      console.log('   tabs');
      for (const t of tabs) {
        console.log(
          `     ${t.testid} selected=${t.selected} controls="${t.controls}" ` +
            `tabindex=${t.tabindex} label="${t.label}"`
        );
      }
    }

    // Read the controls out of the live DOM rather than the HTML source: these
    // are web-component sites, so the interesting attributes only exist after
    // hydration and are invisible in the served markup.
    const found = await page.evaluate(() => {
      const describe = (el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || undefined,
        testid: el.getAttribute('data-testid') || el.getAttribute('data-test') || undefined,
        id: el.id || undefined,
        name: el.getAttribute('name') || undefined,
        label: el.getAttribute('aria-label') || undefined,
        placeholder: el.getAttribute('placeholder') || undefined,
        role: el.getAttribute('role') || undefined,
        text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 50) || undefined,
        visible: !!(el.offsetWidth || el.offsetHeight),
      });
      const pick = (sel) => [...document.querySelectorAll(sel)].map(describe);
      return {
        inputs: pick('input, select, textarea'),
        buttons: pick('button, [role="button"], a[href*="search"]'),
        // Whatever a just-opened dropdown put on screen.
        options: [...document.querySelectorAll(
          '[role="option"], [role="menuitem"], [role="listbox"] *, li[data-testid], ul li'
        )]
          .filter((e) => e.offsetWidth || e.offsetHeight)
          .map((e) => (e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60))
          .filter(Boolean)
          .slice(0, 40),
        // Custom elements are where these sites keep the real widgets.
        customElements: [
          ...new Set(
            [...document.querySelectorAll('*')]
              .map((e) => e.tagName.toLowerCase())
              .filter((t) => t.includes('-'))
          ),
        ],
      };
    });

    const interesting = (c) =>
      c.visible &&
      /from|to|origin|destination|depart|return|date|passenger|adult|child|cabin|class|trip|way|search|city|airport/i.test(
        [c.testid, c.id, c.name, c.label, c.placeholder, c.text].filter(Boolean).join(' ')
      );

    const inputs = found.inputs.filter(interesting);
    const buttons = found.buttons.filter(interesting);

    console.log(`   ${found.inputs.length} controls, ${inputs.length} look like search fields`);
    for (const c of inputs.slice(0, 30)) {
      console.log(
        `     ${c.tag}${c.type ? `[${c.type}]` : ''} ` +
          [
            c.testid && `testid=${c.testid}`,
            c.id && `id=${c.id}`,
            c.name && `name=${c.name}`,
            c.label && `label="${c.label}"`,
            c.placeholder && `ph="${c.placeholder}"`,
          ]
            .filter(Boolean)
            .join(' ')
      );
    }
    if (found.options?.length) {
      console.log(`   ${found.options.length} options on screen`);
      console.log(`     ${found.options.join(' | ')}`);
    }
    console.log(`   ${buttons.length} candidate buttons`);
    for (const b of buttons.slice(0, 15)) {
      console.log(
        `     ${b.tag} ` +
          [b.testid && `testid=${b.testid}`, b.label && `label="${b.label}"`, b.text && `"${b.text}"`]
            .filter(Boolean)
            .join(' ')
      );
    }

    writeFileSync(
      join(outDir, `form-${site.id}.json`),
      JSON.stringify(found, null, 2)
    );
    const html = await page.content();
    writeFileSync(join(outDir, `form-${site.id}.html.gz`), gzipSync(Buffer.from(html)));
    console.log(`   saved    data/probe/form-${site.id}.json and .html.gz`);
  } catch (e) {
    console.log(`   FAILED   ${e.message.split('\n')[0]}`);
  }

  console.log();
  await page.close();
  await new Promise((r) => setTimeout(r, 4000));
}

await browser.close();
console.log('Write the form-driving selectors from these dumps, not from memory.');
