# Florida 2027 — Flight Price Tracker

> **RETIRED — 8 September 2026.** This project has been decommissioned and the
> collection schedule removed. It is kept as a record of what was built and,
> more usefully, of what was ruled out and how. README.md has the short version;
> the sections below are the working detail, left as written rather than tidied
> up after the fact.


Design document, written before the code and kept current as it was built.

A single-purpose price tracker for one specific family holiday: London → Florida,
August 2027. Not a general-purpose flight search tool. Every design decision below
is optimised for tracking a small, fixed set of itineraries over ~11 months and
answering one question: **when and on which routing do we book?**

---

## 1. The trip

| | |
|---|---|
| Outbound | London (Gatwick or Heathrow) on **11 Aug 2027** or **12 Aug 2027** |
| Arrive | **Tampa (TPA)** or **Orlando (MCO)** |
| Return — option A | **19 Aug 2027** from TPA or MCO |
| Return — option B | **22 Aug 2027** from **Miami (MIA)** |
| Passengers | 3 adults + 1 child (see §2) |
| Bags | Hold luggage required — 1 checked bag per person |
| Cabin | Economy (assumed — see open questions) |

Option B is an **open-jaw** itinerary: fly into Tampa or Orlando, drive south,
fly home from Miami. It is a longer trip (11–12 nights vs 8–9) and is priced
quite differently from a round trip.

### Passenger configuration

Ages are **at date of travel** (Aug 2027): one child aged 9, one aged 12.

Airline child fare bands almost universally run **2–11 inclusive**. British Airways
and Virgin Atlantic both end the child band at 11. A 12-year-old therefore books
as an **adult**.

```yaml
adults: 3          # 2 parents + the 12-year-old
children: [9]      # the 9-year-old only
infants: 0
checked_bags: 4    # one per person
```

> Treat this as a config value, not a constant. If any tracked carrier turns out
> to define a child as 2–12, that carrier's search should be re-run as
> `adults: 2, children: [9, 12]`. The difference on a peak-August transatlantic
> fare is material — typically several hundred pounds.

---

## 2. Timing — why this starts now

As of **6 Sep 2026**, the travel dates are **339–350 days out**:

| Date | Days out |
|---|---|
| 11 Aug 2027 (outbound) | 339 |
| 12 Aug 2027 (outbound) | 340 |
| 19 Aug 2027 (return A) | 347 |
| 22 Aug 2027 (return B) | 350 |

Airlines load schedules roughly **330–355 days ahead**, so these dates sit right on
the boundary. Carriers with a 355-day horizon should already be bookable; those at
330 days will not be. The **22 Aug Miami return is the last to open** — expect it
around **late September 2026**.

Two consequences for the design:

1. The tracker must handle "no results yet" as a normal, expected outcome rather
   than an error, and should record it so we can see exactly when each route came
   on sale.
2. Starting now is the point. For peak-August family transatlantic, the initial
   schedule load is very often the cheapest the fare ever gets, before school
   holiday demand builds. Capturing that first data point is the main value of
   the whole project.

---

## 3. Data sources

### The constraint

**There is no longer a free flight pricing API.** Amadeus shut down its
Self-Service tier — the standard answer for hobby projects, 2,000 free searches a
month — on **17 July 2026**. What remains:

| Source | Status |
|---|---|
| Amadeus Self-Service | Dead (Jul 2026). Enterprise needs IATA/ARC accreditation. |
| Skyscanner | No free public API. Affiliate access is approval-gated. |
| Google Flights | No API since QPX was retired in 2018. |
| Duffel / Kiwi Tequila | Partner-gated. |
| FlightAPI.io | ~20 call trial, then $49/mo. |
| Travelpayouts | Free, but **cached** aggregate data — too stale and too coarse for a specific 4-passenger itinerary with bags. |

Since the requirement is *free* and *specific*, **browser automation is the only
viable route**. That single fact drives the platform choice in §4.

### Chosen sources

**Primary — Google Flights via Playwright.** Prices the exact passenger mix and
exposes carrier, times, stops and duration. Best single source by a distance.

