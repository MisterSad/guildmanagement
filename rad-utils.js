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

    function getWeekStart(date) {
        var d = date ? new Date(date) : new Date();
        var day = d.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
        var diff = d.getDate() - day + (day === 0 ? -6 : 1);
        var monday = new Date(d.getFullYear(), d.getMonth(), diff);
        return monday.getFullYear() + '-' + pad2(monday.getMonth() + 1) + '-' + pad2(monday.getDate());
    }

    function getPrevWeekStart(weekStr) {
        var base = weekStr ? new Date(weekStr + 'T12:00:00') : new Date(getWeekStart() + 'T12:00:00');
        base.setDate(base.getDate() - 7);
        return base.getFullYear() + '-' + pad2(base.getMonth() + 1) + '-' + pad2(base.getDate());
    }

    function formatWeek(ws) {
        var d = new Date(ws + 'T12:00:00');
        var end = new Date(d); end.setDate(end.getDate() + 6);
        return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }) +
            ' → ' + end.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
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
        escapeHTML: escapeHTML,
        getWeekStart: getWeekStart,
        getPrevWeekStart: getPrevWeekStart,
        formatWeek: formatWeek,
        newSessionId: newSessionId,
        showToast: showToast,
        validatePseudo: validatePseudo,
        validateUid: validateUid
    };

})();
