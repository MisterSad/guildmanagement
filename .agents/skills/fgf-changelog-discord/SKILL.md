---
name: fgf-changelog-discord
description: >-
  Strict protocol for generating cumulative CHANGELOG.md and user-centric DISCORD_CHANGELOG.md.
  Use when completing releases, features, bug fixes, or optimizations to prepare changelogs.
---

# FGF Changelog & Discord Release Protocol

## Dual Changelog Standard (Strictly Enforced)

### 1. `CHANGELOG.md` (Cumulative Engineering History)
- Incrementally append under standard sections: `## New`, `## Fixed`, `## Performance`.
- Keep chronological order of releases.
- 100% English.

### 2. `DISCORD_CHANGELOG.md` (User-Centric Discord Digest)
- **Target Audience**: Guild leaders and players. Explain tangible benefits, not just code diffs.
- **Tone**: Friendly, clear, human. Strictly use **"I"** (first-person singular solo creator), never "WE".
- **Version Format**:
  - Major platform overhauls: `CHANG_V<Major>` (e.g. `CHANG_V1`, `CHANG_V2`)
  - Minor updates and fixes: `CHANG_V<Major>.<Minor>` (e.g. `CHANG_V1.1`, `CHANG_V2.1`)
- **Title Format**: `📢 **FGF Guild Management Tool Update — CHANG_V<X>[.<Y>]**`
- **Formatting**: Rich Markdown with emojis (`🚀`, `🔒`, `⚡`, `🧪`, `🛡️`, `⚔️`).
- Ready for immediate copy-pasting to the Discord announcement channel.
- 100% English.
