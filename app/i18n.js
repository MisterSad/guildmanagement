/**
 * i18n engine — registry-driven, English-first (saas_strategy.md §7).
 *
 * Languages are declared in locales/index.js (window.GMT_LANGUAGES); each
 * locale lives in locales/<code>.js and registers itself on
 * window.GMT_LOCALES. English is the reference locale: it is loaded eagerly
 * from index.html and is the fallback for any missing key. Other locales are
 * lazy-loaded on first use by injecting their script tag.
 *
 * Adding a language requires NO change to this file — see locales/index.js.
 *
 * Public API (kept on window.RAD_I18N for backward compatibility with the
 * existing modules; window.GMT_I18N is an alias):
 *   t(key)                  → translated string (current → en → key)
 *   tn(key, n)              → plural-aware: tries `${key}_<plural-rule>` then
 *                             `${key}_other`, replaces "{n}" with n
 *   getLang()               → current language code ('en', 'fr', …)
 *   setLang(code)           → switch + persist + re-render
 *   getLanguages()          → registry entries
 *   dateLocale()            → Intl locale of the current language ('en-GB', …)
 *   formatNumber(n)         → Intl-formatted integer in the current locale
 *   applyTranslations()     → update all [data-i18n*] elements
 *   mountSwitcher(el)       → render a language <select> into el (also runs
 *                             automatically on [data-gmt-lang-switcher])
 */
