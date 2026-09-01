📢 **FGF Guild Management Tool Update — CHANG_V3.13**

Big one this time: your guild can now request its own space without going through Discord first, and Leader Hall's "New Chat" was silently broken for almost every officer — that's fixed. Plus a real fix for the video-upload error some of you hit, and a couple of smaller stats/UI cleanups. 🏰🔧

### 🏰 New: Request a Guild — no Discord DM required
- The login page now has a **"Request a Guild"** tab, right next to Sign In and Register Player. Fill in your guild tag, server number, the admin login you want, and your Discord handle — that's it.
- A super admin reviews every request by hand before anything is created — this stays 100% free, always has been, always will be. No payment, no auto-approval.
- Once approved, you get your admin account and credentials relayed straight to you on Discord, ready to sign in.

### 💬 Fixed: "New Chat" in Leader Hall was empty for almost everyone
- If you're a Guild Master or Officer and the leader list in "New Chat" / "New Group" / "Propose Treaty" only ever showed one name (or none), this was it: a permissions gap meant only the very top admin account could ever see other leaders to start a conversation with. Everyone else could only reply to chats someone else started.
- Fixed — every eligible leader now shows up correctly, for every guild.
- Same root cause was also why the Treaty target-guild dropdown only ever offered one option — fixed too, every guild now shows up as a real target.

### 🎥 Fixed: video upload failing for OCR scanning
- Some of you hit "This video format could not be read" or a codec error on every browser, even Safari — not a codec problem after all, a server configuration gap that blocked the browser from reading the recording at all. Fixed, and the max recording length is now **8 minutes** (up from 4).

### 📊 Fixed: Shadowfront attendance rate showing over 100%
- A stats display bug could show attendance rates like 130-200% for long-tenured players. Now correctly capped at 100%.

### 🖱️ Fixed: OCR scan window's Cancel button
- Cancel now actually closes the OCR upload window, same as the X in the corner.

*As always, thanks for the reports and feedback — keep them coming via the Report a Bug button!* 🚀🛡️
