📢 **FGF Guild Management Tool Update — CHANG_V3.31.0**

**🔒 Server #1058 — the guild role now follows the roster, not the screenshot.**

Posting a profile screenshot in verification used to be enough to be handed **[PR1M]**, **[OMG]** or **[IMK]** — and it wrote you into that guild's member list at the same time. The check and the thing being checked were the same write.

The member list decides now. If your officers have already added you: role assigned, stats updated, exactly as before. If not: you get **[PENDING]**, **nothing** is written to the roster, and your officers get a message naming you. They add you in the tool, you post your screenshot again, done.

You are matched on your in-game **UID**. If your roster line still carried a placeholder UID — 11 of you in OMEGA, 55 in PSA — your screenshot fills the real one in. A pseudo already on file under a *different* UID is refused on purpose: that one is an officer's call, not mine.

**Officers: create a role named `[PENDING]`** on your server, below my own role, or a held player falls back to `[VISITOR]`.

Guilds on other game servers are untouched: a tag from another server resolves to `[VISITOR]` here, and can never be blocked over there.

**🛠️ `/update-stats glory:` never saved anything — and told you it had.**

Six weeks of "✅ Stats Updated" on a write that was refused every single time: it called a database function that does not exist. Fixed, and a refused write now fails out loud instead of lying to you. Resubmit your Glory. `/glory` was refused too, same cause, same fix.

**⚔️ Leaders:** picking a **guild** as a war opponent failed every time (only "server" worked). Fixed. `/setup-server` now refuses a guild that is not registered, instead of building 31 channels for a typo.

**👥 Two accounts on one Discord** (admin + player)? `/myinfo`, `/absent`, `/update-stats` and `/profile` were crashing for you. The bot asks which one you mean now.

Reload the page. **If something looks wrong, tell me.** 🫡

---

📢 **FGF Guild Management Tool Update — CHANG_V3.30.0**

**The Stats page has been rebuilt and your scores have changed.** Here is why. 📊

**The old score counted everything the guild ran equally.** One real week: 7 Arms Race sessions, 3 DTR, 1 Shadowfront, 1 SvS, 1 GvG. The Arms Race is daily and nobody does all of it — 16% participation across the whole app — so it decided **54%** of your score. The SvS decided **7.7%**. That is how someone who attended every war could read 14%.

**It is now a rate per event type, weighted by your guild's own coefficients**, with the breakdown beside the number:

`SvS 2/3 · GvG 2/2 · Shadowfront 3/3 · DTR 5/8 · Arms Race 12/24 → 69%`

I measured a real guild first: 32 members up, 30 down, biggest move 11 points. What really changes is the **order** — wars now count for more than dailies. **New members are no longer marked absent for wars fought before they joined.**

**⚔️ New on the admin page**, from data the app already had: your **war record day by day** (one guild reads GvG 6W–0L, SvS 1W–5L, and you see *which* days you lose), your **power curve**, your roster split into **Core / Regular / Occasional / Dormant** with a trend arrow each, and a card saying **how complete your own data is**.

**🎮 Players: your Portal now agrees with your admin.** It did not before — one guild showed 48% in the Portal and 32% on the admin page, because the Portal counted Glory and unapproved scores. One calculation now, shared by both. The four cards atop your Portal were also broken; they are back.

**Your Glory badge was wrong for over half of you.** It ignored your oldest Glory week, so if you recorded Glory exactly once — **658 of you** — your best counted as zero and you got no badge. **51 of you jump to the top tier.**

Weeks before this one are rebuilt from today's roster, so older figures are a reconstruction, not a photograph. From now on each week is frozen every Monday.

Reload the page. **If a number looks wrong, tell me.** 🫡

---

📢 **FGF Guild Management Tool Update — CHANG_V3.24.0**

Quick fix. **Scanning a video into OCR was failing** where the same screens worked as screenshots. Reported on Glory, but it could hit any of the scans. 🛠️

**What was happening.** Every scan is cut into small batches sent to the AI. About one batch in fifty came back with its answer cut off mid-sentence, and when that happened **the whole scan was thrown away**, including every batch that had worked. A screenshot is one batch, so you almost never saw it. A video is about eighteen, so roughly one video scan in three died.

**What I changed.**

- The AI no longer spends its answer budget "thinking" before replying. That is what truncated the answers, and it was also making those scans take 30 seconds instead of 10.
- If a batch does fail, the scan **keeps the batches that worked** and tells you *"1 of 18 batches failed"* so you know the table is incomplete before you commit it.
- The results table already greys out and unchecks anyone it did not see, so a partial scan still cannot mark your members as departed by accident. That safety net is unchanged.

**What you should do.** Nothing, just reload the page. If a video scan ever warns you that a batch failed, re-run it or top it up with a screenshot of the missing rows.

---

📢 **FGF Guild Management Tool Update — CHANG_V3.23.0**

Hey everyone! Short one. **The old "Register Player" tab is gone**, and this post is the new instructions for getting into the Player Portal. If you already signed in with Discord, nothing changes for you. 🛸

---

## 🎮 Players: how you get in now

There is one door on the login page, and it is **Sign in with Discord**.

**What you need first:** your guild's **join code**. Ask your guild admin, it is permanent and they can paste it straight into your guild chat.

1. Open the app and click **Sign in with Discord**. Authorise it. It asks Discord for your username and your ID, nothing else. Not your email, not which servers you are in.
2. You come back to a small window. Pick **"Join a guild"**.
3. Enter the **join code**, and **your in-game UID**.
4. Your guild admin approves you, and you are in.

Two things worth knowing:

