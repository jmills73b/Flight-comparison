/**
 * true_total — the only figure worth ranking on.
 *
 * A headline fare is not comparable across carriers, because a checked bag is
 * included on some fares and not others. This adds the cost of topping every
 * passenger up to one checked bag, using the curated table in
 * config/carrier-fees.yml.
 */

/**
 * Look up a carrier, falling back deliberately pessimistically: an unknown
 * carrier is assumed to include no bags, so it is never flattered into
 * looking cheaper than it really is.
 */
export function carrierPolicy(fees, carrierCode, fareBrand) {
  const entry = fees.carriers?.[carrierCode];
  if (!entry) {
    return {
      name: carrierCode || 'Unknown',
      bagsIncluded: fees.fallback.bags_included_per_passenger,
      extraBagEachWay: fees.fallback.extra_bag_gbp_each_way,
      confidence: fees.fallback.confidence,
      assumed: true,
    };
  }

  // A hand-baggage-only brand overrides the carrier's usual allowance.
  const brands = entry.hand_baggage_only_brands ?? [];
  const isHandBaggageOnly =
    fareBrand != null &&
    brands.some((b) => String(fareBrand).toLowerCase().includes(b.toLowerCase()));

  return {
    name: entry.name ?? carrierCode,
    bagsIncluded: isHandBaggageOnly ? 0 : entry.bags_included_per_passenger,
    extraBagEachWay: entry.extra_bag_gbp_each_way,
    confidence: entry.confidence ?? 'low',
    assumed: false,
    handBaggageOnly: isHandBaggageOnly,
    checkedAt: entry.checked_at ?? null,
  };
}

/**
 * @param fare      headline total for the whole party
 * @param directions 1 for a one-way leg, 2 for a return
 */
export function trueTotal({ fare, carrier, fareBrand, fees, trip, passengers, directions }) {
  const policy = carrierPolicy(fees, carrier, fareBrand);
  const bagsWanted = Math.min(trip.checked_bags, passengers);

  // Bags are charged per passenger per direction, so a passenger who already
  // has an included bag needs topping up on both legs of a return.
  const shortfallPerPassenger = Math.max(0, 1 - policy.bagsIncluded);
  const passengersNeedingBags = Math.min(bagsWanted, passengers);
  const bagCost =
    shortfallPerPassenger *
    passengersNeedingBags *
    directions *
    policy.extraBagEachWay;

  return {
    fare: round2(fare),
    bagCost: round2(bagCost),
    trueTotal: round2(fare + bagCost),
    bagsIncludedPerPassenger: policy.bagsIncluded,
    carrierName: policy.name,
    baggageConfidence: policy.confidence,
    baggageAssumed: policy.assumed === true,
  };
}

/**
 * Split-ticket price for an itinerary: the cheapest outbound leg plus the
 * cheapest return leg, each already bag-adjusted. Returns null if either leg
 * has no priced offer yet, which is the normal state before fares go on sale.
 */
export function composeSplitTicket(outBest, backBest) {
  if (!outBest || !backBest) return null;
  return {
    fare: round2(outBest.fare + backBest.fare),
    bagCost: round2(outBest.bagCost + backBest.bagCost),
    trueTotal: round2(outBest.trueTotal + backBest.trueTotal),
    carriers: [outBest.carrier, backBest.carrier].filter(Boolean),
    outCarrier: outBest.carrier ?? null,
    backCarrier: backBest.carrier ?? null,
  };
}

/** Shape B flies home from Miami, which means a one-way car hire. */
export function carHireAdjustment(fees, shape) {
  const cfg = fees.one_way_car_hire;
  if (!cfg || shape !== 'B') return { applied: 0, note: null };
  return {
    applied: cfg.apply ? cfg.estimate_gbp : 0,
    note: cfg.apply
      ? null
      : `Excludes an estimated £${cfg.estimate_gbp} one-way car hire drop-off fee`,
  };
}

export function round2(n) {
  return Math.round(n * 100) / 100;
}
