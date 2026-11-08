// Runs INSIDE the page (puppeteer serializes the function, so it must not touch anything
// outside itself). Returns the snapshot factory/lib/visual-analysis.js analyzes.
export function collectSnapshot(opts) {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'TITLE']);
  const LIMIT = 5000;
  const cls = (e) => [...e.classList].slice(0, 2).map((c) => `.${CSS.escape(c)}`).join('');
  const part = (e) => {
    if (e.id) return `#${CSS.escape(e.id)}`;
    const tag = e.tagName.toLowerCase();
    const same = e.parentElement ? [...e.parentElement.children].filter((c) => c.tagName === e.tagName) : [];
    return `${tag}${cls(e)}${same.length > 1 ? `:nth-of-type(${same.indexOf(e) + 1})` : ''}`;
  };
  const selector = (e) => {
    const parts = [];
    for (let at = e; at && at.nodeType === 1 && parts.length < 3; at = at.parentElement) {
      parts.unshift(part(at));
      if (at.id) break;
    }
    return parts.join(' > ');
  };
  const els = [];
  const index = new Map();
  let truncated = false;
  const walk = (e, parent) => {
    if (SKIP.has(e.tagName)) return;
    const cs = getComputedStyle(e);
    if (cs.display === 'none') return;
    if (els.length >= LIMIT) { truncated = true; return; }
    const r = e.getBoundingClientRect();
    let own = false;
    for (const n of e.childNodes) if (n.nodeType === 3 && n.nodeValue.trim()) own = true;
    const visible = cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
    const i = els.length;
    index.set(e, i);
    els.push({
      i, p: parent, sel: selector(e),
      x: Math.round(r.x * 10) / 10, y: Math.round(r.y * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10,
      sw: e.scrollWidth, cw: e.clientWidth, ox: cs.overflowX, to: cs.textOverflow,
      color: cs.color, tf: cs.webkitTextFillColor, ign: ((e.closest('[data-visual-ignore]') || { getAttribute: () => '' }).getAttribute('data-visual-ignore')) || '', bg: cs.backgroundColor, bgImg: cs.backgroundImage !== 'none',
      op: parseFloat(cs.opacity), fs: parseFloat(cs.fontSize), fw: parseInt(cs.fontWeight, 10) || 400,
      text: own && visible, mark: e.hasAttribute('data-visual-check') && visible, dis: e.matches(':disabled'),
    });
    for (const c of e.children) walk(c, i);
  };
  walk(document.documentElement, -1);
  const anims = opts && opts.animations
    ? document.getAnimations()
      .filter((a) => a.constructor.name === 'CSSAnimation' && a.playState === 'running' && a.effect && a.effect.target)
      .map((a) => ({ sel: selector(a.effect.target), name: a.animationName }))
    : [];
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    doc: { sw: document.documentElement.scrollWidth },
    reducedMotion: Boolean(opts && opts.animations),
    truncated, els, anims,
  };
}
