# 🏛️ Architecture Decision Records (ADR) — FGF Guild Management Tool

This directory serves as the **permanent architectural memory** for human developers and autonomous AI agents.
Whenever major design decisions, patterns, or critical bug resolutions are established, they are documented here to prevent regressions and knowledge loss.

## Index of Architectural Decisions

| ADR ID | Title | Status | Date |
| :--- | :--- | :--- | :--- |
| [ADR-001](./ADR-001-three-role-zero-trust-access-model.md) | Three-Role Zero-Trust Access Model & Player Portal Isolation | **Superseded by ADR-006** | 2026-08-12 |
| [ADR-002](./ADR-002-deterministic-event-session-ids.md) | Deterministic Event Session IDs & ISO Week Synchronization | **Accepted** | 2026-08-12 |
| [ADR-003](./ADR-003-multi-tenant-saas-invariants.md) | Strict Multi-Tenant SaaS Invariants & Cross-Tenant Uniformity | **Accepted** | 2026-08-12 |
| [ADR-004](./ADR-004-consolidated-database-schema-and-security-definer.md) | Master DDL Consolidation & SECURITY DEFINER Protocol | **Accepted** | 2026-08-12 |
| [ADR-005](./ADR-005-memory-and-regression-prevention-protocol.md) | Continuous Memory & Anti-Regression Quality Protocol | **Accepted** | 2026-08-15 |
| [ADR-006](./ADR-006-four-role-access-model-with-server-admin.md) | Four-Role Zero-Trust Access Model with Server Admin Support | **Accepted** | 2026-08-15 |
| [ADR-007](./ADR-007-accounts-only-role-resolution.md) | Accounts-Only Role Resolution & JWT Metadata Deprecation | **Accepted** | 2026-08-23 |
| [ADR-008](./ADR-008-migration-protocol-v2.md) | Database Migration Protocol v2 & Clean Replay Guarantees | **Accepted** | 2026-08-23 |
| [ADR-009](./ADR-009-secrets-vault-only-policy.md) | Secrets Vault-Only Storage & Zero-Commit Rotation Policy | **Accepted** | 2026-08-23 |
| [ADR-010](./ADR-010-force-row-level-security-all-public-tables.md) | FORCE ROW LEVEL SECURITY Across All Public Tables | **Accepted** | 2026-09-20 |
| [ADR-011](./ADR-011-client-error-reporting-and-sentry-apm.md) | Client Error Reporting RPC, Sentry APM & CSP Hardening | **Accepted** | 2026-09-20 |
| [ADR-012](./ADR-012-sha256-ocr-deduplication-cache.md) | SHA-256 OCR Deduplication Cache for Gemini Vision | **Accepted** | 2026-09-20 |
| [ADR-013](./ADR-013-wcag-2-2-aa-dialog-accessibility-and-focus-trap.md) | WCAG 2.2 AA Modal Dialog Accessibility & Focus Trap | **Accepted** | 2026-09-20 |
| [ADR-014](./ADR-014-root-scripts-hygiene-and-discord-webhook-resilience.md) | Root Scripts Hygiene, Build Exclusion & Discord Webhook Rate-Limiting | **Accepted** | 2026-09-20 |
| [ADR-015](./ADR-015-permanently-free-no-payment-surface.md) | Permanently Free — No Payment Surface of Any Kind | **Accepted** | 2026-09-26 |
| [ADR-016](./ADR-016-pwa-and-web-push-retirement.md) | Retiring the PWA and Web Push — and the Ordering That Makes It Safe | **Accepted** | 2026-09-26 |
| [ADR-017](./ADR-017-deployed-edge-functions-must-be-versioned.md) | Every Deployed Edge Function Must Have Its Source Versioned Here | **Accepted** | 2026-09-27 |
| [ADR-018](./ADR-018-gdpr-data-inventory-retention-and-erasure.md) | GDPR — Data Inventory, Retention and Erasure | **Accepted** | 2026-09-27 |
| [ADR-019](./ADR-019-weekly-guild-snapshots.md) | Weekly Guild Snapshots, and Why the Aggregate Is Not Member-Grain | **Accepted** | 2026-09-27 |

---

## 📝 Format for New ADRs
When adding an ADR, follow this structure:
1. **Title**: `ADR-XXX-<name>.md`
2. **Status**: Proposed / Accepted / Superseded
3. **Context**: Why was this decision necessary?
4. **Decision**: What was decided and how is it implemented?
5. **Consequences & Invariants**: What must future developers/agents never break?
