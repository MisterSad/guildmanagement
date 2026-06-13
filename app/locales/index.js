/**
 * Language registry: the single place where available languages are declared.
 *
 * Adding a language (saas_strategy.md §7.3):
 *   1. Copy locales/en.js to locales/<code>.js and translate the values.
 *   2. Add one entry below (BCP-47 code, native label, flag, Intl locale).
 *   3. Run `node tools/i18n-check.js` to verify key coverage.
 * Nothing else: the switcher, detection and fallback pick it up automatically.
 *
 * `intl` is the locale handed to Intl.DateTimeFormat / Intl.NumberFormat.
 * English is the default and the fallback for missing keys.
 */
window.GMT_LANGUAGES = [
    { code: 'en', label: 'English',  flag: '🇬🇧', intl: 'en-GB' },
    { code: 'fr', label: 'Français', flag: '🇫🇷', intl: 'fr-FR' }
];