(function () {

    var STORAGE_KEY        = 'gmt_lang';
    var LEGACY_STORAGE_KEY = 'rad_lang';
    var DEFAULT_LANG       = 'en';
    var LOCALE_VERSION     = '2'; // bump with locale file cache-busting

    function registry() {
        return window.GMT_LANGUAGES || [{ code: 'en', label: 'English', flag: '', intl: 'en-GB' }];
    }
    function registryEntry(code) {
        return registry().find(function (l) { return l.code === code; }) || null;
    }
    function locales() {
        window.GMT_LOCALES = window.GMT_LOCALES || {};
        return window.GMT_LOCALES;
    }

    // ── Initial language detection: storage → browser → default ──────────────
    function detectLang() {
        try {
            var stored = localStorage.getItem(STORAGE_KEY);
            if (!stored) {
                // One-time migration from the pre-SaaS storage key.
                var legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
                if (legacy) {
                    stored = legacy;
                    localStorage.setItem(STORAGE_KEY, legacy);
                    localStorage.removeItem(LEGACY_STORAGE_KEY);
                }
            }
            if (stored && registryEntry(stored)) return stored;
        } catch (_) {}

        var navLangs = (navigator.languages && navigator.languages.length)
            ? navigator.languages
            : [navigator.language || ''];
        for (var i = 0; i < navLangs.length; i++) {
            var nl = String(navLangs[i] || '').toLowerCase();
            // Exact BCP-47 match first (e.g. 'pt-br'), then primary subtag ('pt').
            var exact = registry().find(function (l) { return l.code.toLowerCase() === nl; });
            if (exact) return exact.code;
            var primary = nl.split('-')[0];
            var base = registry().find(function (l) { return l.code.toLowerCase() === primary; });
            if (base) return base.code;
        }
        return DEFAULT_LANG;
    }

    var currentLang = detectLang();
    var pendingLang = null; // language being lazy-loaded

    // ── Lazy locale loading via script injection (no-build static site) ──────
    function isLoaded(code) { return !!locales()[code]; }

    function loadLocale(code, done) {
        if (isLoaded(code)) { done(true); return; }
        var s = document.createElement('script');
        s.src = 'locales/' + encodeURIComponent(code) + '.js?v=' + LOCALE_VERSION;
        s.onload = function () { done(isLoaded(code)); };
        s.onerror = function () { done(false); };
        document.head.appendChild(s);
    }

    function syncHtmlLang() {
        try { document.documentElement.lang = currentLang; } catch (_) {}
    }

    // ── Switcher widgets ──────────────────────────────────────────────────────
    var switchers = [];

    function renderSwitcher(el) {
        if (!el) return;
        var html = '<select class="gmt-lang-select" aria-label="Language">';
        registry().forEach(function (l) {
            html += '<option value="' + l.code + '"' + (l.code === currentLang ? ' selected' : '') + '>' +
                (l.flag ? l.flag + ' ' : '') + l.code.toUpperCase() +
            '</option>';
        });
        html += '</select>';
        el.innerHTML = html;
        var sel = el.querySelector('select');
        sel.addEventListener('change', function () {
            window.RAD_I18N.setLang(sel.value);
        });
    }

    function refreshSwitchers() {
        switchers = switchers.filter(function (el) { return el && el.isConnected; });
        switchers.forEach(renderSwitcher);
    }

    // ── Public API ────────────────────────────────────────────────────────────
    window.RAD_I18N = {
        t: function (key) {
            var L = locales();
            return (L[currentLang] && L[currentLang][key])
                || (L[DEFAULT_LANG] && L[DEFAULT_LANG][key])
                || key;
        },

        // Plural-aware lookup: keys follow `<key>_one` / `<key>_other` (plus
        // any category the language needs: _few, _many…). "{n}" is replaced.
        tn: function (key, n) {
            var cat = 'other';
            try { cat = new Intl.PluralRules(this.dateLocale()).select(n); } catch (_) {}
            var L = locales();
            var lookup = function (k) {
                return (L[currentLang] && L[currentLang][k])
                    || (L[DEFAULT_LANG] && L[DEFAULT_LANG][k]) || null;
            };
            var s = lookup(key + '_' + cat) || lookup(key + '_other') || lookup(key) || key;
            return String(s).replace(/\{n\}/g, String(n));
        },

        getLang: function () { return currentLang; },

        getLanguages: function () { return registry().slice(); },

        dateLocale: function () {
            var e = registryEntry(currentLang);
            return (e && e.intl) || currentLang;
        },

        formatNumber: function (n) {
            if (n === null || n === undefined || n === '' || isNaN(n)) return '';
            try { return new Intl.NumberFormat(this.dateLocale()).format(n); }
            catch (_) { return String(n); }
        },

        setLang: function (lang) {
            if (!registryEntry(lang)) return;
            pendingLang = lang;
            loadLocale(lang, function (ok) {
                if (!ok || pendingLang !== lang) return;
                pendingLang = null;
                currentLang = lang;
                try { localStorage.setItem(STORAGE_KEY, lang); } catch (_) {}
                syncHtmlLang();
                window.RAD_I18N.applyTranslations();
                refreshSwitchers();
                // Legacy two-button switchers (kept for compatibility while
                // some views still ship them).
                document.querySelectorAll('.lang-btn').forEach(function (btn) {
                    btn.classList.toggle('active', btn.getAttribute('data-lang') === lang);
                });
                document.dispatchEvent(new CustomEvent('gmt:langchange', { detail: { lang: lang } }));
            });
        },

        applyTranslations: function () {
            var t = window.RAD_I18N.t;
            document.querySelectorAll('[data-i18n]').forEach(function (el) {
                el.textContent = t(el.getAttribute('data-i18n'));
            });
            document.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
                el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
            });
            document.querySelectorAll('[data-i18n-title]').forEach(function (el) {
                el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
            });
        },

        mountSwitcher: function (el) {
            if (!el) return;
            if (switchers.indexOf(el) === -1) switchers.push(el);
            renderSwitcher(el);
        },

        // Called by locale files once they register themselves (lazy load).
        _onLocaleLoaded: function (_code) { /* hook for future use */ }
    };

    window.GMT_I18N = window.RAD_I18N;

    // ── Boot ──────────────────────────────────────────────────────────────────
    syncHtmlLang();

    function autoMount() {
        document.querySelectorAll('[data-gmt-lang-switcher]').forEach(function (el) {
            window.RAD_I18N.mountSwitcher(el);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', autoMount);
    } else {
        autoMount();
    }

    // If the detected language is not the eagerly-loaded default, load it and
    // re-render (the HTML ships English defaults, so worst case is a brief
    // English flash for non-English users).
    if (currentLang !== DEFAULT_LANG && !isLoaded(currentLang)) {
        var detected = currentLang;
        currentLang = DEFAULT_LANG; // serve English until the locale arrives
        window.RAD_I18N.setLang(detected);
    }

})();
