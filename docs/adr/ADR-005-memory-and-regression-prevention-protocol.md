# ADR-005: Continuous Memory & Anti-Regression Quality Protocol

## Status
**Accepted** (2026-08-15)

## Context
As the codebase grows and multiple AI agents/developers collaborate, preventing regressions and retaining architectural context across sessions is critical to maintaining zero-defect velocity.

## Decision
1. **Multi-Layered Agent Memory**:
   - **Declarative Memory**: `AGENTS.md` and `docs/adr/` acting as the authoritative sources of truth for architectural invariants.
   - **Semantic/Knowledge Graph Memory**: `@modelcontextprotocol/server-memory` configured in Antigravity to retain learned patterns, resolved bugs, and domain links.
   - **Procedural Skills**: Specialized Antigravity skills in `.agents/skills/` (`fgf-saas-architect`, `fgf-rls-security`, `fgf-quality-gate`, `fgf-changelog-discord`, `fgf-memory-keeper`).
2. **Strict 3-Step Verification Quality Gate**:
   - `npm run type-check` (0 TypeScript errors)
   - `npm test` (all Vitest suites green)
   - `npm run build` (clean Vite bundle)
3. **Changelog Synchronization**:
   - Cumulative technical history in `CHANGELOG.md`.
   - Single-day user-facing digest in `DISCORD_CHANGELOG.md` written in the first-person singular ("I") voice.

## Invariants to Preserve
- Never mark a feature or fix as complete without running the 3-step quality gate.
- Update ADRs or memory knowledge graph whenever an invariant changes or a novel bug is resolved.
