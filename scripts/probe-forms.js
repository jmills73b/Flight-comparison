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

const SITES = [
  {
    id: 'ba',
    label: 'British Airways — book a flight',
    url: 'https://www.britishairways.com/travel/home/public/en_gb/',
    consent: ['Accept all cookies', 'Accept all', 'I accept'],
  },
  {
    id: 'virgin',
    label: 'Virgin Atlantic — homepage search',
    url: 'https://www.virginatlantic.com/en-gb',
    consent: ['Accept All Cookies', 'Accept all', 'I agree'],
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
