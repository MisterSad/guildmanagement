📢 **FGF Guild Management Tool Update — CHANG_V3.20.2**

Hey everyone! I just pushed a targeted fix and ergonomics update for manual war score entry (SvS and GvG) and the event history review modal! ⚔️📊

---

### 💾 1. Reliable Manual Score Saving on Active Events (SvS & GvG)
- **What changed**:
  - Fixed an issue where manual score entries on the active SvS/GvG page failed to save when some day columns were left blank.
  - Saisies now save immediately when you press Enter or navigate away from the input, in addition to the standard 700ms typing debounce.
  - When saving scores, a clear confirmation toast (*"Daily scores saved."*) now pops up so you always know your changes were securely recorded.
  - Entering a positive score automatically ticks the player's participation checkbox and updates the live overview stats.
- **The benefit**: Fast, smooth, and 100% reliable score tracking during daily SvS and GvG wars without lost inputs or silent failures!

---

### 📜 2. History Modal: Permanent Bottom Scrollbar & Sticky Headers
- **What changed**:
  - Expanded the large modal dialog width to 1080px so all 9 war columns fit comfortably on desktop screens.
  - Pinned the horizontal scrollbar directly above the modal footer. You no longer have to scroll through 100 players just to reach the horizontal scrollbar at the bottom!
  - Made table headers sticky at the top with an opaque background, keeping column titles clearly in view as you scroll down the roster.
  - Fixed a column alignment bug in granular history mode where the participation column was missing from member rows, ensuring every score lines up perfectly under its correct day.
- **The benefit**: Reviewing and editing past war sessions is now effortless, whether on a desktop monitor or on mobile!

---

📢 **FGF Guild Management Tool Update — CHANG_V3.20.1**

Hey everyone! I just pushed an important quality-of-life update to our Discord verification bot (`#verification`) to eliminate notification spam, support multi-guild server setups, and keep the channel completely spotless! 🤖✨

---

### 🔇 1. Zero Role Pings & Silent Notifications
- **What changed**: The bot will no longer ping or tag the `@VISITOR` role (or any guild role) when posting verification messages. All role names are now displayed in clean bold text, and outgoing messages enforce Discord mention suppression (`allowed_mentions`).
- **The benefit**: No more annoying server-wide pings when new members verify!

---

### 🛡️ 2. Smart Multi-Guild Support ([PR1M], [OMG], [IMK])
- **What changed**: The verification engine now automatically recognizes all active guilds sharing the server:
  - Players with **`[PR1M]`**, **`[OMG]`**, or **`[IMK]`** screenshots are automatically routed to their proper guild role and roster, with their nickname formatted to `[TAG] Pseudo #Server`.
  - If a player previously had the `VISITOR` role, it is automatically removed upon receiving their guild role.
  - **All external guilds** (or unrecognized tags) are strictly assigned the **`VISITOR`** role and renamed with the **`[VISITOR]`** tag prefix (e.g. `[VISITOR] Player #1058`), without touching guild rosters.
- **The benefit**: Smooth, fully automated onboarding for all allied guilds on the server while keeping alliance rosters isolated and accurate!

---

### 🧹 3. Zero-Clutter Auto-Cleanup in `#verification`
- **What changed**:
  - Uploaded player screenshots are automatically deleted after 5 seconds.
  - Bot verification replies are automatically deleted after 15 seconds.
- **The benefit**: The verification channel stays completely clean and readable at all times!

---

📢 **FGF Guild Management Tool Update — CHANG_V3.20.0**

Hey everyone! With the inter-server migration season heating up, I just released a brand new major feature to give our leadership teams a decisive strategic edge: the **Migration Hub**! 🗺️⚔️

Managing intel across alliances and rival servers used to mean scattered Discord notes, lost screenshots, and endless back-and-forth. The Migration Hub solves this with a dedicated, top-end collaborative wiki built directly into the Admin dashboard:

---

### 🏛️ 1. Dual-Scope Intel: Guild & Server Spaces
- **What changed**: The Migration Hub is split into two secure operational scopes:
  - **Guild Intel**: Private space for your alliance officers to track confidential recruit inquiries, internal diplomacy, and target rosters.
  - **Server Intel**: Shared state-level intelligence room for authorized cross-alliance leaders to align on defense pacts, incoming/outgoing whales, and server migration balance.
