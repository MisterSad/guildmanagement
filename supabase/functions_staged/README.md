# functions_staged : versions multi-tenant (NE PAS déployer seules)

`auth-login`, `admin-accounts`, `event-reminders` sont les **v2 multi-tenant**
de celles de `../functions/`. `billing-webhook` est **nouvelle** (Paddle,
saas_strategy.md §8 — voir `../../docs/paddle-setup.md`). Toutes supposent le
schéma de `../migrations_staged/20990101000000_multitenant.sql`
(claim JWT `guild_id`, tables `guilds`/`notification_locks`/`guild_event_schedules`,
RPC `gm_account_info` et signatures `gm_admin_*(p_guild_id, …)`).

Déployées contre le schéma actuel, elles **cassent l'authentification et les
rappels**. Suivre `docs/cutover-runbook.md` : migration + fonctions + frontend
forment une release atomique.
