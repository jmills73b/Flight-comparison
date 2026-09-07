/**
 * How the browser is launched — one place, three named profiles.
 *
 * WHY THIS EXISTS
 * Three of the four airline adapters load the correct page and then never see
 * a price, even given 112 seconds. The page is right, the wait is long enough,
 * and a human running the identical URL gets results in a few seconds. That
 * pattern is not a parser bug: it is the site declining to serve inventory to
 * this browser. Both airlines front their search with a bot-detection layer,
 * and a stock headless Chromium launched by Playwright is about the most
 * recognisable client on the web — navigator.webdriver is true, the UA says
 * HeadlessChrome, there is no window chrome, no plugins, no WebGL vendor.
 *
 * So rather than guess at one fix and declare the problem architectural when
 * it fails, the launcher offers profiles that can be compared against each
 * other on the same URLs:
 *
 *   plain           stock headless Chromium. The control — this is what has
 *                   been failing, kept so a change can be measured against it.
 *   stealth         headless, plus puppeteer-extra's stealth evasions, which
 *                   patch the ~16 properties detectors look at first.
 *   stealth-headed  the same evasions in a REAL window on a virtual display
 *                   (xvfb), preferring Google Chrome over Chromium. Headless
 *                   is detectable in ways no script can patch — missing
 *                   renderer behaviour, no window manager — so this is the
 *                   closest thing to the browser that works by hand.
 *
 * Nothing here defeats a paywall or a login. It makes an automated browser
 * look like the ordinary one the same person would open by hand to read the
 * same public prices, which is what the site expects.
 */
import { chromium as playwrightChromium } from 'playwright';
import { chromium as extraChromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

export const PROFILES = ['plain', 'stealth', 'stealth-headed'];

export const DEFAULT_PROFILE = process.env.BROWSER_PROFILE || 'stealth';

/**
 * A headed browser does far more on startup than a headless one — sign-in,
 * variations, component update — and on a locked-down network some of that
 * can hang rather than fail. A stuck launch would otherwise eat the whole job
 * budget while looking like a slow site, so it gets a deadline and degrades to
 * headless, which is worse but is a result.
 */
const LAUNCH_TIMEOUT_MS = 90000;

async function launchWithin(launcher, options, ms) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`browser did not start within ${ms / 1000}s`)), ms);
  });
  try {
    return await Promise.race([launcher.launch(options), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

let stealthInstalled = false;

/**
 * The stealth plugin is registered once per process — `use()` is additive, so
 * calling it per launch would stack duplicate evasions.
 *
 * Two evasions are dropped deliberately, both because Playwright does the same
 * job better from the context:
 *
 *   user-agent-override   written against Puppeteer's page.setUserAgent, which
 *                         Playwright does not have, so it throws.
 *   navigator.languages   hardcodes en-US,en. This is a British party booking
 *                         on British sites with an en-GB locale, and a browser
 *                         claiming American languages while sending an en-GB
 *                         Accept-Language header is more suspicious than one
 *                         that never touched the property. The context locale
 *                         sets it correctly instead.
 */
function installStealth() {
  if (stealthInstalled) return;
  const stealth = StealthPlugin();
  stealth.enabledEvasions.delete('user-agent-override');
  stealth.enabledEvasions.delete('navigator.languages');
  extraChromium.use(stealth);
  stealthInstalled = true;
}

// A recent Chrome on macOS. Chosen to match what the evasions claim about
// platform and codecs — a UA that disagrees with the rest of the fingerprint
// is worse than no override at all.
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Launch a browser and a context ready for a search.
 *
 * Returns the profile actually used alongside the browser, because it may
 * differ from the one asked for: a headed profile with no display, or a
 * request for Chrome on a machine that only has Chromium, degrades rather
 * than failing the run — but it says so, so a result is never credited to a
 * profile that did not run.
 */
export async function launchBrowser({ profile = DEFAULT_PROFILE, locale = 'en-GB' } = {}) {
  if (!PROFILES.includes(profile)) {
    throw new Error(`Unknown browser profile "${profile}". Known: ${PROFILES.join(', ')}`);
  }

  const notes = [];
  let headed = profile === 'stealth-headed';

  // xvfb-run sets DISPLAY. Without one, a headed launch dies with a cryptic
  // "Missing X server" — fall back rather than fail, and say so.
  if (headed && !process.env.DISPLAY) {
    headed = false;
    notes.push('no DISPLAY, fell back to headless (run under xvfb-run)');
  }

  const useStealth = profile !== 'plain';
  if (useStealth) installStealth();
  const launcher = useStealth ? extraChromium : playwrightChromium;

  const args = ['--disable-blink-features=AutomationControlled'];
  if (headed) {
    args.push(
      // A real window, sized like a laptop. --start-maximized on a bare X
      // server with no window manager does nothing useful, so the size is
      // explicit.
      '--window-size=1440,1000',
      '--window-position=0,0',
      // A headed Chrome phones home on startup — sign-in, variations,
      // component updates — none of which a search page can observe, and all
      // of which cost seconds or hang outright behind a restrictive network.
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--metrics-recording-only'
    );
  }

  const base = {
    headless: !headed,
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args,
  };

  // Google Chrome carries proprietary codecs and branding that the open
  // Chromium build does not, and several detectors check exactly that. Only
  // worth the risk of a missing install on the headed profile, where the whole
  // point is maximum realism.
  let browser = null;
  if (headed && !process.env.CHROMIUM_PATH) {
    try {
      browser = await launchWithin(launcher, { ...base, channel: 'chrome' }, LAUNCH_TIMEOUT_MS);
      notes.push('using Google Chrome');
    } catch (e) {
      notes.push(`Chrome unavailable (${e.message.split('\n')[0]}), trying Chromium`);
    }
  }
  if (!browser && headed) {
    try {
      browser = await launchWithin(launcher, base, LAUNCH_TIMEOUT_MS);
    } catch (e) {
      notes.push(`headed launch failed (${e.message.split('\n')[0]}), fell back to headless`);
      headed = false;
    }
  }
  if (!browser) {
    browser = await launcher.launch({ ...base, headless: true, args });
  }

  const context = await browser.newContext({
    locale,
    timezoneId: 'Europe/London',
    // Headed uses the real window size — viewport null means "whatever the
    // window is", which is what a person's browser reports. Playwright rejects
    // deviceScaleFactor alongside it, and rightly: the real display decides.
    ...(headed
      ? { viewport: null }
      : { viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 }),
    userAgent: USER_AGENT,
    hasTouch: false,
    isMobile: false,
    // Accept-Language is deliberately NOT set by hand. Playwright derives it
    // from `locale`, so the header and navigator.languages always agree; an
    // override here is how they come to disagree.
  });

  const used = headed ? profile : profile === 'stealth-headed' ? 'stealth' : profile;
  return { browser, context, profile: used, requested: profile, notes };
}

/** One line describing what actually launched, for the top of a run's log. */
export function describeLaunch({ profile, requested, notes }) {
  const head = profile === requested ? profile : `${requested} → ${profile}`;
  return notes.length ? `browser: ${head} (${notes.join('; ')})` : `browser: ${head}`;
}
