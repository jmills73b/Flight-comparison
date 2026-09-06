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

**Known blind spot — TUI.** TUI flies LGW→MCO/TPA as **charter**, and those seats
are invisible to Google Flights and Skyscanner. For UK→Florida in August they are
frequently competitive. Until a dedicated adapter exists, the dashboard should
carry a standing reminder to check TUI manually.

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

## 6. The tracked itinerary matrix

Origin is searched as the metro code **`LON`**, which covers both Gatwick and
Heathrow in one query; the actual airport is read back from the result.

**Shape A — 8/9 nights, return 19 Aug.** Florida arrival and departure airports are
allowed to differ (an in-state open jaw, e.g. into Orlando, home from Tampa).

| id | Out date | Into | Home from |
|---|---|---|---|
| `A-11-MCO-MCO` | 11 Aug | MCO | MCO |
| `A-11-MCO-TPA` | 11 Aug | MCO | TPA |
| `A-11-TPA-TPA` | 11 Aug | TPA | TPA |
| `A-11-TPA-MCO` | 11 Aug | TPA | MCO |
| `A-12-*` | 12 Aug | — | same four combinations |

**Shape B — 11/12 nights, return 22 Aug from Miami.**

| id | Out date | Into | Home from |
|---|---|---|---|
| `B-11-MCO` | 11 Aug | MCO | MIA |
| `B-11-TPA` | 11 Aug | TPA | MIA |
| `B-12-MCO` | 12 Aug | MCO | MIA |
| `B-12-TPA` | 12 Aug | TPA | MIA |

**12 itineraries total.** Every Shape B itinerary is priced **twice** — once as a
single multi-city ticket, once as two independent one-ways — because those diverge
substantially on transatlantic routes and the one-way pairing is sometimes far
cheaper. That gives **16 priced combinations**, ~24 searches/day across two runs.

At roughly 30–45s per search that is about 15–20 minutes of runner time per day —
free and unmetered on a public repo.

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

## 9. Dashboard

Served from `docs/` via GitHub Pages.

1. **Headline** — current best `true_total`, with delta vs first-ever-seen and vs
   7 days ago. Plus days-to-departure and last-collected timestamp.
2. **Price over time** — line per `search_id`, `true_total` on the y-axis. The
   core "is it going up or down" view.
3. **Comparison matrix** — out-date × itinerary shape, cells coloured by price.
   Answers "is the 12th cheaper than the 11th, and is Miami-out worth it".
4. **Best-offer detail table** — full breakdown: carrier, flight numbers, times,
   stops, duration, bags, headline vs true total, deep link to book.
5. **Standing notes** — the TUI charter reminder, and the car hire adjustment below.

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
| 3 | Expand to all 12 itineraries + two-one-ways pricing |
| 4 | Pages dashboard with charts and comparison matrix |
| 5 | Price-drop alerting via GitHub issue |
| 6 | Direct adapters: BA, Virgin, TUI |

Phases 1–2 are the risky part: everything after depends on whether the Google
Flights scrape proves stable. Worth proving before building anything on top.

---

## 12. Open questions

1. **Cabin** — economy assumed throughout. Track premium economy too? On a 9-hour
   daytime transatlantic with a 9-year-old it is a common upgrade, and the
   premium-economy price curve behaves quite differently.
2. **Direct flights only?** Connections via Dublin, Amsterdam or a US hub are
   usually cheaper but add 4–6 hours each way. Should indirect options be tracked,
   ranked lower, or excluded entirely?
3. **Alert threshold** — what price drop is worth an email? A fixed floor
   (e.g. "anything under £4,000") or a relative move (e.g. "5% below the 30-day
   median")?
4. **Booking horizon** — is there a date by which you want to have booked
   regardless? That changes whether the dashboard should nudge toward a decision
   as departure approaches.
5. **Car hire fee** — worth wiring in as a real adjustment, or leave as a note?