- **Your UID has to already be on the guild roster.** If your admin has not added you yet, that step fails. Ask them first, then come back.
- **No password anywhere.** You never pick one, so there is nothing to forget and nothing for me to store.

## 👑 Guild admins: two minutes of work

- **Grab your join code** from **Accounts & Access** and pin it in your guild chat. It is the only thing your members need.
- **Make sure new members are on the roster** before they try to join. Their UID is what links the two.
- **Your own account**: if you have not linked your Discord yet, do it from the login page. Your identifier and password still work until then.

## 🧹 Why the old tab went

"Register Player" made you invent an identifier and a password, then waited for approval anyway. Every account it created was one more that would have to be converted to Discord later. It was making work for both of us, so it is gone, along with the "Request a Guild" form. **Starting a new guild** is still self-service: **Sign in with Discord**, then **"Create a guild"**, with your guild tag and server number. Your Discord account needs to be 30 days old, that is the only gate.

Nobody is locked out by this. I checked every guild before removing it: all of them that have members already have a join code.

---

That's it. Reload the page if you have it open from earlier. Ping me if anything looks off. 🫡

---

📢 **FGF Guild Management Tool Update — CHANG_V3.22.0**

Hey everyone! Big one. **You can now sign in with Discord**, and that is going to become the normal way in. There is also a pile of cleanup underneath, and a promise about the code at the end that I want you to read. 🛸

---

## 🔑 Sign in with Discord

The login page now leads with **Sign in with Discord**. Your identifier and password still work, sitting underneath. Nothing is being taken away from you today.

**Why bother?** No password to remember, no password to lose, and no password for me to store. It is also the only way I can reach you reliably if something goes wrong with your account.

### 👑 Guild admins: linking your existing account

You already have an account, so you are connecting it, not making a new one.

1. Click **Sign in with Discord** and authorise the app. It only ever asks Discord for your username and ID. It never sees your email and never sees which servers you are in.
2. You come back to a small window. Pick **"I already have an account"**.
3. Type your usual identifier and password, once.
4. Done. From then on, Discord is how you sign in.

⚠️ **Read this before you do it.** Once you link, **your password is deleted**. Discord becomes the only way into that account. That is the point of the exercise, but it is not reversible by you. If you lose access to your Discord account, ask me or another admin for a **relink code** and you are back in.

### 🎮 Players: getting into the Player Portal

1. Ask your guild admin for your **guild's join code**. It is permanent, they can paste it in your guild chat.
2. Click **Sign in with Discord** on the login page.
3. Pick **"Join a guild"**, then enter the join code and **your in-game UID**.
4. Your admin approves you, and you are in.

Your UID has to already be on the guild roster. If it is not, your admin adds you first.

### 🧭 Starting a brand new guild

The old "Request a Guild" tab is gone. It filed a form, waited for me to approve it by hand, and then I had to send you a password over Discord. Now:

1. **Sign in with Discord**, pick **"Create a guild"**.
2. Enter your **guild tag** (2 to 12 letters, numbers or underscores) and your **server number**.
3. The guild is created immediately and you are its first admin.

Your Discord account needs to be at least 30 days old. That is the only gate.

### 🔀 If you are an admin *and* a player

Some of you run a guild and also play in it, with two separate accounts. Discord now handles both: link each one, and when you sign in you get asked **which account you want**, with a line telling you where each one lands. Pick and go.

To link your second account, ask for a **relink code** and use the **"I have a code"** option.

---

## ✨ What else is new

- **Faster loading.** The icon set now ships only the icons actually used, 87% smaller. Noticeable on mobile data.
- **42 invisible icons fixed.** Icons in toasts, confirmation dialogs, UID warnings and Arms Race chips were drawing nothing at all. They were asking for an icon style the app never loaded.
- **"Unassigned Server" fixed.** Every guild admin was showing under "Unassigned Server" on the admin screen. The data was never wrong, the screen just was not being told which server each admin belonged to.
- **The admin console no longer opens empty.** It was coming up blank until you switched guild and switched back.
- **Two buttons that did nothing are gone.** "Sign in with a Passkey" and "Use a backup code instead" were never actually connected to anything. They looked like features and did nothing when clicked. Rather than leave them pretending, I removed them.

---

## 🔒 Privacy and terms, rewritten

There is a proper **Privacy Policy** now, linked at the bottom of every page. It lists exactly what I store about you (your in-game name, your UID, your event stats, your Discord ID if you linked it), why, and for how long. No cookies, no analytics, no tracking, no advertising. Screenshots uploaded for roster scanning are read and thrown away, never stored.

**Want your data deleted?** Email **fgfwiki@gmail.com** with your pseudonym and guild. Your guild's historical totals stay, but with nothing left in them that points to you.

The **Terms** were rewritten too, in plain English instead of a wall of capitals. Two things in the old version were simply wrong and are fixed: a clause forcing you into a Paris court (not enforceable against you anyway) and a liability cap calculated on money you never paid.

---

## 🤝 And a promise about the code

I am one person. I maintain this because I play the game. One day I will stop, and I do not want twenty six guilds left with a tool nobody is allowed to run.

So it is now written into the Terms, and into the licence file, that the source code becomes **fully open source (Apache 2.0)** on whichever comes first:

- **2 August 2029**, automatically, whatever happens;
- the day I announce I have stopped maintaining it;
- or **twelve months of silence**: no update shipped, no reply from me.

That last one is the one that matters. A promise that needs me to be around is worth nothing at the exact moment you would need it.

---

That's it. Reload the page if you have it open from before. Link your Discord when you get a minute, and ping me if anything looks off. 🫡

---

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