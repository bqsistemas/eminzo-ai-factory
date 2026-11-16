// The dashboard's cache of job files. Only files that exist are remembered: a stage writes intake.md, build.md and the round-N/
// reviews while board.json stays the same, so "not written yet" (or a failed read) must be asked again, never kept.
export function createArtifactCache(fetchText) {
  const pending = new Map();
  return {
    load(key, url) {
      if (!pending.has(key)) {
        const p = Promise.resolve().then(() => fetchText(url)).catch(() => null).then((text) => {
          if (text === null && pending.get(key) === p) pending.delete(key);
          return text;
        });
        pending.set(key, p);
      }
      return pending.get(key);
    },
    clear() { pending.clear(); },
  };
}