> **How the search URL is built.** Google packs a whole search into a `tfs`
> parameter — a base64url protobuf whose schema is private and reverse-engineered.
> Building that by hand would be more precise, but a wrong field number produces a
> valid-looking URL that quietly searches for *something else*, which is the worst
> possible failure for a price tracker. So the adapter uses Google's `q=` form
> instead: readable, and checkable by pasting it into a browser (`npm run urls`).
>
> The one thing `q=` cannot express is a multi-city open jaw. That costs nothing
> today, because the seven one-way legs already price all twelve itineraries as
> split tickets. Single-ticket pricing for the eight open jaws needs the
> multi-city UI, and is phase 3.

**Secondary — direct airline sites.** For LON→TPA/MCO the realistic field is
British Airways, Virgin Atlantic and Norse Atlantic. Direct scrapes are more
reliable and give authoritative baggage rules. Worth adding once the primary works.

**Third — TUI (charter).** TUI sells UK→Florida seats that are **invisible to
Google Flights and Skyscanner**, because charter inventory isn't distributed
through the GDS. For UK→Florida in August they are frequently competitive, so this
gets its own adapter rather than a manual reminder.

Three things about TUI change how it must be searched:

- **Gatwick only.** TUI does not operate from Heathrow. Every TUI search is
  `LGW`, never the `LON` metro code.
- **Weekly rotations.** Charter aircraft fly fixed weekly patterns, so TUI sells
  mostly **7 and 14 night** durations. Of our four date pairs, only
  **12 Aug → 19 Aug (7 nights, Thu→Thu)** fits cleanly. The 8, 10 and 11 night
  combinations may simply not be offered, and a "no such duration" result is
  expected rather than a bug.
- **Orlando means two airports.** TUI has historically flown to Orlando *Sanford*
  (**SFB**) as well as Orlando International (MCO), so **both are searched**
  (confirmed). SFB is ~45 minutes from the parks and is a charter/leisure airport —
  which is why it is scoped to TUI only and not added to the scheduled matrix,
  where UK→SFB service effectively doesn't exist. Tampa service by TUI is not
  assumed and is probed rather than relied on.

### Legal note

Scraping Google Flights is contrary to its Terms of Service. At twice-daily volume
for a single personal holiday this is the mild end of that, but it is a real
consideration, it is why the scrapers must be rate-limited and polite, and it is
why they will occasionally break without warning.

---

## 4. Architecture

GitHub Actions on a **public** repository, which is decisive:

| | Cloudflare free tier | GitHub Actions (public repo) |
|---|---|---|
| Browser time | 10 min/day | Effectively unlimited |
| Playwright | Constrained | Full, standard |
| Price history | Needs D1 (5M reads/day, now hard-enforced) | **Git history is the time series** |
| Dashboard hosting | Pages | Pages |
| Cost | £0 | £0 |

Because there is no free API, browser minutes are the binding constraint — and
Cloudflare's 10 minutes a day cannot support 24 searches. GitHub Actions can.

Two constraints worth recording:

- **Scheduled workflows do not run on private repos on the Free plan.** This repo
  is public, so this is fine. Making it private later would require GitHub Pro
  (~$4/mo) or the schedule silently stops.
- **Scheduled workflows are auto-disabled after 60 days of repo inactivity.** Not
  an issue here: the workflow commits a data file on every run, which counts as
  activity and continuously resets the timer.

```
┌─────────────────────┐
│ Actions cron (2×/day)│
└──────────┬───────────┘
           │
    ┌──────▼───────┐   Playwright   ┌──────────────────┐
    │   collector  │───────────────▶│  Google Flights  │
    └──────┬───────┘                └──────────────────┘
           │ normalise
    ┌──────▼─────────────────────────┐
    │ data/snapshots/<ts>.json (raw) │
    │ data/history.csv    (appended) │
    └──────┬─────────────────────────┘
           │ git commit + push
    ┌──────▼───────┐
    │ GitHub Pages │  docs/index.html — charts + comparison table
    └──────────────┘
```

---

## 4a. How the browser is launched

Three of the four airline adapters loaded the correct page and then never saw a
price, even given 112 seconds. The page was right, the wait was long enough,
and the same URL in a real browser returns results in seconds. That is not a
parser bug — it is the site declining to serve inventory to this browser. Both
airlines front their search with bot detection, and stock headless Chromium
launched by Playwright is one of the most recognisable clients on the web: no
window, no plugins, no WebGL vendor, a user agent that says HeadlessChrome.