- **The benefit**: Clear separation between alliance secrets and state-wide cooperation. Zero data leakage, backed by rigorous Zero-Trust database security policies!

---

### 📸 2. Instant Screenshot Paste & Smart Client Compression
- **What changed**: You can paste screenshots directly into notes with `Ctrl+V` or drag-and-drop them into the editor. I built an automatic client-side compressor that optimizes images to clean WebP format before upload.
- **The benefit**: Bulky 5–10MB mobile screenshots are instantly compressed down to ~100KB without visible quality loss. Uploads are lightning-fast, storage is conserved, and you can inspect full-size captures anytime using the built-in lightbox viewer.

---

### 🧠 3. Gemini AI Note Summaries & Scope Briefings
- **What changed**: Powered by Google's Gemini 2.5 Flash API, I added instant AI intelligence summaries:
  - **Single Page Summary**: Quickly condenses lengthy meeting notes, candidate stats, or negotiation logs into key takeaways.
  - **Executive Briefing**: Synthesizes all active notes across the entire Guild or Server scope into an executive briefing covering ongoing discussions, key candidates, identified risks, and recommended next steps.
- **The benefit**: Catch up on days of complex diplomatic talks in 5 seconds. Perfect for busy officers jumping in before war calls.

---

### ⚡ 4. Real-Time Collaboration & Discord Export
- **What changed**: The wiki syncs in real-time across all active officer sessions. When an officer creates or updates a note, your page list refreshes immediately. Plus, I added a one-click **"Export Discord"** button that formats your intel notes into beautiful Discord markdown.
- **The benefit**: Seamless live coordination and zero copy-paste friction when sharing public updates with your guild!

---

📢 **FGF Guild Management Tool Update — CHANG_V3.19.1**

Hey everyone! I just rolled out a quality-of-life update addressing international guild coordination: **Automated IANA Timezones & Dynamic Officer Clocks**! 🌍⏰

Coordinating wars, events, and rosters across multiple continents is now effortless and completely error-free:

---

### 🌍 1. True IANA Timezones & Automatic Daylight Saving Time (DST)
- **What changed**: Instead of relying on static numerical UTC offsets that break every time countries change their clocks, you can now select real geographic timezones (e.g. `Europe/Paris`, `America/New_York`, `Asia/Tokyo`, `Australia/Sydney`).
- **The benefit**: Automatic summer/winter time handling! The system dynamically calculates the exact live offset and local time with zero maintenance required.

---

### 🎯 2. One-Click "Auto-Detect" in Player Portal & Member Roster
- **What changed**: I added a one-click **"Auto"** detection button in both the Player Portal ("My Timezone" card) and the Admin Roster edit dialog.
- **The benefit**: Players can set their timezone in a single tap without needing to calculate their UTC offset. Officers can also easily configure timezones for mobile members.

---

### ⏰ 3. Dynamic Overview Clocks (Synced with Officers)
- **What changed**: The Command Center Overview now automatically derives live clocks from your **R4 and R5 guild officers** who have set their timezone. I also added an **"Auto-sync with Officers"** button in the Clock Management modal.
- **The benefit**: No more manually configuring clocks in a JSON list! Your dashboard immediately shows when your leadership team is awake and available for war calls.

---

### 🛡️ 4. Zero-Pollution Invariant for Pseudos & OCR
- **What changed**: Timezones are stored in a dedicated database column and displayed using elegant UI chips and rich tooltips.
- **The benefit**: Player nicknames in the database remain completely untouched—no messy `[UTC+2]` tags that could break OCR screenshot imports or combat logs.

---

📢 **FGF Guild Management Tool Update — CHANG_V3.19.0**

Welcome to V3.19.0! I have just deployed our most comprehensive security, performance, and reliability overhaul to date. Following an in-depth architectural audit, I completed an 18-ticket modernization sprint to make your guild management faster, more secure, and completely rock-solid.

Here is everything I updated in this major release:

---

