# 🏛️ Architecture Decision Records (ADR) — FGF Guild Management Tool

This directory serves as the **permanent architectural memory** for human developers and autonomous AI agents.
Whenever major design decisions, patterns, or critical bug resolutions are established, they are documented here to prevent regressions and knowledge loss.

## Index of Architectural Decisions

| ADR ID | Title | Status | Date |
| :--- | :--- | :--- | :--- |
| [ADR-001](./ADR-001-three-role-zero-trust-access-model.md) | Three-Role Zero-Trust Access Model & Player Portal Isolation | **Accepted** | 2026-08-12 |
| [ADR-002](./ADR-002-deterministic-event-session-ids.md) | Deterministic Event Session IDs & ISO Week Synchronization | **Accepted** | 2026-08-12 |
| [ADR-003](./ADR-003-multi-tenant-saas-invariants.md) | Strict Multi-Tenant SaaS Invariants & Cross-Tenant Uniformity | **Accepted** | 2026-08-12 |
| [ADR-004](./ADR-004-consolidated-database-schema-and-security-definer.md) | Master DDL Consolidation & SECURITY DEFINER Protocol | **Accepted** | 2026-08-12 |
| [ADR-005](./ADR-005-memory-and-regression-prevention-protocol.md) | Continuous Memory & Anti-Regression Quality Protocol | **Accepted** | 2026-08-15 |
| [ADR-006](./ADR-006-four-role-access-model-with-server-admin.md) | Four-Role Zero-Trust Access Model with Server Admin Support | **Accepted** | 2026-08-15 |

---

## 📝 Format for New ADRs
When adding an ADR, follow this structure:
1. **Title**: `ADR-XXX-<name>.md`
2. **Status**: Proposed / Accepted / Superseded
3. **Context**: Why was this decision necessary?
4. **Decision**: What was decided and how is it implemented?
5. **Consequences & Invariants**: What must future developers/agents never break?