`scripts/lib/browser.js` is the single place a browser is launched, and it
offers three named profiles so a fix can be **measured** rather than assumed:

| Profile | What it is |
|---|---|
| `plain` | Stock headless Chromium — the control, i.e. what has been failing |
| `stealth` | Headless plus puppeteer-extra's stealth evasions |
| `stealth-headed` | The same evasions in a real window on a virtual display (xvfb), preferring Google Chrome over Chromium |

Two of the plugin's evasions are switched off deliberately. `user-agent-override`
is written against a Puppeteer API Playwright lacks and throws. `navigator.languages`
hardcodes `en-US,en`, which would leave the browser claiming American languages
while sending an `en-GB` Accept-Language header — a browser that never touched
the property is less suspicious than one that contradicts itself. Both values
come from the Playwright context locale instead, so they cannot disagree.

`scripts/probe-airlines.js` sweeps the profiles across all four diagnostic
cases and prints a case-by-profile matrix, with each page saved as
`data/probe/<case>.<profile>.html.gz`. Reading down a column says whether a
profile helped; reading across a row says whether a case fails everywhere. The
matrix counts offers **and** pound figures found anywhere on the page, because
"0 offers on a page full of prices" is a parser bug and "0 offers on a page
with no prices" is a blocking problem, and the two must not be confused.

A headed browser does much more on startup than a headless one, and on a
restricted network some of it hangs rather than fails. The launcher therefore
gives a headed start 90 seconds and degrades to headless if it misses — worse,
but a result rather than a burnt job budget. It always reports which profile
actually ran, so a success is never credited to a profile that did not.

Nothing here defeats a paywall or a login. It makes an automated browser look
like the ordinary one the same person would open by hand to read the same
public prices.

### What the sweep found: nothing, and that is the useful part

Run 17 swept all three profiles across all four cases. The results were
**identical in every cell**:

| case | plain | stealth | stealth-headed |
|---|---|---|---|
| ba-return | 2 offers | 2 offers | 2 offers |
| ba-openjaw | 0 | 0 | 0 |
| vs-return | 0 | 0 | 0 |
| vs-openjaw | 0 | 0 | 0 |

So the fingerprint hypothesis is **wrong**. The three failing cases do not fail
because the browser looks automated — they fail for the same reason in every
browser. `stealth` remains the default because it costs nothing, but no further
effort should go into disguising the browser: that lever has been measured and
it does not move.

What the saved pages say instead:

- **Virgin** renders `We're sorry, there was a problem processing your request.
  Please go back and try the entry again.` That is a site rejecting a
  **deep link**, not a bot. The URL was captured after a search performed in a
  browser, so it carries state Virgin expects to have created itself.
- **BA multi-city** sits on loading placeholders indefinitely — the shell
  renders and the results request never returns.

Both point the same way: these two pages are not valid cold entry points, and
the fix is to **drive the search form** the way a person does rather than to
deep-link its result. BA's ordinary return search, which *is* a real entry
point, has worked from the first attempt in every profile.

The probe now also records every XHR the page makes, with status codes and
error bodies, to `data/probe/<case>.<profile>.network.json` — because a
single-page app that shows a shell and never a price is failing in a request,
and the saved HTML cannot show which one.

### Virgin is blocked by IP, not by anything in this code

The form driving worked. Multi-city was selected, "London" was typed into the
right field, and Virgin's own page then called its own API:

```
444 GET /travelplus/search-panel-api/airports/predictive/by-term?term=London
    <TITLE>Access Denied</TITLE>
    You don't have permission to access this server.
```

One request out of thirty-six failed, and it is the only one that matters. The
header and footer content APIs answered normally, and the homepage rendered
sixty-six prices. So Virgin serves marketing content to a datacentre address
quite happily and refuses its **search** APIs from one. That is also why the
captured deep link was rejected: the same block on a different surface, which
looked like a session problem and was not.

**No change to this code can fix that.** Not a selector, not a stealth profile,
not a parser. The request is refused before Virgin's application sees it, on
the strength of where it came from. Skyscanner behaves the same way, which is
consistent — GitHub's runners sit in Azure ranges that both vendors block
wholesale. British Airways does not block them, which is why it works.

