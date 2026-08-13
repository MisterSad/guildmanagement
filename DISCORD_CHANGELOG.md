📢 **FGF Guild Management Tool Update — OCR Model 404 Resolution — v104**

🛠️ **Fixed: OCR API HTTP 404 (Model not found)**
Resolved model 404 errors by establishing `gemini-1.5-flash` as primary free production model with auto-fallback!

✨ **What was changed:**
- **Automatic Fallback Chain**: Requests start on `gemini-1.5-flash` (100% free on Google AI Studio) and automatically fall back to `gemini-2.0-flash-exp`, `gemini-2.0-flash`, and `gemini-flash-latest` if needed.

Roster scanning in the **Members** tab is fully operational! 📸
