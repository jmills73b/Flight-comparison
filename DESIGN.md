# Florida 2027 — Flight Price Tracker

Design document. No code yet.

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

**Primary — Google Flights via Playwright.** Handles multi-city/open-jaw natively,
prices the exact passenger mix, exposes carrier, flight numbers, times, aircraft,
stops and fare brand. Best single source by a distance.

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

## 5. Repository layout

```
.github/workflows/
  track.yml            # cron 2×/day + manual dispatch
  pages.yml            # publish docs/ to GitHub Pages
config/
  searches.yml         # the tracked itinerary matrix (§6)
  carrier-fees.yml     # curated baggage/ancillary costs (§7)
scripts/
  collect.ts           # orchestrator
  providers/
    google-flights.ts  # primary adapter
    ba.ts              # (phase 6)
    virgin.ts          # (phase 6)
  normalise.ts         # provider payload -> canonical Offer
  append-history.ts    # canonical Offer -> history.csv
data/
  snapshots/YYYY-MM-DD-HHmm.json   # raw, one per run
  history.csv                      # append-only time series
docs/
  index.html           # dashboard
  data.json            # dashboard feed, regenerated each run
DESIGN.md
README.md
```

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

> **One manual step:** GitHub Pages must be enabled once in
> **Settings → Pages → Source: GitHub Actions**. Pages is not currently enabled on
> this repo and can't be switched on from code.

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

| Phase | Deliverable |
|---|---|
| 0 | **This document** |
| 1 | Scaffold: `track.yml`, `searches.yml`, Playwright harness, commit-back loop |
| 2 | Google Flights adapter for a single search; verify data quality by hand |
| 3 | Expand to all 12 itineraries + the 7 shared one-way legs |
| 4 | **TUI adapter** — confirm route map, then LGW charter searches |
| 5 | Pages dashboard with charts and comparison matrix |
| 6 | Price-drop alerting via GitHub issue |
| 7 | Optional direct adapters: BA, Virgin, Norse |

Phases 1–2 are the risky part: everything after depends on whether the Google
Flights scrape proves stable. Worth proving before building anything on top.

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