The one remaining lever is therefore **where the collector runs**, not what it
does. From a residential connection — a laptop, a Pi, anything at home — the
same code would very likely be served, because it would no longer be coming
from a datacentre. That is a hypothesis, not a finding: it is grounded in the
denial being IP-based, but it has not been tested, and one run on such a
machine would settle it. Everything needed is already here: `npm run collect`
is the whole job, and results reach the dashboard by git push.

### Why the return legs "had no prices": they were in dollars

With the breaker fixed, BA's outbound one-ways (O1–O4) price fine and its four
round trips price fine — but every return leg (MCO→LON, TPA→LON, MIA→LON) came
back `no_prices_rendered`, which is what kept the eight open jaws unpriced.

The saved page shows the search was never the problem. It is a complete,
correct page: four direct flights, Thursday 26 August, four passengers,
"Prices are per adult, including all taxes". The prices are simply in **US
dollars** — `$618`, `$1,223`. BA prices by point of sale and a US origin flips
it, even on the `en/gbr` path whose own config says `"market":"gb"`. Neither
that page nor a working GBP one carries any currency field or selector, so
there is no parameter to flip; it follows the origin.

The pattern required a pound sign, so those pages parsed as "no prices". That
was the right outcome for the wrong reason, and the distinction matters: had
the pattern been loosened to match any number — the obvious "fix" for a page
that visibly has prices on it — every return leg would have been recorded as
pounds at roughly a fifth under its true cost, and nothing would have looked
wrong. The parser now captures the symbol, and a page quoting a currency the
trip does not use fails as `wrong_currency`, by name. Nothing is converted:
there is no free rate source here, and an invented rate is worse than a gap
because it looks real.

This means **a US-origin one-way cannot be priced in GBP from BA**, so the
eight open jaws need either a working multi-city search or Virgin. Which is
what the form-driving work is for.

### The breaker was disabling a source that worked

A second bug, found while reading why the dashboard said "4/12 itineraries
priced". The circuit breaker was keyed by provider alone. British Airways
answers one-way and return searches reliably and has never once answered an
open jaw — so its two open-jaw failures tripped BA for the entire run, and the
one-way legs it would happily have priced were skipped. Since every open jaw is
already composed from two one-way legs (`composeSplitTicket`), those skips cost
the eight open-jaw itineraries their prices, and the run reported a market
problem that was actually self-inflicted.

The breaker is now keyed by provider **and search kind**. A provider that
cannot do open jaws stops being asked for open jaws, not for everything.

One bug came out of this that mattered more than the sweep: the Virgin
rejection was being reported as `no_prices_rendered`. The check for it ran at
`domcontentloaded`, when the body is still an empty shell, so it never saw the
message that appeared seconds later. The run said "no prices" while the saved
page said "we rejected you" — and I spent a day on fingerprints as a result.
Failures are now re-classified **after** the wait, by `classifyStalledPage`,
into `request_rejected`, `no_flights`, or `results_never_loaded`.

---

## 5. Repository layout

Plain ES-module JavaScript, no build step: CI runs `node scripts/collect.js`
directly. Four dependencies — `playwright` and `yaml`, plus `playwright-extra`
and `puppeteer-extra-plugin-stealth` for the browser profiles in §4a.

```
.github/workflows/
  track.yml              # cron 2×/day + manual dispatch, commits results back
  pages.yml              # publishes docs/ to GitHub Pages
config/
  searches.yml           # the trip, the 12 itineraries, 7 legs, 6 TUI searches
  carrier-fees.yml       # curated baggage costs — hand-maintained
scripts/
  collect.js             # orchestrator; --urls prints URLs, --only runs one
  build-site.js          # history.csv -> docs/data.json
  lib/
    config.js            # load + validate; fails loudly on a broken matrix
    urls.js              # Google Flights search URLs
    pricing.js           # true_total, split-ticket composition
    store.js             # snapshots, history.csv, debug HTML
  providers/
    google-flights.js    # the scraper
data/
  snapshots/*.json.gz    # one per run, gzipped
  debug/*.html.gz        # raw HTML, kept only when a parse failed
  history.csv            # append-only time series
docs/
  index.html             # dashboard
  data.json              # dashboard feed, rebuilt each run
```

