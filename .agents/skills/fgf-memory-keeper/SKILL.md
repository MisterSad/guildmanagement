---
name: fgf-memory-keeper
description: >-
  Long-term memory management and error prevention system for Antigravity.
  Use when learning new architectural patterns, logging resolved bugs, recording decisions in ADRs, or managing MCP memory entities.
---

# FGF Memory Keeper & Anti-Regression System

## How Memory Operates in Antigravity
1. **MCP Knowledge Graph (`@modelcontextprotocol/server-memory`)**:
   - Entities represent core domains (`EventSessions`, `ThreeRoleSecurity`, `PubSubStore`, `EdgeFunctions`).
   - Observations record past bug patterns and their verified solutions.
   - Relations link architectural constraints to implementation files.

2. **Architecture Decision Records (`docs/adr/`)**:
   - Every significant architectural decision or permanent lesson learned is saved in `docs/adr/ADR-XXX-<name>.md`.
   - ADRs are indexed in `docs/adr/README.md` and read before starting major refactoring tasks.

3. **Continuous Learning via `/learn`**:
   - When a subtle bug or tenant requirement is identified, record it immediately with `/learn` or update the relevant ADR.

## Anti-Regression Protocol
- Before modifying core modules (`src/core/config/events.ts`, `src/core/api/supabase.ts`, `supabase/migrations/`):
  1. Review existing ADRs in `docs/adr/`.
  2. Ensure all 3 synchronization targets for session IDs remain identical.
  3. Verify TypeScript typings with `npm run type-check`.
  4. Run the full unit suite (`npm test`).
