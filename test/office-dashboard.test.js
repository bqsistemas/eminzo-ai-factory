import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { dashboardSource } from './helpers/dashboard-source.js';

const read = (path) =>
  readFile(new URL(`../factory/${path}`, import.meta.url), "utf8");
const html = dashboardSource();
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];

test("dashboard keeps the office as an accessible, responsive board companion", () => {
  const positions = [
    '<header class="top">',
    'id="stat-jobs"',
    'id="stat-running"',
    'id="stat-agents"',
    'id="stat-cost"',
    'id="office"',
    'id="office-canvas"',
    'id="office-hits"',
    'id="office-status"',
    'id="office-live"',
    'id="pipeline"',
    '<main class="board" id="board">',
  ].map((needle) => {
    const position = html.indexOf(needle);
    assert.ok(position >= 0, `missing ${needle}`);
    return position;
  });
  assert.deepEqual(
    positions,
    [...positions].sort((a, b) => a - b),
  );
  assert.match(html.match(/id="office-live"[^>]*>/)[0], /aria-live/);
  assert.match(script, /createOffice\(/);
  assert.match(script, /openDrawer\(id\)/);
  assert.match(css, /#office-canvas\s*\{[^}]*image-rendering:\s*auto/);
  assert.match(css, /@media \(max-width: 900px\)/);
  assert.match(css, /prefers-color-scheme|data-theme/);
  assert.doesNotMatch(script, /https?:\/\//);
  assert.doesNotMatch(html, /\b(?:Pause|Stop)\b/);
  const i18n = JSON.parse(
    html.match(
      /<script type="application\/json" id="i18n">([\s\S]*?)<\/script>/,
    )[1],
  );
  for (const language of ["en", "es", "pt"])
    for (const key of ["statJobs", "statRunning", "statAgents", "statCost"])
      assert.ok(i18n[language][key]);
});

test("office renderer is isolated from board lifecycle and supports reduced motion and keyboard hotspots", async () => {
  const renderer = await read("office-renderer.js");
  assert.match(renderer, /prefers-reduced-motion/);
  assert.match(renderer, /retargetWalker/);
  assert.match(renderer, /aria-label/);
  assert.match(renderer, /hitTargets\(state,jobs\)/);
  assert.match(renderer, /`\+\$\{count\} more`/);
  assert.match(renderer, /overflow\)\{overflowCounts\.set/);
  assert.match(renderer, /openJob\(btn\.dataset\.id\)/);
  assert.match(renderer, /describeOffice\(state\)/);
  assert.doesNotMatch(renderer, /localStorage|fetch\(|setInterval/);
  for (const module of [
    "office-map.js",
    "office-navigation.js",
    "sprite-atlas.js",
  ])
    await access(new URL(`../factory/${module}`, import.meta.url));
});

test("the coordinate atlas is reproducible from the untouched source sheet", async () => {
  const atlas = JSON.parse(
    await readFile(
      new URL("../factory/assets/pixel-office-2/atlas.json", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(atlas.sourceSize, { width: 768, height: 512 });
  assert.equal(Object.keys(atlas.characters).length, 8);
  const generator = await read("assets/pixel-office-2/build_atlas.py").catch(
    () => null,
  );
  assert.ok(
    generator ||
      (await access(
        new URL(
          "../factory/assets/pixel-office-2/build_atlas.py",
          import.meta.url,
        ),
      ).then(() => true)),
  );
  await access(
    new URL(
      "../factory/assets/pixel-office-2/PixelOfficeAssets.png",
      import.meta.url,
    ),
  );
  await access(
    new URL(
      "../factory/assets/pixel-office-2/office-atlas-assets.png",
      import.meta.url,
    ),
  );
});