### Two commands worth knowing

```
npm run urls     # print every search URL — paste one in a browser to check it
npm run collect  # do a full run locally
node scripts/collect.js --only O1   # run a single search
```

### Changing the trip

The return dates are expected to move. `config/searches.yml` is therefore
**declarative**: it states the outbound dates and the return options, and the
12 itineraries, 7 legs and 6 TUI searches are all *generated* from that. A
return date is one edit in one place:

```yaml
returns:
  - shape: A
    date: 2027-08-19      # change this line
    from: [MCO, TPA]
```

Everything follows automatically — night counts, which TUI searches fit a
7-night charter rotation, and the leg composition that produces split-ticket
prices. `npm run urls` shows the new search list before you commit.

**Price history survives the change correctly.** Every row in `history.csv`
carries a *signature* — the dates and airports actually searched, such as
`2027-08-19|MCO>LON` — alongside the short id. Series are grouped on the
signature, never the id, because `R1` can come to mean a different search after
an edit while a signature cannot. So changing a return date starts a fresh
series rather than silently splicing a different trip onto the old prices. The
old series is kept and shown as *retired* on the dashboard.

Adding a third return option, or a third arrival airport, works the same way:
add it to the config and the matrix regenerates. Cost scales gently — a new
arrival airport adds one leg, not one search per itinerary.

---

## 6. What gets checked — the full combination list

London is searched as the metro code **`LON`**, which returns **both Gatwick and
Heathrow** options in a single query; the actual departure airport is read back
from each result and recorded. This covers both airports without doubling the
search count. (Exception: TUI, which needs a named airport and is Gatwick-only.)

Florida arrival and departure airports are allowed to **differ** (confirmed) — an
in-state open jaw, e.g. fly into Orlando, drive across, fly home from Tampa. Rows
A2, A4, A6 and A8 exist for exactly that.

### Shape A — home Thu 19 Aug from Florida

| # | id | Outbound | Into | Home from | Nights |
|---|---|---|---|---|---|
| 1 | `A1` | Wed 11 Aug | MCO | MCO | 8 |
| 2 | `A2` | Wed 11 Aug | MCO | TPA | 8 |
| 3 | `A3` | Wed 11 Aug | TPA | TPA | 8 |
| 4 | `A4` | Wed 11 Aug | TPA | MCO | 8 |
| 5 | `A5` | Thu 12 Aug | MCO | MCO | **7** |
| 6 | `A6` | Thu 12 Aug | MCO | TPA | **7** |
| 7 | `A7` | Thu 12 Aug | TPA | TPA | **7** |
| 8 | `A8` | Thu 12 Aug | TPA | MCO | **7** |

### Shape B — home Sun 22 Aug from Miami

| # | id | Outbound | Into | Home from | Nights |
|---|---|---|---|---|---|
| 9 | `B1` | Wed 11 Aug | MCO | MIA | 11 |
| 10 | `B2` | Wed 11 Aug | TPA | MIA | 11 |
| 11 | `B3` | Thu 12 Aug | MCO | MIA | 10 |
| 12 | `B4` | Thu 12 Aug | TPA | MIA | 10 |

**12 itineraries.** All 12 are checked on every run.

### Two pricing modes for each

Every itinerary is priced **both** as a single ticket (return or multi-city) **and**
as two independent one-ways. These diverge a lot on transatlantic routes — legacy
carriers usually price a round trip below two one-ways, low-cost carriers like
Norse often the reverse — so both are needed to find the real cheapest.

The one-way side does **not** need 24 extra searches, because the legs are shared.
Seven one-way searches compose all 12 itineraries by addition:

| Leg | Search | Used by |
|---|---|---|
| `O1` | LON → MCO, Wed 11 Aug | A1, A2, B1 |
| `O2` | LON → TPA, Wed 11 Aug | A3, A4, B2 |
| `O3` | LON → MCO, Thu 12 Aug | A5, A6, B3 |
| `O4` | LON → TPA, Thu 12 Aug | A7, A8, B4 |
| `R1` | MCO → LON, Thu 19 Aug | A1, A4, A5, A8 |
| `R2` | TPA → LON, Thu 19 Aug | A2, A3, A6, A7 |
| `R3` | MIA → LON, Sun 22 Aug | B1, B2, B3, B4 |

