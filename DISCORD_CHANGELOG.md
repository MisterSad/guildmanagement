📢 **FGF Guild Management Tool Update — CHANG_V3.10**

Hey everyone! Big polish pass today — navigation fixes, smarter stats, a faster app overall, better mobile layout, and one important regression fix. 🛠️✨

### 🐛 Fixed & Polished
- Fixed a broken notification link in the Leader Hall (clicking certain notifications used to go nowhere).
- Cleaned up confusing menu labels in the admin panel so they actually match what they open.
- Removed a leftover, non-functional legacy screen that was just dead weight.
- Fixed a sneaky bug where brand-new guilds were silently pre-loaded with 5 fake "default" clock members from another guild — new guilds now start clean.
- Search fields (Members, Banned list) no longer lag while typing.
- Background refresh timers now pause when your tab isn't active — easier on battery/CPU.

### 📊 Stats, Leveled Up
- Click any leaderboard row to open a **Player History** card — power/glory trend chart plus per-event attendance, all in one place.
- Shadowfront breakdown now separates **Squad 1 vs Squad 2**, with a commander badge.
- Glory is now available in the Event Deep-Dive view.
- Late/Excused counts now show directly in Event Deep-Dive.
- Arms Race and Shadowfront squad counts now show real numbers instead of just a checkmark.

### ⚡ Faster Everywhere
- Several screens that used to load their data step-by-step now load it all at once — noticeably snappier.
- Bulk OCR approvals (Approve All, score commits) are now batched instead of one-by-one.
- Stats and History tabs briefly cache their data so flipping between tabs doesn't force a fresh reload every time — and the cache clears itself automatically the moment something actually changes.
- The whole app now ships minified, about 44% smaller, for a faster first load.

### 📱 Mobile & Navigation
- SvS/GvG Matchup tables are now properly responsive on mobile — no more awkward side-scrolling.
- Leader Hall now switches to mobile layout at the same screen width as the rest of the app, instead of its own inconsistent breakpoint.
- Leader Hall moved to a more prominent spot in the sidebar; the Donate button moved to a lighter footer-style spot out of the admin menu.
- Unified the last few old-style buttons and confirm dialogs to the current look, for a more consistent feel across the tool.

### 🚨 Important Fix
- Found and fixed a regression where the **SvS/GvG Cross-Rank matchup tools were silently broken** in production, quietly showing a placeholder instead of the real tool. They're fully working again now.

*As always, thanks for the reports and feedback — keep them coming via the Report a Bug button!* 🚀🛡️
