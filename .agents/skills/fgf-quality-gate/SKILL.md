---
name: fgf-quality-gate
description: >-
  Strict 2026 quality verification and regression prevention runner.
  Use before finalizing any code modification, completing a user prompt, or creating a pull request.
---

# FGF Quality Gate & Regression Prevention Skill

## Mandatory 3-Step Verification Battery
Execute the following verification sequence before marking any task as complete:

```bash
# 1. Static TypeScript Check (0 errors strictly required)
npm run type-check

# 2. Automated Vitest Unit Suite (All tests must pass, 220+ green)
npm test

# 3. Production Bundle Build (Clean build into dist/ required)
npm run build
```

## Regression Prevention Checklist
1. **Zero Console Errors**: Ensure no unhandled promise rejections or runtime syntax errors are introduced.
2. **State Store Subscriptions**: Verify all event listeners or store subscribers added in components are cleaned up on unmount.
3. **No Per-Guild Hardcoding**: Verify grep search for `=== 'ALPHA'` or similar returns zero domain logic hacks.
4. **Deterministic Session Keys**: Verify test coverage exists for any new or modified event session calculation.
