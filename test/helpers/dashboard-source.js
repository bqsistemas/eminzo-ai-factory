// The dashboard's source as one text: dashboard.html with dashboard.css and dashboard.js put
// back where the page links them. The files are split so an agent reads only what it changes;
// the assertions about the dashboard as a whole read this. test/dashboard-split.test.js pins
// the split itself.
import { readFileSync } from 'node:fs';

const read = (name) => readFileSync(new URL(`../../factory/${name}`, import.meta.url), 'utf8');

export const CSS_LINK = '<link rel="stylesheet" href="dashboard.css">';
export const MODULE_TAG = '<script type="module" src="dashboard.js"></script>';

export function dashboardSource() {
  return read('dashboard.html')
    .replace(CSS_LINK, () => `<style>\n${read('dashboard.css')}</style>`)
    .replace(MODULE_TAG, () => `<script type="module">\n${read('dashboard.js')}</script>`);
}
