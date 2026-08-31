📢 **FGF Guild Management Tool Update — CHANG_V3.11**

Hey everyone! Big one this time: **Passkeys** have landed. Sign in with your fingerprint, face, or PIN — no more typing a password every time. 🔑✨

### 🔑 New: Sign in with a Passkey
- Add a Passkey from **Accounts & Access** (admin) or **My Info → Security** (Player Portal), and sign in afterward with your device's fingerprint, face, or PIN — no password typing required.
- Register one Passkey **per device** (phone, laptop, etc.), each with its own editable label so you can tell them apart later.
- **10 one-time backup codes** are generated the moment you add your first Passkey — download them and keep them somewhere safe. Lost every device? A backup code gets you back in. You can regenerate a fresh set anytime from the same screen.
- Your password still works exactly as before — a Passkey is an extra way in, never a replacement. After a normal password sign-in, you'll see a one-time "Secure your account" prompt suggesting you set one up if you haven't yet.
- Locked out of both your devices *and* your backup codes? A guild/server admin (within their own scope) can reset your Passkeys from your account card, same safety net as the existing password reset.

### 🛠️ Fixed along the way
- Passkey sign-in now correctly recognizes **every account** you've registered one on — previously, if you had Passkeys on two different accounts (say, an admin account and a separate Player Portal account), only one of them would show up at sign-in time.
- Passkeys saved in a browser extension (Proton Pass, Bitwarden, 1Password...) now show up as a suggestion right in the sign-in field, and actually complete sign-in when picked — both were broken for extension users specifically.
- Fixed a rare case where heavy back-and-forth sign-ins could make password login briefly show "Invalid credentials." even with the right password — the login screen now always shows the real reason (like "too many attempts, please wait a moment") instead of a generic error.
- Bug-report tickets and Passkey device labels now show your **real OS/browser version** again — Apple devices were showing a frozen, incorrect version number due to how iOS/macOS report themselves.

*As always, thanks for the reports and feedback — keep them coming via the Report a Bug button!* 🚀🛡️
