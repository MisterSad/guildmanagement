/**
 * discord-verification-worker/week.js
 *
 * The ISO week's Monday, in UTC.
 *
 * This is the same rule as getWeekStartIso() in
 * supabase/functions/_shared/player-actions.ts. It exists twice because the
 * worker is plain Node and cannot import a Deno `.ts` module, and it lives in
 * its own file rather than inline in index.js so a test can import BOTH copies
 * and compare them instead of trusting a comment.
 *
 * It matters more than it looks: every Glory score the bot submits is filed
 * under this date, the Stats page groups by it, and 14 of production's 55,739
 * participation rows already carry a week_start that is not a Monday -- which
 * rendered as phantom columns with nobody present. A second implementation that
 * drifted by a day would file scores into weeks the app does not believe in.
 */
export function getWeekStartIso(date) {
  const d = new Date(date);
  const day = d.getUTCDay();
  const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), diff));
  const pad = (n) => String(n).padStart(2, "0");
  return `${monday.getUTCFullYear()}-${pad(monday.getUTCMonth() + 1)}-${pad(monday.getUTCDate())}`;
}
