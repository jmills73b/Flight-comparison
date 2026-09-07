/**
 * British Airways offer parsing.
 *
 * BA labels each offer with a complete accessibility description — the exact
 * text a screen reader announces. Verbatim, from a saved page:
 *
 *   "You are in the 1st flight of 4 results. Flight departure Wednesday,
 *    11 August 2027, at 10:45 from London airport Gatwick. Arrives on
 *    Wednesday, 11 August 2027, at 15:15 to Orlando airport Orlando
 *    International (FL). Duration of the flight 9 hours and 30 minutes with
 *    0 stops. Price per passenger from £595. Operated by British Airways.
 *    3 cabins are available."
 *
 * Every field this tracker wants is in there, stated rather than inferred.
 * Parsing that beats mining visual text: it is meant to be stable, it names
 * the real departure airport (so a LON metro search still resolves to LGW or
 * LHR per offer), and it cannot silently pair a price with the wrong flight.
 *
 * TWO THINGS THE REAL PAGE CORRECTED, both found by re-reading a saved page
 * rather than by reasoning about it:
 *
 * 1. There is a comma after the weekday — "Wednesday, 11 August" — which the
 *    first version of these patterns did not allow. Every offer therefore came
 *    back with no times and no airports, printed as "???→??? --:--". The price
 *    still parsed, so nothing looked broken.
 * 2. This page carries NO trailing IATA codes. The airport is named in words
 *    only, so the codes are resolved from the names, which is the whole point
 *    of searching the LON metro area: Gatwick and Heathrow are different
 *    answers to the same search.
 *
 * PRICE BASIS IS STATED, NOT ASSUMED. BA ships two templates — "Price per
 * passenger from {price}" and "Price for all passengers from {price}" — and
 * both are in the page source. Multiplying the second by four would overstate
 * a family holiday by three thousand pounds, so the wording decides, and text
 * matching neither is refused rather than guessed at.
 */

/**
 * Airport names as BA writes them, to IATA. Only airports this trip can
 * involve: a name that is not here yields a null code rather than a guess,
 * because a wrong airport is worse than a missing one — LGW and LHR are two
 * hours apart with four people and luggage.
 */
const AIRPORT_BY_NAME = [
  [/gatwick/i, 'LGW'],
  [/heathrow/i, 'LHR'],
  [/city airport|london city/i, 'LCY'],
  [/stansted/i, 'STN'],
  [/luton/i, 'LTN'],
  [/orlando international/i, 'MCO'],
  [/sanford/i, 'SFB'],
  [/tampa/i, 'TPA'],
  [/miami/i, 'MIA'],
];

function airportCode(name) {
  if (!name) return null;
  for (const [re, code] of AIRPORT_BY_NAME) if (re.test(name)) return code;
  return null;
}

const ORDINAL = /You are in the (\d+)(?:st|nd|rd|th) flight of (\d+) results?/i;
// The `,?` after the weekday is the whole of bug 1 above.
const DEPARTURE =
  /Flight departure [A-Za-z]+,? (\d{1,2} [A-Za-z]+ \d{4}), at (\d{1,2}:\d{2}) from ([^,.]+?) airport ([^,.]+?)\./i;
const ARRIVAL =
  /Arrives on [A-Za-z]+,? (\d{1,2} [A-Za-z]+ \d{4}), at (\d{1,2}:\d{2}) to ([^,.]+?) airport (.+?)\. Duration/i;
const DURATION = /Duration of the flight (\d+) hours?(?: and (\d+) minutes?)? with (\d+) stops?/i;
/**
 * The currency symbol is CAPTURED, not assumed.
 *
 * A one-way MCO→LON search returns a perfectly good page — four direct
 * flights, the right date, the right four passengers — priced in US DOLLARS.
 * BA prices by point of sale, and a US origin flips it, even on the en/gbr
 * path with market "gb" in the page's own config.
 *
 * The pattern used to require a pound sign, so those pages parsed as "no
 * prices rendered" and the return legs looked unavailable when they were
 * merely quoted in the wrong money. That was the right failure for the wrong
 * reason — and it is worth being precise about which: had the pattern instead
 * been loosened to match any number, every return leg would have been recorded
 * as pounds at roughly a fifth under its real cost, and nothing would have
 * looked wrong at all. Capturing the symbol keeps both mistakes off the table.
 */
const PRICE_PER_PASSENGER = /Price per passenger from ([£$€])\s?([\d,]+)/i;
const PRICE_WHOLE_PARTY = /Price for all passengers from ([£$€])\s?([\d,]+)/i;
const CURRENCY_OF = { '£': 'GBP', $: 'USD', '€': 'EUR' };
const OPERATOR = /Operated by ([^.]+)\./i;
/** Trailing "Gatwick LGW Orlando International (FL) MCO" — the IATA codes. */
const CODES = /\b([A-Z]{3})\b(?!.*\b[A-Z]{3}\b.*\b[A-Z]{3}\b)/g;

/**
 * @param text   the offer's accessibility description
 * @param testid e.g. "offerFlightHeader-direct-0" — carries direct/indirect
 */
