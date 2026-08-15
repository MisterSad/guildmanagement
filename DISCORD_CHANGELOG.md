📢 **FGF Guild Management Tool Update — CHANG_V2.6**

Hey commanders! 👋

I've just deployed a major platform update introducing a new **Server Admin** role level, along with key performance, security, and interface improvements!

Here is what's new:

---

### 🌐 Multi-Guild Server Administration (`server_admin`)
- **Server Federation Management**: Server and alliance leaders can now manage all guilds operating on their server from a single account!
- **Dynamic Guild Switcher**: Server admins can switch smoothly between any guild belonging to their server right from the topbar navigation.
- **Full Roster & Event Scope**: Full access to manage active battle events, player rosters, participation rates, sanctions, and Discord webhook notifications across all your server's guilds.
- **Strict Server Isolation**: Zero cross-server data leaks — each server admin is strictly scoped to guilds matching their assigned server number.

### 🛡️ Security & Zero-Trust Architecture
- **Enhanced Database Policies (RLS)**: Cryptographically verified server matching in PostgreSQL Row Level Security policies and Edge Functions.
- **Edge Functions Hardening**: Added server-scoped validation to account management, AI OCR roster scanning, and Discord webhook proxies.
- **Clean HTML5 DOM Layout**: Reorganized core modals for smoother rendering and instant interactions.

### 🧪 100% Verified Quality Gate
- **222 Automated Tests Passing**: Comprehensive test battery completely green across all role tiers, scoping rules, and battle calculations.
- **Zero TypeScript Errors**: Ultra-strict type safety across the entire client and Edge Function codebase.

---

The update is live and ready for all guilds. As always, let me know if you have any questions or feedback on Discord! 🚀

Good luck in your upcoming SvS & GvG battles! ⚔️

