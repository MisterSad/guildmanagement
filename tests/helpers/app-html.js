/**
 * tests/helpers/app-html.js
 *
 * The page's full markup, for tests that read it as text. Since 2026-10-04 the
 * admin tab panels and the OCR modal are not in index.html: they ship in the
 * admin chunk (src/modules/app/admin-panels.html, ocr-modal.html) and
 * startAdmin() puts each fragment in place of its slot. This does the same
 * substitution, so a test sees the DOM an admin's browser builds.
 */
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

export const ADMIN_FRAGMENTS = [
  ['<div id="admin-panels-slot" hidden></div>', 'src/modules/app/admin-panels.html'],
  ['<div id="admin-ocr-slot" hidden></div>', 'src/modules/app/ocr-modal.html'],
];

/** index.html with every admin fragment mounted where its slot is. */
export function appHtml() {
  let html = read('index.html');
  for (const [slot, file] of ADMIN_FRAGMENTS) {
    if (!html.includes(slot)) throw new Error(`index.html lost its slot ${slot}`);
    html = html.replace(slot, read(file).replace(/\n$/, ''));
  }
  return html;
}
