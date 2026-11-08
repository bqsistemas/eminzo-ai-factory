// The engine version ranges a repository may pin in factory/config.json `engine`. Zero dependencies.
// Accepted forms: 1.2.3, 1.2.x (or 1.2.*), 1.x (or 1.x.x), ^1.2.3, ~1.2.3, >=1.2.3 and >=1.2.3 <2.0.0.

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const NUM = '(0|[1-9]\\d*)';

/** [major, minor, patch] or null. Pre-release and build tags are not supported. */
export function parseVersion(text) {
  const m = VERSION.exec(typeof text === 'string' ? text.trim() : '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

const compare = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);

/** A predicate over a parsed version, or null when `text` is not an accepted range. */
export function parseRange(text) {
  if (typeof text !== 'string') return null;
  const range = text.trim();
  let m;
  if ((m = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}$`).exec(range))) {
    const want = parseVersion(range);
    return (v) => compare(v, want) === 0;
  }
  if ((m = new RegExp(`^${NUM}\\.${NUM}\\.[x*]$`).exec(range))) {
    const [major, minor] = [Number(m[1]), Number(m[2])];
    return (v) => v[0] === major && v[1] === minor;
  }
  if ((m = new RegExp(`^${NUM}\\.[x*](?:\\.[x*])?$`).exec(range))) {
    const major = Number(m[1]);
    return (v) => v[0] === major;
  }
  if ((m = new RegExp(`^\\^(${NUM}\\.${NUM}\\.${NUM})$`).exec(range))) {
    const low = parseVersion(m[1]);
    if (low[0] > 0) return (v) => v[0] === low[0] && compare(v, low) >= 0;
    if (low[1] > 0) return (v) => v[0] === 0 && v[1] === low[1] && compare(v, low) >= 0;
    return (v) => compare(v, low) === 0; // npm: ^0.0.z is exactly 0.0.z
  }
  if ((m = new RegExp(`^~(${NUM}\\.${NUM}\\.${NUM})$`).exec(range))) {
    const low = parseVersion(m[1]);
    return (v) => v[0] === low[0] && v[1] === low[1] && compare(v, low) >= 0;
  }
  if ((m = new RegExp(`^>=\\s*(${NUM}\\.${NUM}\\.${NUM})(?:\\s+<\\s*(${NUM}\\.${NUM}\\.${NUM}))?$`).exec(range))) {
    const low = parseVersion(m[1]);
    const high = m[5] ? parseVersion(m[5]) : null;
    return (v) => compare(v, low) >= 0 && (!high || compare(v, high) < 0);
  }
  return null;
}

/** True when `version` is in `range`. Throws when the range (or the version) is not one this CLI accepts. */
export function satisfies(version, range) {
  const v = parseVersion(version);
  if (!v) throw new Error(`not a version: ${JSON.stringify(version)}`);
  const test = parseRange(range);
  if (!test) throw new Error(`not a supported range: ${JSON.stringify(range)} (use 1.2.3, 1.2.x, 1.x, ^1.2.3, ~1.2.3 or >=1.2.3 <2.0.0)`);
  return test(v);
}

/** The range `eminzo enable` pins for a version: its minor, e.g. 0.4.x. */
export const minorRange = (version) => {
  const v = parseVersion(version);
  if (!v) throw new Error(`not a version: ${JSON.stringify(version)}`);
  return `${v[0]}.${v[1]}.x`;
};
