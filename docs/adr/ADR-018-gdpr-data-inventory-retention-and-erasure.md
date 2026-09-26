# ADR-018: GDPR — Data Inventory, Retention and Erasure

- **Status**: Accepted
- **Date**: 2026-09-27
- **Authors**: Executed in Phase 8

---

## 1. Context

The repository contained **zero occurrences** of `gdpr`, `consent`, `privacy`, `retention` or `erasure` in `src/`. There was no privacy policy, no retention beyond the 24-hour throttle purges, and no way to honour an erasure request. The operator is established in France, so the GDPR applies regardless of the service being free.

The more serious problem was that `terms.html` — a published, legally binding document — made two factual claims the database contradicted:

1. **"Zero Personally Identifiable Information … Stored data is limited to publicly visible in-game pseudonyms, UTC timezone offsets, aggregate game statistical values, and isolated synthetic authentication tokens."** The live column catalogue also holds sign-in **IP addresses**, **Discord user ids and usernames across six tables**, Discord handles on guild requests, in-game player UIDs, bcrypt hashes, reversibly-encrypted passwords, and free-text ticket descriptions. An online identifier is personal data under Art. 4(1); so is an IP address.
2. **Erasure "via automated database cascades (`ON DELETE CASCADE`)".** Only five auth-adjacent tables cascaded from `accounts`; the two wiki tables were `NO ACTION` and would have **blocked** an account delete outright. Roster and participation records have no foreign key to `accounts` at all.

A false statement in a published legal document is worse than a missing one.

## 2. Decision

1. **`privacy.html`** — a real notice: controller, exhaustive inventory, purposes with Art. 6(1) legal bases, retention, processors, transfers, rights, the CNIL, breach notification, children. Both legal pages share `legal.css`, a root stylesheet `scripts/build.js` copies verbatim; they remain **not** Vite entry points (see finding H3 — that would inject the whole application bundle into a static legal page).
2. **Retention** — `gm_apply_data_retention()`, scheduled daily at 04:30. 12 months for the audit trail and the pseudonym history, 90 days for a closed guild request's Discord handle, and the expiry sweep of `ocr_cache` that **`gm_cleanup_expired_ocr_cache()` was written for but no cron ever called**.
3. **Erasure** — `gm_erase_player(guild, uid)` and `gm_erase_account(account_id)`, both `SECURITY DEFINER`, neither callable by `anon`. Player erasure reuses `check_user_guild_write_access`; account erasure is `super_admin` only.
4. **The wiki foreign keys** move from `NO ACTION` to `SET NULL`, with the author *pseudonym* overwritten separately — the FK is not the identifying part, the name beside it is.

## 3. Consequences & Invariants

- **Erasure is an `UPDATE`, not a `DELETE`, and this is not a stylistic choice.** Seven tables declare `FOREIGN KEY (guild, pseudo) REFERENCES guild_members(guild, pseudo) ON UPDATE CASCADE ON DELETE CASCADE`. The first implementation deleted the roster row and *then* anonymised the statistics — and matched **zero rows every time**, because the delete had already cascaded them away, while still reporting success. Renaming the roster row propagates the token to all seven children atomically. **Anyone editing `gm_erase_player` must preserve this ordering.**
- **The roster row survives as an unattributable placeholder** (pseudonym replaced by a token, `uid`/`timezone` cleared). That is what keeps the participation records valid and a guild's historical totals unchanged. Deleting it is a different operation — the ordinary "remove member" action — and it destroys the history.
- **The anonymisation token derives from a per-erasure random salt that is never stored**, so two erasures of the same pseudonym produce different tokens and the mapping cannot be rebuilt or matched.
- **Ban records are deliberately retained in full**, identifier included: a ban list cannot stop a specific player rejoining without it (Art. 17(3)). This is **disclosed in `privacy.html` §6.5**, not applied silently.
- **A retention window must never be retroactively destructive.** The migration asserts at apply time that every window deletes **zero rows** on its first run and aborts otherwise. Shortening a window is a change to a published commitment: change `privacy.html` §4 in the same release.
- **The processor list is enforced by the CSP.** `connect-src` in `vercel.json` is the authoritative list of third parties the browser may reach; `tests/gdpr_compliance.test.js` maps each host to a disclosed name and fails on any that is missing. Server-side processors (Gemini, Render) can never appear there and are asserted separately.
- **Sentry is a live processor.** A local build has no DSN and `initSentry()` returns false, which makes it look inert; the **deployed** bundle carries an `ingest.de.sentry.io` DSN injected at build time. Check the deployed bundle, not a local one.
- **No consent banner is required**, and the reason is verifiable rather than assumed: no cookies, no analytics, and browser storage limited to session and display state — strictly necessary, so exempt under Art. 5(3) of Directive 2002/58/EC.
