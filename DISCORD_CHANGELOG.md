📢 **FGF Guild Management Tool Update — OCR AI Overload Auto-Retry (HTTP 503) — v100**

🛠️ **Fixed: Google AI Temporary Server Overloads (HTTP 503 / 500)**
When Google's Gemini servers experience transient load spikes or high traffic, the OCR tool now automatically retries with exponential backoff instead of throwing an error!

✨ **What was changed:**
- **Automatic Retry with Backoff**: Intercepts HTTP 503 (Service Unavailable) and 500/502/504 server overload responses and automatically retries with progressive delays (2s, 4s).
- **Live Status Feedback**: Displays live progress notifications in the loading window so you know when an automatic retry is in progress.
- **Model Cluster Switching**: If a specific model pool is busy, the tool automatically switches to an alternative model cluster (`gemini-1.5-flash` ➔ `gemini-2.0-flash` ➔ `gemini-flash-latest`) to complete your scan smoothly.

Feel free to scan your roster screenshots in the **Members** tab! 📸
