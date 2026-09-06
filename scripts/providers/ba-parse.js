/**
 * British Airways offer parsing.
 *
 * BA labels each offer with a complete accessibility description — the exact
 * text a screen reader announces:
 *
 *   "You are in the 1st flight of 4 results. Flight departure Wednesday
 *    11 August 2027, at 10:45 from London airport Gatwick. Arrives on
 *    Wednesday 11 August 2027, at 15:15 to Orlando airport Orlando
 *    International (FL). Duration of the flight 9 hours and 30 minutes with
 *    0 stops. Price per passenger from £587. Operated by British Airways.
 *    3 cabins are available. Gatwick LGW Orlando International (FL) MCO"
 *
 * Every field this tracker wants is in there, stated rather than inferred.
 * Parsing that beats mining visual text: it is meant to be stable, it names
 * the real departure airport (so a LON metro search still resolves to LGW or
 * LHR per offer), and it cannot silently pair a price with the wrong flight.
 *
 * PRICES ARE PER PASSENGER. The party total is an estimate — children and
 * young adults often pay less than the adult fare, and BA only shows the true
 * total several steps into its booking flow — so it is recorded as an
 * estimate, marked as such, and never presented as an exact quote.
 */

const ORDINAL = /You are in the (\d+)(?:st|nd|rd|th) flight of (\d+) results?/i;
const DEPARTURE = /Flight departure [A-Za-z]+ (\d{1,2} [A-Za-z]+ \d{4}), at (\d{2}:\d{2}) from ([^,.]+?) airport ([^,.]+?)\./i;
const ARRIVAL = /Arrives on [A-Za-z]+ (\d{1,2} [A-Za-z]+ \d{4}), at (\d{2}:\d{2}) to ([^,.]+?) airport (.+?)\. Duration/i;
const DURATION = /Duration of the flight (\d+) hours?(?: and (\d+) minutes?)? with (\d+) stops?/i;
const PRICE = /Price per passenger from £\s?([\d,]+)/i;
const OPERATOR = /Operated by ([^.]+)\./i;
/** Trailing "Gatwick LGW Orlando International (FL) MCO" — the IATA codes. */
const CODES = /\b([A-Z]{3})\b(?!.*\b[A-Z]{3}\b.*\b[A-Z]{3}\b)/g;

/**
 * @param text   the offer's accessibility description
 * @param testid e.g. "offerFlightHeader-direct-0" — carries direct/indirect
 */
export function parseBaOffer(text, testid, { passengers, minPerPassenger = 50 }) {
  const price = text.match(PRICE);
  if (!price) return null;
  const perPassenger = Number(price[1].replace(/,/g, ''));
  if (!Number.isFinite(perPassenger) || perPassenger < minPerPassenger) return null;

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

  const codes = [...text.matchAll(/\b([A-Z]{3})\b/g)].map((m) => m[1]);
  const known = codes.filter((c) => !['FL', 'BA'].includes(c));

  const ordinal = text.match(ORDINAL);
  const operator = text.match(OPERATOR);

  return {
    perPassengerFare: perPassenger,
    // An estimate, not a quote: children and young adults often pay less.
    fare: perPassenger * passengers,
    priceBasis: 'per_passenger_x_passengers_estimate',
    isEstimate: true,
    carrier: 'BA',
    carrierName: operator ? operator[1].trim() : 'British Airways',
    fareBrand: null,
    stops,
    isDirect: saysDirect,
    depLocal: dep ? dep[2] : null,
    arrLocal: arr ? arr[2] : null,
    depDate: dep ? dep[1] : null,
    // The real airport behind a LON metro search — Gatwick or Heathrow.
    depAirportName: dep ? dep[4].trim() : null,
    arrAirportName: arr ? arr[4].trim() : null,
    depAirport: known[0] ?? null,
    // Last code, not the second: the arrival airport's name can itself contain
    // a three-letter token, which pushed the real code out of position.
    arrAirport: known.length > 1 ? known[known.length - 1] : null,
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