export function parseBaOffer(text, testid, { passengers, minPerPassenger = 50 }) {
  // Which template BA used decides everything downstream. Getting this
  // backwards is a fourfold error in whichever direction is wrong.
  const perPax = text.match(PRICE_PER_PASSENGER);
  const wholeParty = text.match(PRICE_WHOLE_PARTY);
  if (!perPax && !wholeParty) return null;

  const matched = perPax ?? wholeParty;
  const currency = CURRENCY_OF[matched[1]] ?? null;
  const quoted = Number(matched[2].replace(/,/g, ''));
  if (!Number.isFinite(quoted)) return null;

  const perPassenger = perPax ? quoted : quoted / passengers;
  const partyFare = perPax ? quoted * passengers : quoted;
  if (perPassenger < minPerPassenger) return null;

  const dep = text.match(DEPARTURE);
  const arr = text.match(ARRIVAL);
  const dur = text.match(DURATION);

  // Same rule as every other adapter: a price alone is not a flight.
  if (!dep && !dur) return null;

  const durationMin = dur ? Number(dur[1]) * 60 + Number(dur[2] ?? 0) : null;

  // Stops from the description; the testid says direct/indirect as a check.
  let stops = dur ? Number(dur[3]) : null;
  const saysDirect = /-direct-/.test(testid ?? '');
  if (stops === null && testid) stops = saysDirect ? 0 : null;

  // Some page versions append "Gatwick LGW Orlando International (FL) MCO";
  // this one does not. Use codes when they are there, names when they are not.
  const codes = [...text.matchAll(/\b([A-Z]{3})\b/g)]
    .map((m) => m[1])
    .filter((c) => !['FL', 'BA'].includes(c));

  const ordinal = text.match(ORDINAL);
  const operator = text.match(OPERATOR);

  return {
    // Whatever money the page actually quoted. The caller decides what to do
    // with a currency it did not ask for; this function does not convert, and
    // must not, because there is no free rate source here and a made-up rate
    // is worse than a gap.
    currency,
    perPassengerFare: perPassenger,
    // An estimate only when it was multiplied up: children and young adults
    // often pay less than the adult fare BA quotes. A whole-party figure needs
    // no such caveat, so it does not carry one.
    fare: partyFare,
    priceBasis: perPax ? 'per_passenger_x_passengers_estimate' : 'whole_party_as_quoted',
    isEstimate: Boolean(perPax),
    carrier: 'BA',
    carrierName: operator ? operator[1].trim() : 'British Airways',
    // BA's results page quotes "Price per passenger FROM £587 ... 3 cabins are
    // available" — the cheapest brand, which is Economy Basic and carries no
    // hold luggage. Fare brands are not priced here at all; the only mentions
    // of "Economy Standard" in the page are i18n template strings. Naming the
    // brand honestly matters because carrier-fees.yml treats an unknown BA
    // brand as bag-included, which would understate the real cost twice over:
    // once for the teaser price, once for the missing bag.
    fareBrand: 'Economy Basic (lowest available)',
    isFromPrice: true,
    stops,
    isDirect: saysDirect,
    depLocal: dep ? dep[2] : null,
    arrLocal: arr ? arr[2] : null,
    depDate: dep ? dep[1] : null,
    // The real airport behind a LON metro search — Gatwick or Heathrow.
    depAirportName: dep ? dep[4].trim() : null,
    arrAirportName: arr ? arr[4].trim() : null,
    depAirport: airportCode(dep?.[4]) ?? codes[0] ?? null,
    // Last code, not the second: the arrival airport's name can itself contain
    // a three-letter token, which pushed the real code out of position.
    arrAirport:
      airportCode(arr?.[4]) ?? (codes.length > 1 ? codes[codes.length - 1] : null),
    durationMin,
    resultIndex: ordinal ? Number(ordinal[1]) : null,
    resultCount: ordinal ? Number(ordinal[2]) : null,
    deepLink: null,
    rawText: text.slice(0, 400),
  };
}

/**
 * BA's date ribbon — "£461 Sun 8 Aug £453 Mon 9 Aug ..." — is a price calendar
 * for the days either side of the searched date, free with every search. It
 * answers "is the 12th cheaper than the 11th" directly, which is one of the
 * questions this whole tracker exists to answer.
 *
 * NOT COMPARABLE TO THIS TRIP'S PRICES. BA's own small print says: "Unless
 * specific dates are selected, prices shown are for the dates displayed, based
 * on a 7-night return journey." This holiday is fifteen nights. These figures
 * are a shape — which days are dearer — and must never be written to the price
 * history as if they were quotes for the trip. They are printed by the probe
 * and stored nowhere, deliberately.
 */
export function parseBaRibbon(text) {
  const out = [];
  const re = /£\s?([\d,]+)\s+([A-Za-z]{3})\s+(\d{1,2})\s+([A-Za-z]{3})/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push({
      perPassengerFare: Number(m[1].replace(/,/g, '')),
      weekday: m[2],
      day: Number(m[3]),
      month: m[4],
    });
  }
  return out;
}
