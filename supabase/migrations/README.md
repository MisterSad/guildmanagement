# Database migrations

**Production is the history of record.** Each file here is named after the version
that `supabase_migrations.schema_migrations` holds for it on production, and
`tests/migration_history.test.js` checks the directory against the snapshot in
`tests/fixtures/migration_history.json`.

## Applying a migration

1. Write `supabase/migrations/<any timestamp>_<name>.sql`.
2. Rehearse it on production inside a transaction that ends in a deliberate
   exception, so nothing commits. Then apply it with the Supabase MCP
   `apply_migration`, using the same `<name>`.
3. Read the version production recorded:
   `SELECT version, name FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 1;`
4. Rename the file to `<that version>_<name>.sql`. Add the entry to
   `tests/fixtures/migration_history.json`.
5. If the schema changed, regenerate `src/types/database.generated.ts`.

**Never use `supabase db push`.** It compares file names with recorded versions.
Before 2026-10-03, 40 files carried a different timestamp from production, so it
would have tried to replay 40 migrations that had already been applied.

## Renumbered on 2026-10-03 (audit DB-02, INF-02, REC-02)

Production recorded these migrations under the time they were applied, not the
time in their file name. Six of the old names also had an impossible hour (24 to
29). The files were renamed with no change to their content. Older CHANGELOG
entries still cite the left-hand names.

| Old file name | Production version |
|---|---|
| `20260926080000_restrict_accounts_column_grants` | `20260926060420_restrict_accounts_column_grants` |
| `20260926080100_revoke_overreaching_function_grants` | `20260926060512_revoke_overreaching_function_grants` |
| `20260926120000_drop_web_push` | `20260926063112_drop_web_push` |
| `20260926120100_repair_push_table_dependents` | `20260926063407_repair_push_table_dependents` |
| `20260926120200_repair_demo_reset_push_subscriptions` | `20260926063533_repair_demo_reset_push_subscriptions` |
| `20260926140000_drop_dead_rpcs_and_diplomacy` | `20260926070155_drop_dead_rpcs_and_diplomacy` |
| `20260926160000_credential_integrity` | `20260926101947_credential_integrity` |
| `20260926180000_drop_payments` | `20260926153207_drop_payments` |
| `20260926190000_discord_oauth_state` | `20260926173028_discord_oauth_state` |
| `20260926200000_account_link_codes` | `20260926174708_account_link_codes` |
| `20260926210000_discord_claim` | `20260926180239_discord_claim` |
| `20260926220000_admin_invite_codes` | `20260926181134_admin_invite_codes` |
| `20260926230000_discord_onboarding` | `20260926182332_discord_onboarding` |
| `20260926240000_harden_client_error_reporting` | `20260926184503_harden_client_error_reporting` |
| `20260926250000_real_session_revocation` | `20260926185133_real_session_revocation` |
| `20260926260000_document_deny_all_tables` | `20260926191847_document_deny_all_tables` |
| `20260926270000_database_debt` | `20260926192432_database_debt` |
| `20260926280000_admin_list_server_number` | `20260926204850_admin_list_server_number` |
| `20260926290000_drop_legacy_transfer_wrapper` | `20260926212324_drop_legacy_transfer_wrapper` |
| `20260927100000_gdpr_retention_and_erasure` | `20260926223300_gdpr_retention_and_erasure` |
| `20260927120000_discord_multi_account_links` | `20260927001726_discord_multi_account_links` |
| `20260927140000_gm_stats_weeks` | `20260927105504_gm_stats_weeks` |
| `20260927150000_gm_stats_members_aggregate` | `20260927111234_gm_stats_members_aggregate` |
| `20260927160000_gm_stats_members_reliability` | `20260927112753_gm_stats_members_reliability` |
| `20260927170000_gm_stats_health` | `20260927114032_gm_stats_health` |
| `20260927180000_guild_weekly_snapshots` | `20260927114958_guild_weekly_snapshots` |
| `20260927190000_gm_stats_events` | `20260927120934_gm_stats_events` |
| `20260927200000_drop_gm_stats_data` | `20260927121137_drop_gm_stats_data` |
| `20260927210000_gm_player_stats` | `20260927123150_gm_player_stats` |
| `20260928100000_glory_upsert_service_role_parity` | `20260927233028_glory_upsert_service_role_parity` |
| `20260928110000_war_opponents_stop_reading_guilds_name` | `20260927233228_war_opponents_stop_reading_guilds_name` |
| `20260930100000_fractional_timezone_offsets` | `20260930165759_fractional_timezone_offsets` |
| `20260930110000_r5_handover_by_guild_admin` | `20260930165802_r5_handover_by_guild_admin` |
| `20260930120000_daily_scores_service_role_parity` | `20260930173247_daily_scores_service_role_parity` |
| `20260930130000_discord_rally_responses` | `20260930174334_discord_rally_responses` |
| `20260930140000_transfer_requester_cannot_approve` | `20260930182818_transfer_requester_cannot_approve` |
| `20260930150000_protect_r5_from_deletion` | `20260930182821_protect_r5_from_deletion` |
| `20260930160000_least_privilege_table_grants` | `20260930185459_least_privilege_table_grants` |
| `20260930170000_least_privilege_function_defaults` | `20260930190017_least_privilege_function_defaults` |
| `20261001200000_ocr_videos_bucket` | `20261001194004_ocr_videos_bucket` |

Six migrations had been applied on production without any file. They were
restored byte for byte from `schema_migrations.statements` and checked by md5:
`20260926223728_gdpr_erase_player_via_cascade`,
`20260927105636_gm_stats_weeks_delegate_authz`,
`20260927112053_gm_stats_members_window_glory`,
`20260927115059_guild_weekly_snapshots_normalise_week`,
`20260927123426_gm_stats_health_normalise_week`,
`20260927123537_gm_stats_health_quality_bound_future`.
