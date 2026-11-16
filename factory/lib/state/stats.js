// Small, explicit statistics for the state answers: a quantile by nearest rank and the spread a person reads
// (typical value and the middle half). Kept here so the diagnosis and the estimate count the same way.

const round = (n, digits) => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

/** The value at quantile `p` (0..1) of `values` by nearest rank: index round(p * (n - 1)) of the sorted list. */
export function quantile(values, p) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.floor(p * (sorted.length - 1) + 0.5)];
}

/**
 * `{ n, low, typical, high, max }`: how many values, the 25th percentile, the median, the 75th percentile and
 * the largest. Every number is null for an empty list. `digits` rounds the output.
 */
export function spread(values, digits = 1) {
  const finite = values.filter((v) => Number.isFinite(v));
  const at = (p) => {
    const q = quantile(finite, p);
    return q === null ? null : round(q, digits);
  };
  return { n: finite.length, low: at(0.25), typical: at(0.5), high: at(0.75), max: finite.length ? round(Math.max(...finite), digits) : null };
}

/** `part / whole` rounded to three digits, or null when the whole is zero. */
export const share = (part, whole) => (whole ? round(part / whole, 3) : null);

export { round };
