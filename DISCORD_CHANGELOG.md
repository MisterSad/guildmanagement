📢 **FGF Guild Management Tool Update — CHANG_V3.17.1**

Welcome to V3.17.1! This release brings major UX polish to the Roster and Matchup views, streamlines OCR scanning, introduces animated skeleton loaders across the app, and hardens underlying security and privacy. Full breakdown below.

### ✨ Compact AI Metric Scanners Menu
- **What changed**: The row of 8 individual OCR buttons (Members, Power, Fleet, Tech, Flagship, Champs, Crew, Glory) previously took up significant vertical and horizontal space above the roster table, wrapping awkwardly on smaller screens.
- **The upgrade**: I've consolidated all 8 scanner tools into a single, polished **[ ✨ AI Metric Scanners ▾ ]** dropdown menu.
- **The benefit**: Your roster toolbar is now clean and uncluttered. Clicking the menu reveals all 8 scanner options with their familiar icons, and the menu automatically closes as soon as you select a scan or click anywhere outside.

### ⚡ Tactical Force Matrix: Tabular Alignment & Collapsible Timezones
- **Pixel-Perfect Number Alignment**: All 8 numeric military columns (Power, Fleet, Tech, Flagship, Champs, Crew, Glory, and Rally Score) now use monospaced tabular numerals (`tabular-nums`) and strict right alignment. Millions and billions now align vertically down every row, making power comparisons effortless at a glance.
- **Collapsible Timezone Coverage**: The 24-hour player timezone distribution graph above the roster has been converted into a collapsible drawer, collapsed by default (`[ Expand ▾ ]`). You can toggle it open anytime with a single click or keyboard shortcut (`Enter`/`Space`) when scheduling battle shifts, without it pushing the member list off your screen.

### 🏆 Smarter Leaderboard: Clean Empty States & No Fake Podiums
- **No more zero-point podiums**: Filtering an event (SvS, GvG, Arms Race) on a week with no recorded scores previously showed an awkward podium with 0 pts and random member names.
- **Clear empty state**: The fake podium is now suppressed when no scores exist, replaced by an intuitive empty state displaying a subtle trophy icon, a clear "No event data for this period" title, and helpful guidance to select another week or run an OCR scan.

### 🎨 Smooth Animated Skeleton Loaders
- **Goodbye jittery spinners**: I've replaced raw "Loading..." text strings and spinning circles across deferred views with smooth, animated skeleton silhouettes matching the exact shape of the upcoming data:
  - **SvS & GvG Matchup**: Shows alliance matchup blocks (Server A vs Server B), the central VS badge, and dual 5-row roster cards.
  - **Draft Board**: Shows the filter toolbar and ranked player table rows.
  - **Bug Tickets**: Shows 4 ticket cards complete with badges, title bars, and action buttons.
  - **Buy Me a Coffee**: Shows the app status badge, 3 donation tier buttons, and custom contribution card.
- Respects system accessibility preferences (`prefers-reduced-motion`) for players sensitive to animations.

### 🛡️ Event History Safety & Arms Race Fix
- **Safe Event Deletions**: In the Event History modal, the destructive "Delete" button has been completely isolated from regular modal controls with distinct red hazard styling, preventing accidental log deletions when reviewing past battles.
- **Arms Race Subtitle**: Restored the missing subtitle localization in the Arms Race event header.

### 🔒 Security, Privacy & Performance Hardening
- **E2EE Privacy Protection**: Decrypted end-to-end encrypted messages are now retained strictly in temporary browser memory and purged from persistent local storage.
- **Zero-Trust Hardening**: Enforced strict SSRF protection on Discord webhook dispatches, added strict Zod schemas against AI prompt injection on OCR processing, and validated all edge function inputs.

*Thank you for your feedback, bug reports, and suggestions! As always, feel free to report issues or suggest ideas using the Report a Bug button or via Discord.* 🚀⚔️
