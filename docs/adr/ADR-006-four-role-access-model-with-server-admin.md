# ADR-006: Four-Role Zero-Trust Access Model with Server Admin Support

- **Status**: **Accepted**
- **Date**: 2026-08-15
- **Deciders**: HawkEye (Architect) & Antigravity (AI System)
- **Supersedes / Extends**: [ADR-001](./ADR-001-three-role-zero-trust-access-model.md)

---

## Context

Originally, the SaaS access model partitioned users into three roles:
1. `super_admin` (Global master across all servers and tenants)
2. `guild_admin` (Single-guild tenant admin)
3. `member` (Zero direct DB access, player portal only)

As the platform expanded across multiple gaming servers with alliances spanning several guilds on the same server, server federation leaders needed the capability to administer, review rosters, dispatch Discord webhooks, and manage events across all guilds belonging to their specific server, without granting them global `super_admin` privileges or access to guilds on other servers.

---

## Decision

We introduce the **`server_admin`** role level, creating a unified Four-Role Zero-Trust Access Model:

| Role | Database & REST Scope | UI Access |
| :--- | :--- | :--- |
| `super_admin` | Global read & write across **all guild tenants** and all servers. | Full Admin Command Center + Cross-Guild Draft Ranking, Server Matchups, System Diagnostics (`#tab-system-logs`). |
| `server_admin` | Reads & writes **all guilds matching their assigned `server_number`**. | Command Center with dynamic server-scoped Guild Switcher dropdown. Can manage rosters, active events, scores, sanctions, and webhooks for all guilds on their server. |
| `guild_admin` | Reads & writes **only their own single guild tenant**. | Command Center locked to their specific guild: Members, Active Events, Scores, Sanctions, Guild Settings. |
| `member` | **ZERO direct database access**. Receives `[]` or denial on all tenant tables. | **Player Portal only** (`portal.js` / `PortalService`), communicating via `member-portal` Edge Function with cryptographically validated identity. |

### Technical Architecture & Invariants

1. **Database Schema & RLS**:
   - `public.accounts` table has `server_number TEXT` column.
   - `public.is_server_admin()` function checks JWT claim or `accounts.role = 'server_admin'`.
   - `public.gm_can_read_guilds()`, `public.gm_can_read_guild_data()`, `public.gm_can_read_account()`, and `public.check_user_guild_write_access()` resolve `server_number` matching between `accounts` and `guilds`.
   - Mono-tenant fallback `(v_user_guild IS NULL AND p_guild = 'ALPHA')` has been eliminated.

2. **Edge Functions RBAC**:
   - `admin-accounts`, `discord-webhook-proxy`, and `ocr-guild-members` authorize `server_admin`.
   - `admin-accounts` scopes list actions by server when invoked by a `server_admin`.
   - `discord-webhook-proxy` enforces server matching if a `server_admin` issues a webhook dispatch.

3. **Frontend & Guild Switcher**:
   - `src/core/auth/roles.ts` and `gm-utils.js` export `isServerAdmin()`.
   - `AppState.serverRestriction` tracks server assignments.
   - `shell.js` dynamically renders the topbar guild switcher for `server_admin` containing only the guilds on their assigned server.

---

## Consequences & Anti-Regression Rules

- **Never allow cross-server leaks**: A `server_admin` must never read or modify data from a guild on a different server number.
- **Never grant Super Admin diagnostics**: A `server_admin` must not access `#tab-system-logs` or system audit logs.
- **Uniformity**: Every new RPC, Edge Function, or UI module must check `is_server_admin()` and handle server-scoping uniformly.