### TUI (charter, Gatwick only)

Searched separately against tui.co.uk, because this inventory appears nowhere else.
Charter sells **matched return rotations**, so TUI is searched as same-airport
returns rather than open jaws:

| id | Route | Out | Home | Nights |
|---|---|---|---|---|
| `T1` | LGW ↔ MCO | Wed 11 Aug | Thu 19 Aug | 8 |
| `T2` | LGW ↔ **SFB** | Wed 11 Aug | Thu 19 Aug | 8 |
| `T3` | LGW ↔ TPA | Wed 11 Aug | Thu 19 Aug | 8 |
| `T4` | LGW ↔ MCO | Thu 12 Aug | Thu 19 Aug | **7** |
| `T5` | LGW ↔ **SFB** | Thu 12 Aug | Thu 19 Aug | **7** |
| `T6` | LGW ↔ TPA | Thu 12 Aug | Thu 19 Aug | **7** |

`T4`–`T6` are the 7-night Thu→Thu rotations and are the most likely to actually
exist. `T1`–`T3` are attempted but may return nothing.

**Shape B has no TUI option.** TUI does not serve Miami from the UK, and charter
flight-only rarely sells unmatched legs — so the 22 Aug Miami return is a
scheduled-carrier proposition only. If TUI turns out to be much cheaper, that is
itself an argument for Shape A.

### Per-run totals

| Source | Searches |
|---|---|
| Google Flights — return / multi-city | 12 |
| Google Flights — shared one-way legs | 7 |
| TUI — Gatwick charter (incl. Sanford) | 6 |
| **Total per run** | **25** |

At two runs a day that's **50 searches daily**, roughly 25–35 minutes of runner
time — free and unmetered on a public repo.

---

## 7. Data model

### Canonical offer

```jsonc
{
  "collected_at": "2026-09-06T18:00:00Z",
  "search_id": "B-11-MCO",
  "pricing_mode": "multi_city",        // or "two_one_ways"
  "provider": "google_flights",
  "currency": "GBP",
  "query": {
    "origin": "LON", "into": "MCO", "home_from": "MIA",
    "out_date": "2027-08-11", "return_date": "2027-08-22",
    "adults": 3, "children": [9], "cabin": "economy", "checked_bags": 4
  },
  "results_available": true,           // false = not yet on sale
  "offers": [
    {
      "total_price": 4820.00,          // headline, all 4 passengers
      "checked_bags_included_pp": 1,
      "extra_bag_cost": 0.00,
      "true_total": 4820.00,           // see below
      "validating_carrier": "BA",
      "fare_brand": "Economy Standard",
      "stops_out": 0, "stops_home": 0,
      "duration_out_min": 545,
      "duration_home_min": 505,
      "deep_link": "https://...",
      "segments_out": [ /* Segment */ ],
      "segments_home": [ /* Segment */ ]
    }
  ]
}
```

### Segment

```jsonc
{
  "seq": 1,
  "marketing_carrier": "BA", "operating_carrier": "BA",
  "flight_no": "BA2039",
  "from": "LGW", "to": "MCO",
  "dep_local": "2027-08-11T10:25", "arr_local": "2027-08-11T15:05",
  "dep_utc":   "2027-08-11T09:25Z", "arr_utc":   "2027-08-11T19:05Z",
  "aircraft": "Boeing 777-200", "cabin": "Economy",
  "layover_after_min": null
}
```

### `true_total` — the number that actually matters

The headline fare is not comparable across carriers, because hold luggage is
included on some fares and not others. BA and Virgin generally include one checked
bag in most transatlantic economy fares but **not** in their cheapest hand-baggage-only
brands; Norse Atlantic charges for everything.

```
true_total = total_price + cost of topping up to 1 checked bag per passenger
```

`config/carrier-fees.yml` holds curated per-carrier baggage costs, since no free
source exposes fare-family baggage rules reliably. **Every chart and ranking in the
dashboard sorts on `true_total`, never on the headline fare.** This is the single
thing the tracker does that the mainstream comparison sites do badly.

### `data/history.csv`

Append-only, one row per offer per run. Deliberately flat so it opens in Excel and
so `git log -p` on it reads as a human-legible price diary.

