# Flight Comparison — Florida, August 2027

A price tracker for one specific family holiday: London → Tampa/Orlando, out
11 or 12 August 2027, home 19 August from Florida or 22 August from Miami.
3 adults + 1 child, hold luggage.

It watches a fixed set of 12 itineraries twice a day and records what each one
costs, so the question "when and on which routing do we book?" has data behind it
rather than guesswork.

**Status: design only. No code yet.**

## How it will work

GitHub Actions runs a Playwright scraper on a schedule, commits each result back
to this repo as JSON, and publishes a dashboard to GitHub Pages. The git history
of `data/history.csv` becomes the price time series — no database required, and
the whole thing runs free on a public repo.

There is no longer a free flight pricing API (Amadeus closed its self-service tier
in July 2026), which is why this uses browser automation rather than an API.

## Read this first

**[DESIGN.md](DESIGN.md)** — the full design: data sources and why, architecture,
the itinerary matrix, data model, risks, and build phases.

Two findings from that document worth knowing up front:

- **These dates are only just going on sale.** They sit 339–350 days out, and
  airlines load schedules 330–355 days ahead. The 22 August Miami return likely
  isn't bookable until late September 2026. Starting the tracker now is the point —
  the initial fare load is often the cheapest peak-August transatlantic ever gets.
- **A 12-year-old books as an adult.** Airline child fares end at 11, so the
  passenger mix is 3 adults + 1 child, not 2 + 2. Getting this wrong understates
  every tracked price.
