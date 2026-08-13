📢 **FGF Guild Management Tool Update — Session Refresh & Webhook Resilience — v97**

🛠️ **Fixed: Long-Session Webhook Delivery**

✨ **What was changed:**
- **Automatic Token Refresh**: `ensureAuthSession` in `gm-utils.js` automatically refreshes expired authentication tokens.
- **Resilient Webhook Fallback**: If an expired session token triggers a 401 error, `sendDiscordWebhook` instantly retries the proxy with the public API key, ensuring webhooks post cleanly even on long-open browser tabs!

Feel free to test sharing squad compositions in the **Shadowfront** tab! 🎯
