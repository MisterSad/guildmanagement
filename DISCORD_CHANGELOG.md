📢 **FGF Guild Management Tool Update — CHANG_V3.0 (The Material Design 3 Overhaul)**

Hey commanders! 👋

Over the past few weeks, many of you shared valuable feedback about small graphical friction points across the platform:
- Pages feeling heavy or slow to load during peak battle hours.
- Visual fatigue caused by harsh, high-contrast dark backgrounds during long fleet campaigns.
- Mismatched icon styles and inconsistent shapes between different panels.
- A cluttered login screen with confusing links and buttons.

I heard you loud and clear! To solve these issues at their root and build a rock-solid, unified foundation for all future features, I undertook a complete, ground-up overhaul of our UI/UX architecture, transitioning the entire platform to **Google Material Design 3 (Material You / M3)** paired with an **Apple-inspired Cozy Neutral atmosphere**!

Here is everything included in this major release:

---

### 🚀 1. Ultra-Fast Performance & Universal Google Material Symbols
- **Zero Asset Bloat**: Replaced heavy, fragmented legacy SVG files with official **Google Material Symbols Rounded** variable vector fonts.
- **Lightning-Fast Page Loads**: Browser caching now renders the entire UI instantly, reducing initial paint times and eliminating stutter when switching tabs.
- **Dynamic Interactive States**: Active tabs and navigation items smoothly transition from elegant outline glyphs to solid filled states (`FILL: 1`) with ambient glowing accents.

---

### 🎨 2. Official Google M3 Extended Color System (1 Color Per Event)
Every battle event and management domain now possesses its own dedicated, official Google M3 tonal palette (calibrated for perfect contrast and zero eye strain):
- 🔵 **GvG (Guild vs Guild)** $\rightarrow$ **Google Cobalt Blue** (`#a8c7fa`)
- 🟡 **SvS (Server vs Server)** $\rightarrow$ **Google Amber / Gold** (`#ffe088`)
- 🟢 **Glory (Weekly Progression)** $\rightarrow$ **Google Emerald Green** (`#6dd58c`)
- 🟠 **Arms Race (ARA / ARB)** $\rightarrow$ **Google Coral / Orange** (`#ffb787`)
- 🟣 **Shadowfront (Squad 1 / 2)** $\rightarrow$ **Google Deep Purple / Indigo** (`#d0bcff`)
- 🔷 **Defend Trade Route (DTR)** $\rightarrow$ **Google Cyan / Teal** (`#78d9ec`)
- 🔴 **Sanctions & Bans** $\rightarrow$ **Google Crimson Red** (`#f2b8b5`)
- 🪻 **Super Admin & System Diagnostics** $\rightarrow$ **Google Magenta / Violet** (`#e8b4f8`)

---

### 🔐 3. Re-Imagined, Streamlined Login & Smart Role Routing
- **M3 / Apple Segmented Pill Switcher**: Switch effortlessly between **Sign In** and **Register Player** right at the top of the card.
- **Automated Smart Routing**: A single, clean login form for everyone! 
  - Guild Leaders & Admins are instantly directed to the **Command Center**.
  - Players are routed straight into the **Player Portal** with their KPIs, challenges, and badges.
- **No More Clutter**: Removed the redundant bottom links for a sleek, focused authentication experience.
- **Interactive Password Visibility**: Smooth toggle to check your password before submitting.

---

### 🏆 4. Modernized Material 3 Player Rankings Podium
- **Elevated Tonal Pedestals**: Replaced rigid polygon blocks with graduated Material 3 elevated containers (Level 1, 2, and 3) featuring frosted specular edges.
- **🥇 #1 MVP (Gold)**: Level 3 Elevation with an **animated floating Google Crown** (`crown`), glowing gold avatar ring, and golden tabular score pill.
- **🥈 #2 & 🥉 #3 (Silver & Bronze)**: Level 2 and Level 1 Elevation with refined titanium and copper metallic finishes.
- **M3 Circular Avatars & Rank Pips**: Clean round avatars with centered rank badges (`1`, `2`, `3`) and smooth hover elevation shifts (`-6px`).

---

### 🛋️ 5. Cozy Dark Theme & Google Typography
- **Google Dark Theme Surfaces**: Replaced harsh jet-black with layered, eye-friendly graphite (`#131314` base to `#1e1f20` elevated containers) to keep your eyes rested during late-night alliance wars.
- **Crisp Typography**: Integrated Google Fonts *Plus Jakarta Sans* and *Inter* variable type scales for maximum legibility on mobile and desktop.

---

### 🧪 6. 100% Quality Gate Verified (Zero Regressions)
- **All 235 Vitest Unit Tests Passing**: Preserved complete database integrity, event calculations, and multi-tenant isolation across all guilds.
- **All 7 Playwright Browser E2E Tests Passing**: Validated real browser navigation and user workflows.
- **Zero TypeScript Errors & Clean Production Build**: High-speed bundle ready for action!

---

The update is **live right now** for all guild tenants. Hard-refresh your browser (**`Ctrl + F5`** on PC or **`Cmd + Shift + R`** on Mac) to enjoy the brand-new experience!

As always, feel free to drop your thoughts, suggestions, and feedback on Discord. Thank you for your continued support! ⚔️🚀✨