```
collected_at, search_id, pricing_mode, out_date, return_date,
origin_airport, into_airport, home_from_airport, carrier, fare_brand,
total_price, true_total, stops_out, stops_home,
out_dep_local, out_arr_local, home_dep_local, home_arr_local,
bags_included_pp, deep_link
```

---

## 8. Schedule

- **Twice daily**, ~07:00 and ~19:00 UTC. Fares move on airline revenue-management
  cycles, not continuously; twice a day is ample over an 11-month horizon and keeps
  scraping volume politely low.
- Also `workflow_dispatch` for manual runs.
- GitHub delays scheduled runs under load and occasionally skips them entirely.
  This is fine at daily granularity — but the dashboard should show
  *last successful collection*, so a silently stalled tracker is visible.

---

## 9. Storage and the web app

Both live in **this repository**. No database, no Cloudflare, no hosting account,
nothing to pay for or maintain.

### Where results are stored

| What | Where | Why |
|---|---|---|
| Raw scrape output | `data/snapshots/YYYY-MM-DD-HHmm.json.gz` | Full audit trail — lets old runs be re-parsed if the normaliser improves |
| Flat time series | `data/history.csv` | Append-only, one row per offer per run. Opens directly in Excel |
| Dashboard feed | `docs/data.json` | Compact, regenerated each run for the web app to read |

The Actions workflow commits these back to the repo on every run, which means
**git history is the price time series**. `git log -p data/history.csv` reads as a
literal price diary, and any past state can be recovered exactly. That is the whole
storage layer — a database would add cost and moving parts for no benefit at this
scale.

**Size management.** Over ~340 days at 2 runs/day this would otherwise grow to a
few hundred MB. Two measures keep it comfortably small: raw snapshots are **gzipped**
(JSON compresses ~10×), and `history.csv` keeps only the **top 5 offers per search**
rather than every result. Expected total well under 50 MB.

### The web app

A static site in `docs/`, published free by **GitHub Pages** at:

```
https://jmills73b.github.io/Flight-comparison/
```

It's plain HTML/JS reading `docs/data.json` — no server, no build step, no
framework needed. Every scrape run updates the data file and the site reflects it
within a minute.

> **One manual step:** GitHub Pages must be enabled once in **Settings → Pages**,
> with **Source: Deploy from a branch**, branch `main`, folder `/docs`. It cannot
> be switched on from code.
>
> There is deliberately no Pages *workflow*. `docs/` is plain static files with no
> build step, so serving the folder directly is simpler and removes a job that can
> fail — an earlier `pages.yml` using the GitHub Actions source failed immediately
> and would have emailed a failure on every tracker run that touched `docs/`.

*Alternative considered:* Cloudflare Pages would also host this free and could point
at the same repo. GitHub Pages wins only because the data already lives here, so
it's one less account in the loop. Swapping later is a config change, not a rewrite.

### What the app shows

1. **Headline** — current best `true_total`, with delta vs first-ever-seen and vs
   7 days ago. Plus days-to-departure and last-collected timestamp.
2. **Price over time** — line per `search_id`, `true_total` on the y-axis. The
   core "is it going up or down" view.
3. **Comparison matrix** — all 12 itineraries as rows, cells coloured by price.
   Answers "is the 12th cheaper than the 11th, and is flying home from Miami
   actually worth it".
4. **Best-offer detail table** — full breakdown: carrier, flight numbers, times,
   stops, duration, bags, headline vs true total, deep link to book.
5. **Single vs split ticket** — for each itinerary, the one-ticket price beside the
   two-one-ways price, so the cheaper structure is obvious at a glance.
6. **Source coverage** — which of Google Flights / TUI returned results for each
   itinerary, so a silently broken scraper or a not-yet-on-sale route is visible
   rather than looking like "no cheap flights".

Charts should be built with the project's dataviz conventions rather than
library defaults.

### Alerting

A price drop beyond a set threshold **opens a GitHub issue**. GitHub emails issue
notifications automatically, so this is free push notification with no extra
service, no SMTP credentials and no third-party account.

---

## 10. Risks and blind spots

