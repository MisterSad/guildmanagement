/**
 * discord-verification-worker/rally.js
 *
 * Pure helpers for /call-to-arms, kept out of index.js (which logs in to
 * Discord on import) so they can be tested.
 */

// /call-to-arms answers live in `discord_rally_responses`, not in memory: a
// Map here lost every answer on each restart, and the next click rebuilt the
// post from nothing (migration 20260930174334).
export const CTA_CLICK_SUFFIX = "\n\n**Click a button below to declare your attendance:**";

/** Rebuild the rally's three lists from its stored rows. */
export function ctaSessionFromRows(eventName, description, rows) {
  const session = { eventName, description, present: new Map(), late: new Map(), absent: new Map() };
  for (const r of rows || []) {
    const bucket = session[r.status];
    if (!(bucket instanceof Map)) continue;
    bucket.set(r.discord_user_id, { pseudo: r.pseudo, power: Number(r.power) || 0, fleet: Number(r.fleet) || 0 });
  }
  return session;
}

/** The event name and description, read back from the rally's own embed. */
export function ctaHeaderFromEmbed(embed) {
  const title = (embed && embed.title) || "";
  const eventName = title.replace(/^⚔️ Call to Arms: /, "").trim() || "Call to Arms";
  const desc = (embed && embed.description) || "";
  const cut = desc.indexOf(CTA_CLICK_SUFFIX);
  const description = cut > 0 ? desc.slice(0, cut) : null;
  return { eventName, description };
}