### ⚡ 1. Instant OCR Deduplication (<50ms Roster Scans!)
- **What changed**: I added a cryptographic SHA-256 caching layer to the Gemini Vision OCR scanner. When you re-scan screenshots or video frames that haven't changed, the system instantly recognizes them.
- **The benefit**: Re-analyzing rosters or checking historical screenshots now responds in under **50 milliseconds** instead of waiting 5–10 seconds for AI inference. Less waiting, zero token waste, and instant results!

---

### 🛡️ 2. Fortified Zero-Trust Security & Multi-Tenant Isolation
- **What changed**: I enforced `FORCE ROW LEVEL SECURITY` across all 26 database tables, locked down role resolution directly to verified cryptographic JWT claims in memory (ignoring tampered browser storage), and sanitized all dynamic HTML inputs against XSS.
- **The benefit**: Absolute peace of mind. Your guild's battle plans, member rosters, sanctions, and strategic data are mathematically isolated and strictly inaccessible to any other guild or unauthorized user.

---

### 🔔 3. Punctual 5-Minute Event Reminders
- **What changed**: The automated event reminder daemon was rescheduled from a 15-minute polling tick down to **5 minutes**, with atomic database locks to prevent duplicate notifications.
- **The benefit**: You and your members will receive your Discord alerts right on time for Calamity, Dominion, and GvG wars. No more delayed pings or missed battle windows!

---

### 🔒 4. Enterprise-Grade Security Headers (OWASP & HSTS)
- **What changed**: I upgraded our HTTP transport headers in `vercel.json` with strict HSTS (`max-age=63072000; preload`), Cross-Origin Opener Policy (COOP `same-origin`), Cross-Origin Resource Policy (CORP `same-origin`), and automatic HTTPS request upgrades.
- **The benefit**: Top-tier browser protection against Man-in-the-Middle attacks, clickjacking, and cross-window data leaks, meeting strict OWASP and Mozilla Observatory standards.

---

### ♿ 5. Silky Smooth & Accessible Modal Dialogs (WCAG 2.2 AA)
- **What changed**: I completely overhauled all modal windows and alert dialogs. They now feature bidirectional keyboard focus traps (`Tab` / `Shift+Tab`), background inertness (`aria-hidden="true"`), and automatic focus restoration when closing.
- **The benefit**: Keyboard navigation is seamless, dialogs feel native and snappy on mobile and desktop, and the interface is 100% accessible to screen readers.

---

### 📈 6. Real-Time APM & Privacy-First Crash Reporting
- **What changed**: I integrated `@sentry/browser` along with an authenticated client error reporting RPC. Every error is automatically sanitized to redact passwords, JWT tokens, and sensitive API keys before sending.
- **The benefit**: If a rare issue occurs on your device, I receive an instant diagnostic report with guild context and app version, allowing me to ship fixes before it impacts your guild operations—all while keeping your private credentials 100% confidential.

---

### 🚀 7. Snappier Queries & Zero-Lag Database Operations
- **What changed**: I eliminated redundant indexes and added high-performance composite foreign key indexes on our largest tables (`event_participants` with 20k+ rows, `shadowfront_squads`, `sanctions`, and `guild_transfers`).
- **The benefit**: Roster updates, member transfers, and season score calculations are instantaneous. No more database table locks or sluggish queries during peak war hours!

---

### 📋 Release V3.19.0 Summary Matrix

| Domain | Key Enhancement | Tangible Benefit |
| :--- | :--- | :--- |
| **OCR Scanner** | SHA-256 Caching Layer | **<50ms** instant response on repeated scans |
| **Event Alarms** | 5-Minute Precision Cron | Punctual Discord alerts, zero missed war windows |
| **Data Security** | `FORCE RLS` on 26 Tables | 100% tenant isolation, Zero-Trust RBAC |
| **Web Security** | Strict HSTS, COOP & CORP | Enterprise-grade protection against MitM & leaks |
| **User Experience** | WCAG 2.2 AA Dialog Trap | Fluid keyboard navigation, native modal feel |
| **Reliability** | Sentry APM + Scrubbing | Proactive bug detection without credential leaks |
| **Database** | Composite FK Indexes | Zero sequential scans, lag-free bulk updates |

---

Thank you for your continuous feedback and dedication to making FGF the ultimate guild command center! 🚀