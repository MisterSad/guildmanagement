/**
 * discord-verification-worker/rename-only.js
 *
 * Rename-only channels (public.discord_channel_modes): a profile screenshot
 * posted there renames its author after what it shows; the live bot also
 * reacts ✅ or ❌ on it, and nothing else happens. The Edge Function owns the decision (it re-reads the mode itself);
 * this module only finds the screenshots, forwards them, and, for the backfill,
 * walks a channel's history and keeps a record of what it already did.
 *
 * No side effects at import and every dependency is passed in, so the flow
 * runs under test without Discord, Supabase or the network.
 */

/** channel id -> Discord server id, from discord_channel_modes rows. */
export function renameOnlyChannelMap(rows) {
  const map = new Map();
  for (const row of rows || []) {
    if (row?.mode !== "rename_only") continue;
    const channelId = String(row.channel_id || "").trim();
    const serverId = String(row.discord_server_id || "").trim();
    if (channelId && serverId) map.set(channelId, serverId);
  }
  return map;
}

/** The first image attachment of a message, from discord.js or raw REST shapes. */
export function imageAttachmentOf(attachments) {
  const list = attachments
    ? typeof attachments.values === "function" && !Array.isArray(attachments)
      ? [...attachments.values()]
      : attachments
    : [];
  const found = list.find((a) => {
    const type = a?.contentType ?? a?.content_type ?? "";
    return typeof type === "string" && type.startsWith("image/");
  });
  return found ? { url: found.url, contentType: found.contentType ?? found.content_type } : null;
}

/**
 * Whether a forwarded screenshot earns ✅: the author now carries the name the
 * screenshot gives (renamed, or already named so). Anything else is ❌,
 * including a member the bot may not rename and a transient failure.
 */
export function renameOnlySucceeded(result) {
  return result?.ok === true;
}

/**
 * Downloads one screenshot and posts it to discord-profile-verification.
 * Returns { status, result } -- result is the parsed JSON body, or null.
 */
export async function forwardScreenshot({ fetchImpl, functionUrl, secret, userId, username, serverId, channelId, attachment, dryRun = false }) {
  const img = await fetchImpl(attachment.url);
  if (!img.ok) return { status: 0, result: { ok: false, error: "download_failed", http_status: img.status } };
  const buf = Buffer.from(await img.arrayBuffer());
  const res = await fetchImpl(functionUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify({
      discord_user_id: userId,
      discord_username: username,
      discord_server_id: serverId,
      channel_id: channelId,
      image_base64: buf.toString("base64"),
      mime_type: attachment.contentType,
      ...(dryRun ? { dry_run: true } : {}),
    }),
  });
  let result = null;
  try {
    result = await res.json();
  } catch {
    result = null;
  }
  return { status: res.status, result };
}

/**
 * Discord snowflakes grow with time; compare them as BigInt, never as numbers
 * (they exceed 2^53) nor as strings of different lengths.
 */
export function newerFirst(a, b) {
  const x = BigInt(a);
  const y = BigInt(b);
  return x === y ? 0 : x > y ? -1 : 1;
}

/**
 * Every message of a channel, newest first, page by page (100 per request,
 * Discord's maximum), until a page comes back short.
 * `fetchPage(beforeId | null)` returns raw message objects, newest first.
 */
export async function listChannelMessages(fetchPage, { pageSize = 100, onPage } = {}) {
  const all = [];
  let before = null;
  for (;;) {
    const page = await fetchPage(before);
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    onPage?.(all.length);
    if (page.length < pageSize) break;
    before = page.reduce((oldest, m) => (newerFirst(m.id, oldest) > 0 ? m.id : oldest), page[0].id);
  }
  return all;
}

/**
 * Groups screenshots by author: [{ userId, username, candidates: [{ messageId,
 * attachment }] }], each author's screenshots newest first. Bots and messages
 * without an image are left out.
 */
export function screenshotsByAuthor(messages) {
  const byUser = new Map();
  for (const m of messages || []) {
    if (!m?.author || m.author.bot) continue;
    const attachment = imageAttachmentOf(m.attachments);
    if (!attachment) continue;
    let entry = byUser.get(m.author.id);
    if (!entry) {
      entry = { userId: m.author.id, username: m.author.username, candidates: [] };
      byUser.set(m.author.id, entry);
    }
    entry.candidates.push({ messageId: m.id, attachment });
  }
  const authors = [...byUser.values()];
  for (const a of authors) a.candidates.sort((x, y) => newerFirst(x.messageId, y.messageId));
  // Oldest-posting authors first: a stable, reproducible order between runs.
  authors.sort((x, y) => newerFirst(y.candidates[0].messageId, x.candidates[0].messageId));
  return authors;
}