| Risk | Mitigation |
|---|---|
| Fares not yet on sale (esp. 22 Aug Miami) | `results_available: false` is a normal recorded state, not a failure |
| Scraper breaks on markup change | Workflow failure opens an issue; raw snapshots retained so data can be re-parsed |
| Bot detection / blocking | Low volume, realistic pacing, randomised timing within the cron window |
| Google Flights ToS | Accepted, low-volume personal use — see §3 |
| TUI charter invisible | Manual check reminder; dedicated adapter in phase 6 |
| Actions cron unreliability | Dashboard surfaces last-successful-collection age |
| GBP/USD drift on US-ticketed fares | Always record `currency`; never mix without conversion |

### Non-flight cost worth tracking

Shape B (Orlando/Tampa in, Miami out) incurs a **one-way car hire drop-off fee**,
commonly £100–200+. That can quietly erase the flight saving that made Shape B look
attractive. The dashboard should carry this as a manual adjustment field so Shape A
and Shape B are compared honestly, on total trip cost rather than airfare alone.

---

## 11. Build phases

| Phase | Deliverable | Status |
|---|---|---|
| 0 | This document | **done** |
| 1 | Scaffold: workflows, config, harness, commit-back loop | **done** |
| 2 | Google Flights adapter + `true_total` + split-ticket composition | **built, unverified** |
| 3 | Multi-city UI path — single-ticket pricing for the 8 open jaws | next |
| 4 | TUI adapter — confirm route map, then the 6 Gatwick searches | |
| 5 | Dashboard charts: price over time, comparison matrix | |
| 6 | Price-drop alerting via GitHub issue | |
| 7 | Optional direct adapters: BA, Virgin, Norse | |

**Phase 2 is built but not verified against the live site.** It could not be:
the development sandbox's egress proxy blocks google.com, and the fares are only
now going on sale. The first real Actions run is the test. Until then the
scraper's selectors are an informed guess, which is why every extraction step
either confirms itself or fails the search — see below.

### Failing loudly

A wrong price is far worse than no price: a tracker that silently recorded a
one-adult fare as the family total would send you to book at the wrong moment.
So the adapter never guesses:

- Party size is **read back** from the passenger control after being set. If it
  does not match, the search fails rather than recording the fare.
- A run where *no* search returned an offer exits non-zero, so a broken scraper
  surfaces as a failed job instead of quietly committing nothing.
- Failures are distinguished in the data — `not_on_sale`, `blocked`,
  `no_offers_parsed`, `passenger_setup_failed` — so "no fares yet" never looks
  like "scraper broken", and the dashboard shows which is which.
- On a parse failure the raw HTML is committed to `data/debug/`, gzipped, so the
  break can be diagnosed after the fact.

---

## 12. Decisions and remaining questions

### Settled

| Question | Decision |
|---|---|
| Passenger mix | 3 adults + 1 child (9). The 12-year-old prices as an adult |
| In-state open jaw (A2/A4/A6/A8) | **Yes** — different Florida in/out airports allowed |
| TUI charter | **Yes** — own adapter, Gatwick only |
| Orlando Sanford (SFB) | **Yes**, for TUI searches only |
| Storage | Committed to this repo; git history is the time series |
| Web app | Static site on GitHub Pages |

### Working defaults — assumed unless you say otherwise

- **Cabin: economy only.** Premium economy is a common upgrade on a 9-hour daytime
  transatlantic with children and its price curve behaves quite differently, so it
  would be a genuinely useful second dataset. Adding it later roughly doubles the
  search count, which is still free — it's a one-line config change, not a rewrite.
- **Stops: direct and 1-stop tracked, 2+ excluded.** Direct is ranked above 1-stop
  at equal price. Connections via Dublin, Amsterdam or a US hub are often
  meaningfully cheaper but add 4–6 hours each way, so they are worth *seeing*
  rather than hiding — the dashboard shows duration alongside price so the
  trade-off is explicit.

### Still open

1. **Alert threshold** — what drop is worth an email? A fixed floor ("anything
   under £4,000") or a relative move ("5% below the 30-day median")? Easiest to set
   once there is a fortnight of data showing the real price range.
2. **Booking deadline** — a date by which you want to have booked regardless? If so
   the dashboard can nudge toward a decision as it approaches.
3. **Car hire drop-off fee** — wire in as a real adjustment to Shape B's total, or
   leave as a displayed note?
