# ADR-022: The guild TAG is a mutable tenant key

- **Status**: Accepted
- **Date**: 2026-10-03
- **Supersedes**: none
- **Related**: ADR-003 (multi-tenant invariants), ADR-008 (migration protocol), ADR-019 (the `(guild, pseudo)` cascade), ADR-020 (Discord roles)

## Context

In game, a guild can change its TAG. In the app it could not: a renamed guild
had to ask for its tenant to be deleted and recreated, which throws away its
history.

The TAG is not an attribute of the tenant: it **is** the tenant key.
`guilds.id` is the primary key, and on 2026-10-03, 28 columns across 25 tables
carried it (measured with `information_schema.columns`). They fell into four
shapes:

| Shape | Count | Example |
|---|---|---|
| FK to `guilds(id)` | 14 | `war_sessions.guild` |
| Composite FK `(guild, pseudo)` to `guild_members` | 7 | `weekly_scores` |
| Composite FK carrying `guild` to another table | 1 | `event_daily_scores` → `war_sessions(guild, event_name, session_id)` |
| No FK at all | 9 | `accounts.guild`, `guild_config.guild`, `guild_members.guild` |

Only one of the 14 FKs to `guilds` cascaded an update. Several child tables
hang off two parents at once (`player_metrics_history` points at both `guilds`
and `guild_members`), so whichever parent moves first, the child is briefly
orphaned.

Introducing an immutable surrogate key (a UUID) and demoting the TAG to an
attribute was considered and rejected for now. It is the cleaner end state, but
it touches every table, every policy, every RPC and most of the front end. That
is a refactor in its own right, not the cost of one feature.

## Decision

**A rename moves the key in place, in one transaction:
`gm_rename_guild(p_guild, p_new_tag)`** (migration `20261003070904`).

1. Every FK whose child columns include a tag column is
   `DEFERRABLE INITIALLY IMMEDIATE`, and every FK to `guilds(id)` is also
   `ON UPDATE CASCADE`. The migration rebuilds them **from the catalogue**, not
   from a list, and aborts if one is left out.
2. The function runs `SET CONSTRAINTS ALL DEFERRED`, then:
   - updates `guild_members` (its cascade moves the seven roster children);
   - updates `guilds` (its cascade moves the 14 FK children);
   - updates the non-FK columns explicitly.

   It then runs `SET CONSTRAINTS ALL IMMEDIATE`, so a violation is raised
   inside the function rather than at commit. Normal statements are unaffected:
   `INITIALLY IMMEDIATE` means they still check row by row.
3. Cascade rather than "insert the new key, move the children, delete the old
   one". Every one of these FKs is `ON DELETE CASCADE`, so a child table
   missing from an explicit list would have been **silently wiped** by the
   final delete. With a cascading update, an FK added later without
   `ON UPDATE CASCADE` makes the rename **fail loudly** instead.

**Rules enforced server-side.** The client repeats only the format check, to
answer instantly.

- **Who:** the `super_admin`, or a `guild_admin` of that guild. A
  `server_admin` cannot rename, even though `check_user_guild_write_access`
  admits them.
- **Format:** the same as creation, `^[A-Z0-9_]{2,12}$` after uppercasing.
  Uniqueness is checked regardless of case.
- **Reserved tags:**
  - `DEMO` cannot be renamed, nor taken (`gm_reset_demo_tenant_data` keys on it).
  - A TAG held by a pending creation request is refused.
  - **A TAG that still owns rows from a deleted guild is refused.**
    `gm_delete_guild` leaves rows behind in the non-FK tables: the deleted CLAW
    still owns 6 bans, 12 absences and 59 audit lines. Reusing its TAG would
    hand those rows to another tenant.
    Since migration `20261003080433`, a deletion removes everything through
    `gm_purge_guild_data`, and the orphans already in production were cleaned
    up. The check stays as defence in depth.
- **Cooldown:** 7 days, enforced through `guild_tag_history`. The
  `super_admin` is exempt.
- **Display tag:** `guild_config.guild_tag`, the in-game display tag used by
  Discord mentions and OCR, is reset to `[NEW]`.

**The server decides who sees the UI.** `gm_guild_tag_history` returns
`can_rename` and `cooldown_applies`, computed with the same predicate as the
rename.

**The client reloads after renaming the active guild.** Before reloading, it
moves its own tag-keyed `localStorage` entries to the new TAG. A reload is the
one place where every module re-resolves its tenant. At sign-in, a persisted
selection that the guild switcher no longer lists is dropped.

## Consequences & invariants

- **A new column carrying a guild tag must be one of two things:**
  - covered by an FK to `guilds(id)` or `guild_members(guild, pseudo)` that is
    `DEFERRABLE INITIALLY IMMEDIATE`, with `ON UPDATE CASCADE` towards `guilds`;
  - **or** added to the explicit `UPDATE` list in `gm_rename_guild` and to the
    residual-data check.

  `tests/guild_rename_migration.test.js` derives the inventory from
  `src/types/database.generated.ts` and fails on a column that is neither.
  Regenerate the types after the schema change, or the test cannot see the
  column.
- **A new FK carrying a tag column must be created `DEFERRABLE INITIALLY
  IMMEDIATE`.** A non-deferrable one makes every rename fail. That is safe, but
  it breaks the feature.
- **Never cache a TAG somewhere long-lived without a refresh path.**
  - The Discord worker maps verification channels to TAGs and refreshes every
    5 minutes. For up to 5 minutes after a rename, verification in Discord
    fails visibly (`home_server_unknown`), and never writes under the old TAG.
  - Other admins' open tabs keep the old TAG until they reload. Their reads
    return nothing, and their writes are refused by RLS. Nothing is written
    under the old TAG.
- **Discord objects are not renamed.**
  - `/setup-server` named roles and channels after the old TAG.
  - `/reconcile-roles` finds the guild role **by name**, against the new
    display tag. The guild's Discord role has to be renamed by hand; the
    rename dialog says so.
- **Historical text keeps the old TAG.** `guild_creation_requests.guild_tag`,
  `war_sessions.opponent_snapshot` and `guild_tag_history.old_tag` are frozen
  on purpose.
- A UUID surrogate key remains the long-term option. If it is ever adopted,
  `gm_rename_guild` collapses to a single `UPDATE` of an attribute, and the
  deferrable FKs can return to plain ones.