// What a screenshot's answer means for the backfill.
//   done     -- renamed, or already carrying the nickname: record and move on
//   invalid  -- this picture is not a readable profile: try the next older one
//   left     -- the author is no longer a member: skip, not recorded (may rejoin)
//   refused  -- Discord forbids renaming them (owner, role above the bot): record
//   wait     -- Discord rate limit: sleep `retry_after`, then the same screenshot again
//   deferred -- transient (attempt throttle, OCR provider, network): leave it for the next run
export function classify(status, result) {
  if (result?.ok === true) return "done";
  const error = result?.error;
  if (error === "missing_fields_in_ocr" || error === "json_parse_failed" || error === "download_failed") return "invalid";
  if (error === "member_not_found") return "left";
  if (error === "cannot_rename") return "refused";
  if (error === "discord_rate_limited") return "wait";
  return "deferred";
}

/**
 * Renames every author of a rename-only channel after their most recent valid
 * screenshot.
 *
 * Idempotent: `state.authors[userId]` records the newest screenshot already
 * settled for that author; a re-run skips them unless they posted a newer one.
 * A dry run reads and decides, but neither renames nor records.
 *
 * deps:
 *   messages          raw channel messages (any order)
 *   isMember(userId)  -> Promise<boolean>   (false: left the server)
 *   forward(author, candidate, { dryRun }) -> Promise<{ status, result }>
 *   sleep(ms), log(line), saveState(state), now()
 */
export async function runBackfill({ messages, state, isMember, forward, sleep, log, saveState, now = () => new Date().toISOString(), dryRun = false, maxWaits = 5, pauseMs = 1000 }) {
  const summary = { authors: 0, renamed: 0, unchanged: 0, wouldRename: 0, alreadyDone: 0, left: 0, invalid: 0, refused: 0, deferred: 0 };
  state.authors = state.authors || {};
  const authors = screenshotsByAuthor(messages);
  summary.authors = authors.length;

  for (const author of authors) {
    const newest = author.candidates[0].messageId;
    const recorded = state.authors[author.userId];
    if (recorded && recorded.messageId === newest) {
      summary.alreadyDone++;
      continue;
    }
    if (!(await isMember(author.userId))) {
      summary.left++;
      log(`skip ${author.userId}: no longer a member`);
      continue;
    }

    let outcome = "invalid";
    let settled = null;
    for (const candidate of author.candidates) {
      let waits = 0;
      let answer;
      let kind;
      for (;;) {
        answer = await forward(author, candidate, { dryRun });
        kind = classify(answer.status, answer.result);
        if (kind !== "wait" || waits >= maxWaits) break;
        waits++;
        const seconds = Number(answer.result?.retry_after) || 5;
        log(`rate limited by Discord, waiting ${seconds}s`);
        await sleep(Math.ceil(seconds * 1000));
      }
      if (pauseMs) await sleep(pauseMs);
      if (kind === "invalid") continue;
      outcome = kind === "wait" ? "deferred" : kind;
      settled = { candidate, result: answer.result };
      break;
    }

    if (outcome === "done") {
      const r = settled.result;
      if (r.dry_run) {
        summary.wouldRename++;
        log(`would rename ${author.userId}: ${JSON.stringify(r.previous_nickname)} -> ${JSON.stringify(r.nickname)} (message ${settled.candidate.messageId})`);
      } else if (r.changed) {
        summary.renamed++;
        log(`renamed ${author.userId}: ${JSON.stringify(r.previous_nickname)} -> ${JSON.stringify(r.nickname)}`);
      } else {
        summary.unchanged++;
        log(`unchanged ${author.userId}: already ${JSON.stringify(r.nickname)}`);
      }
      if (!dryRun) state.authors[author.userId] = { messageId: newest, outcome: "done", nickname: r.nickname, at: now() };
    } else if (outcome === "left") {
      summary.left++;
      log(`skip ${author.userId}: no longer a member`);
    } else if (outcome === "refused") {
      summary.refused++;
      log(`cannot rename ${author.userId} (server owner, or a role above the bot's)`);
      if (!dryRun) state.authors[author.userId] = { messageId: newest, outcome: "refused", at: now() };
    } else if (outcome === "invalid") {
      summary.invalid++;
      log(`no readable profile among ${author.candidates.length} screenshot(s) of ${author.userId}`);
      if (!dryRun) state.authors[author.userId] = { messageId: newest, outcome: "invalid", at: now() };
    } else {
      summary.deferred++;
      log(`deferred ${author.userId}: ${settled?.result?.error || "unknown error"} (re-run later)`);
    }
    if (!dryRun) await saveState(state);
  }
  return summary;
}
