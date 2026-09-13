📢 **FGF Guild Management Tool Update — CHANG_V3.17.2**

Welcome to V3.17.2! This update is all about keeping things fast, safe and smooth: logins stay instant even during the biggest SvS/GvG rallies, accounts are locked down behind strict role isolation, the roster feels effortless, and network hiccups now come with clear guidance. Full breakdown below.

### ⚡ Instant Logins & Peak-Hour Stability
- **What changed**: I reworked the login and reminder backends — targeted database indexes, strict timeouts, an atomic rate limiter, and smarter background jobs. The busiest hours no longer strain the servers.
- **The benefit**: Your password sign-ins and Passkey unlocks stay lightning-fast and rock-solid during large SvS/GvG gatherings, with none of the connection timeouts some players saw before.

### 🛡️ Strict Role Isolation & Account Protection
- **What changed**: Access is now strictly limited to the four canonical roles, with the older in-game rank values retired permanently. Every account session can also be invalidated on demand (after a password reset or role change).
- **The benefit**: Absolute separation between guilds — no account can slip into elevated access, and a session that could have been compromised can be shut down immediately.

### 🚀 Ultra-Smooth Roster & Tactical Matrix
- **What changed**: The roster now uses one-time event wiring and precomputed scores, sorting and searching instantly, and the Tactical Force Matrix ranks in a single pass.
- **The benefit**: Flicker-free interaction with your member list even with hundreds of players, and lightning-quick navigation between tabs without redundant loading screens.

### 🌐 Smarter Offline & Reconnect Alerts
- **What changed**: Network problems (brief disconnections, server timeouts, rate limits) now show clear, friendly messages with an immediate Retry button instead of a cryptic error.
- **The benefit**: If you hit a micro-outage, you'll instantly know what happened and can get right back to work with a single click.

*Thank you for your feedback, bug reports, and suggestions! As always, feel free to report issues or suggest ideas using the Report a Bug button or via Discord.* 🚀⚔️