/**
 * rad-utils.js — Utilitaires partagés (DB, i18n, dates, escape, toast).
 * Doit être chargé AVANT les autres scripts métier (app.js, events.js, …).
 */
(function () {

    var SUPABASE_URL = 'https://vgweufzwmfwplusskmuf.supabase.co';
    var SUPABASE_KEY = 'sb_publishable_c79HkCPMv7FmNvi1wGwlIg_N3isrSKo';

    var db = null;
    try { db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY); }
    catch (e) { console.error('rad-utils: supabase init', e); }

    function t(key) {
        return window.RAD_I18N ? window.RAD_I18N.t(key) : key;
    }

    function escapeHTML(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;')
            .replace(/`/g, '&#96;');
    }

    function pad2(n) { return String(n).padStart(2, '0'); }

    // La semaine commence à 00:00 UTC le lundi (rollover dimanche → lundi en UTC).
    function getWeekStart(date) {
        var d = date ? new Date(date) : new Date();
        var day  = d.getUTCDay(); // 0=Dim, 1=Lun, ..., 6=Sam (UTC)
        var diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
        var monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), diff));
        return monday.getUTCFullYear() + '-' + pad2(monday.getUTCMonth() + 1) + '-' + pad2(monday.getUTCDate());
    }

    function getPrevWeekStart(weekStr) {
        var base = weekStr ? new Date(weekStr + 'T12:00:00Z') : new Date(getWeekStart() + 'T12:00:00Z');
        base.setUTCDate(base.getUTCDate() - 7);
        return base.getUTCFullYear() + '-' + pad2(base.getUTCMonth() + 1) + '-' + pad2(base.getUTCDate());
    }

    function formatWeek(ws) {
        var d = new Date(ws + 'T12:00:00Z');
        var end = new Date(d); end.setUTCDate(end.getUTCDate() + 6);
        var opts = { day: '2-digit', month: '2-digit', timeZone: 'UTC' };
        var endOpts = { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' };
        return d.toLocaleDateString('fr-FR', opts) + ' → ' + end.toLocaleDateString('fr-FR', endOpts);
    }

    function newSessionId() {
        return new Date().toISOString();
    }

    // Bloque les caractères HTML/JS dangereux + caractères de contrôle.
    // Limite à 32 caractères max. Retourne null si OK, sinon une clé i18n d'erreur.
    function validatePseudo(pseudo) {
        if (typeof pseudo !== 'string') return 'validation_pseudo_invalid';
        var v = pseudo.trim();
        if (v.length === 0)  return 'validation_pseudo_empty';
        if (v.length > 32)   return 'validation_pseudo_too_long';
        // Refus des caractères HTML/JS dangereux et des contrôles
        if (/[<>"'`&\\\/\x00-\x1F\x7F]/.test(v)) return 'validation_pseudo_invalid_chars';
        return null;
    }

    // UID : chiffres uniquement, 1-20 caractères.
    function validateUid(uid) {
        if (uid == null || uid === '') return null; // UID optionnel côté validation
        if (typeof uid !== 'string')   return 'validation_uid_invalid';
        var v = uid.trim();
        if (v.length === 0)  return null;
        if (v.length > 20)   return 'validation_uid_too_long';
        if (!/^[0-9]+$/.test(v)) return 'validation_uid_not_numeric';
        return null;
    }

    // ── Formatage numérique avec séparateur de milliers ──────────────────────
    // Limite max : 9 999 999 999 (10 chiffres)
    var MAX_NUMERIC = 9999999999;

    function formatNumber(n) {
        if (n === null || n === undefined || n === '') return '';
        var num = typeof n === 'number' ? n : parseInt(String(n).replace(/\D/g, ''), 10);
        if (isNaN(num)) return '';
        if (num > MAX_NUMERIC) num = MAX_NUMERIC;
        return String(num).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    }

    function parseNumber(s) {
        if (s === null || s === undefined || s === '') return null;
        var digits = String(s).replace(/\D/g, '');
        if (digits === '') return null;
        var num = parseInt(digits, 10);
        if (isNaN(num)) return null;
        return Math.min(num, MAX_NUMERIC);
    }

    // Initiales 2 lettres pour avatars (camelCase-aware)
    // "HakwTuah" → "HT", "StarWarrior99" → "SW", "lower_case" → "LC", "ab" → "AB".
    function avatarInit(pseudo) {
        if (!pseudo) return '?';
        var s = String(pseudo).trim();
        var parts = s.split(/(?=[A-Z])|[\s_\-.]+/).filter(Boolean);
        if (parts.length >= 2) {
            return (parts[0][0] + parts[1][0]).toUpperCase();
        }
        return s.slice(0, 2).toUpperCase();
    }

    // Branche un input texte pour reformater à chaque frappe en préservant le curseur.
    function attachNumberFormatter(input) {
        if (!input || input.dataset.numFormatted === '1') return;
        input.dataset.numFormatted = '1';
        input.setAttribute('inputmode', 'numeric');
        input.setAttribute('autocomplete', 'off');
        input.setAttribute('maxlength', '13'); // "9 999 999 999"

        // Format initial
        if (input.value) input.value = formatNumber(input.value);

        input.addEventListener('input', function () {
            var raw = input.value;
            var cursorPos = input.selectionStart || 0;
            var digitsBefore = raw.substring(0, cursorPos).replace(/\D/g, '').length;

            var formatted = formatNumber(raw);
            input.value = formatted;

            // Restaurer le curseur après le même nombre de chiffres
            var newPos = formatted.length, count = 0;
            for (var i = 0; i < formatted.length; i++) {
                if (count >= digitsBefore) { newPos = i; break; }
                if (/\d/.test(formatted[i])) count++;
            }
            try { input.setSelectionRange(newPos, newPos); } catch (_) {}
        });
    }

    // ── Auth : login via Edge Function (verify chiffré côté serveur) ─────────
    // Le mot de passe n'est jamais comparé côté client ; la table accounts
    // n'est plus accessible via la clé publique. L'Edge Function renvoie une
    // vraie session Supabase (JWT signé par le projet) que supabase-js gère
    // et rafraîchit ensuite automatiquement pour toutes les requêtes.
    async function login(id, password) {
        if (!db) return { ok: false, error: 'no_client' };
        var r;
        try {
            r = await db.functions.invoke('auth-login', { body: { id: id, password: password } });
        } catch (e) {
            return { ok: false, error: 'request_failed' };
        }
        var data = r && r.data;
        if (!data || !data.ok) return { ok: false, error: (data && data.error) || 'invalid' };
        var s = await db.auth.setSession({
            access_token: data.access_token,
            refresh_token: data.refresh_token
        });
        if (s.error) return { ok: false, error: 'session_set_failed' };
        return { ok: true, role: data.role, id: data.id };
    }

    async function logout() {
        if (!db) return;
        try { await db.auth.signOut(); } catch (_) {}
    }

    // Opérations admin sur les comptes (R5 only — vérifié côté serveur via le
    // JWT). La session courante est jointe automatiquement par supabase-js.
    async function adminAccounts(action, payload) {
        if (!db) return { ok: false, error: 'no_client' };
        var body = Object.assign({ action: action }, payload || {});
        var r;
        try {
            r = await db.functions.invoke('admin-accounts', { body: body });
        } catch (e) {
            return { ok: false, error: 'request_failed' };
        }
        var data = r && r.data;
        if (!data) return { ok: false, error: (r && r.error && r.error.message) || 'request_failed' };
        return data;
    }

    // Restaure le rôle/identifiant depuis la session persistée (localStorage
    // supabase-js) — survit à une fermeture d'onglet, contrairement à
    // sessionStorage. Lit les claims app_metadata du JWT.
    async function sessionInfo() {
        if (!db) return null;
        var res;
        try { res = await db.auth.getSession(); } catch (_) { return null; }
        var session = res && res.data && res.data.session;
        if (!session || !session.access_token) return null;
        try {
            var p = session.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
            p += '='.repeat((4 - p.length % 4) % 4);
            var claims = JSON.parse(decodeURIComponent(escape(atob(p))));
            var am = claims.app_metadata || {};
            return { role: am.app_role || 'R4', accountId: am.account_id || null };
        } catch (e) {
            return { role: 'R4', accountId: null };
        }
    }

    function showToast(message, type) {
        if (window.RAD_APP && window.RAD_APP.showToast) {
            window.RAD_APP.showToast(message, type);
            return;
        }
        var tc = document.getElementById('toast-container');
        if (!tc) return;
        var icons = { success: 'ph-check-circle', error: 'ph-warning-circle', info: 'ph-info' };
        var toast = document.createElement('div');
        toast.className = 'toast ' + (type || 'info');

        // Safe DOM construction : aucun innerHTML utilisateur
        var icon = document.createElement('i');
        icon.className = 'ph-fill ' + (icons[type] || 'ph-info');
        var span = document.createElement('span');
        span.textContent = String(message);
        toast.appendChild(icon);
        toast.appendChild(document.createTextNode(' '));
        toast.appendChild(span);

        tc.appendChild(toast);
        setTimeout(function () {
            toast.classList.add('fade-out');
            setTimeout(function () { toast.remove(); }, 300);
        }, 3500);
    }

    window.RAD = {
        db: db,
        t: t,
        login: login,
        logout: logout,
        adminAccounts: adminAccounts,
        sessionInfo: sessionInfo,
        escapeHTML: escapeHTML,
        getWeekStart: getWeekStart,
        getPrevWeekStart: getPrevWeekStart,
        formatWeek: formatWeek,
        newSessionId: newSessionId,
        showToast: showToast,
        validatePseudo: validatePseudo,
        validateUid: validateUid,
        formatNumber: formatNumber,
        parseNumber: parseNumber,
        attachNumberFormatter: attachNumberFormatter,
        avatarInit: avatarInit,
        MAX_NUMERIC: MAX_NUMERIC
    };

})();
