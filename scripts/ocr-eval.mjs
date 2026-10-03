#!/usr/bin/env node
/**
 * Scores an `ocr-guild-members` response against a ground-truth fixture.
 *
 *   node scripts/ocr-eval.mjs tests/fixtures/ocr/leaderboard-2026-10-01.json response.json
 *
 * `response.json` is the function's JSON body, saved from the browser's network
 * panel. A row counts as read when its pseudo matches (case and spacing
 * ignored, guild tag stripped); its score must also match to count as exact.
 * Recall is the acceptance criterion of ADR-021, not an impression.
 */
import fs from 'node:fs';

const [fixturePath, responsePath] = process.argv.slice(2);
if (!fixturePath || !responsePath) {
  console.error('usage: node scripts/ocr-eval.mjs <fixture.json> <response.json>');
  process.exit(2);
}

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const response = JSON.parse(fs.readFileSync(responsePath, 'utf8'));
const players = Array.isArray(response.players) ? response.players : [];

const key = (s) => String(s || '').replace(/^\[[^\]]*\]/, '').toLowerCase().replace(/\s+/g, '');

const byKey = new Map(players.map((p) => [key(p.pseudo), p]));
const truthKeys = new Set(fixture.rows.map((r) => key(r.pseudo)));

const missed = [];
const wrongScore = [];
for (const row of fixture.rows) {
  const got = byKey.get(key(row.pseudo));
  if (!got) { missed.push(`${row.position} ${row.pseudo}`); continue; }
  if (String(got.raw_score || '').replace(/\s+/g, '') !== row.raw_score) {
    wrongScore.push(`${row.position} ${row.pseudo}: ${got.raw_score} (expected ${row.raw_score})`);
  }
}
const extra = players.filter((p) => !truthKeys.has(key(p.pseudo))).map((p) => p.pseudo);

const total = fixture.rows.length;
const read = total - missed.length;
console.log(`recall     ${read}/${total} (${((100 * read) / total).toFixed(1)}%)`);
console.log(`precision  ${players.length - extra.length}/${players.length}`);
console.log(`exact score ${read - wrongScore.length}/${read}`);
if (response.coverage) console.log(`coverage   ${JSON.stringify(response.coverage)}  passes=${response.passes ?? '?'}`);
if (missed.length) console.log(`missed:     ${missed.join(', ')}`);
if (extra.length) console.log(`not in truth: ${extra.join(', ')}`);
if (wrongScore.length) console.log(`score mismatches:\n  ${wrongScore.join('\n  ')}`);
process.exit(missed.length === 0 ? 0 : 1);
