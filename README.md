# Florida 2027 Fare Watch — retired

A price tracker for one family holiday: London to Orlando or Tampa, out on
11 or 12 August 2027, home on the 26th from Florida or the 29th from Miami.
Two adults, a twelve year old and a nine year old, four hold bags, economy,
direct flights only.

**Status: decommissioned on 8 September 2026.** The schedule has been removed.
Nothing runs on its own any more and no further prices will be recorded. The
data already collected is kept, and the dashboard carries a notice saying it is
frozen.

## Why it was stopped

The tracker worked, for one airline. It could never work for the whole trip,
and the reason turned out to be something no amount of code could fix.

**Four of the twelve itineraries were priced.** All four are the "Shape A"
round trips — fly into Orlando or Tampa, come home from the same airport. The
last figures recorded were:

| | Out | Home | Route | Price |
|---|---|---|---|---|
| A1 | 11 Aug | 26 Aug | LON → MCO → LON | £2,600 |
| A5 | 12 Aug | 26 Aug | LON → MCO → LON | £2,616 |
| A7 | 12 Aug | 26 Aug | LON → TPA → LON | £2,748 |
| A3 | 11 Aug | 26 Aug | LON → TPA → LON | £3,408 |

Those are British Airways, cheapest available fare brand, plus the cost of
adding a hold bag for all four passengers. They are a year-out snapshot, not a
recommendation.

**The other eight never could be.** They are the open jaws — fly into one
Florida airport and home from another, or home from Miami — and each needs a
leg starting in the United States. Two independent walls stand in front of
those:

1. **Virgin Atlantic and Skyscanner block the requests by IP address.** Not the
   scraper, not the browser — the address it comes from. Virgin's own page,
   driven through its own search form exactly as a person would, asked Virgin's
   own API for airports matching "London" and got back `444 Access Denied — you
   don't have permission to access this server`. Thirty-five of the thirty-six
   requests on that page succeeded; only the search API was refused. GitHub's
   runners sit in Azure address ranges that both vendors block wholesale.
   British Airways does not block them, which is exactly why BA works and
   nothing else does.

2. **British Airways will not quote a US-origin leg in pounds.** A one-way
   Orlando to London search returns a perfectly good page — right date, right
   four passengers, four direct flights — priced in US dollars, because BA
   prices by point of sale and a US origin flips it. Neither that page nor a
   working sterling one carries any currency control, so there is nothing to
   switch. The tracker refuses those prices by name (`wrong_currency`) rather
   than converting them, because there is no free exchange rate source here and
   an invented rate would look real.

Between them, every routing that goes home from a different airport is
unreachable from a free cloud runner. That is not a bug list; it is the shape of
the problem.

## What was ruled out along the way

- **No free flight API exists.** Amadeus closed its self-service tier in July
  2026; Skyscanner, Duffel and Kiwi are partner-gated; Google has had no flight
  API since QPX closed in 2018. Scraping was not a shortcut, it was the only
  option.
- **It is not bot detection on the browser.** Three browser profiles — plain
  headless Chromium, a stealth-patched one, and real Google Chrome in a window
  on a virtual display — were run against all four diagnostic searches. The
  results were identical in all twelve cells. Disguising the browser does
  nothing, and that was measured rather than assumed.
- **BA's multi-city search is not reachable.** Its results URL expects state the
  site creates itself and stalls forever without it, and the Multi-city tab on
  the homepage was clicked three times, by test id and by accessible name, with
  no navigation, no panel and no change of state.

## The one thing never tried

The blocker is **where the code runs**, not what it does. From a home broadband
connection the same requests would very likely be served, because they would no
longer be coming from a datacentre. That is a reasoned expectation, not a
finding — it was never tested.

If it is ever worth an evening:

```bash
npm ci
npx playwright install --with-deps chromium
npm run collect          # the whole job; writes data/ and commits nothing
node scripts/build-site.js
```

Run that on a laptop, look at whether Virgin returns anything, and the question
is answered. Everything else is already built: the twelve itineraries, the
split-ticket composition, the price history, the dashboard.

## What is in here

```
config/searches.yml   the trip — change a date and everything follows
scripts/collect.js    the collector
scripts/providers/    one adapter per source (BA, Virgin, Google, Skyscanner)
scripts/probe-*.js    diagnostics that run against known-bookable dates
data/history.csv      318 rows of price history, kept
data/probe/           saved pages, the evidence behind every finding above
docs/                 the dashboard, frozen
DESIGN.md             the full design, and a written record of what went wrong
```

The workflow in `.github/workflows/track.yml` is kept but has no schedule. It
can still be run by hand from the Actions tab, and if it is, it will collect and
commit exactly as it used to.

## To finish decommissioning

Two things can only be done from the GitHub web interface:

- **Turn off Pages** if you would rather the dashboard not be published at all:
  Settings → Pages → Source → None. Leaving it on is harmless; it carries a
  retired notice.
- **Delete or archive the repository** if you want it gone: Settings → General →
  Danger Zone. Archiving makes it read-only and keeps the history; deleting is
  permanent. Neither has been done here.
