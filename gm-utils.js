/**
 * gm-utils.js — Utilitaires partagés (DB, i18n, dates, escape, toast).
 * Doit être chargé AVANT les autres scripts métier (app.js, events.js, …).
 */
(function () {

    // ── Migration localStorage : anciennes clés 'rad_*' → 'gm_*' ───────────
    // Copie toute clé encore préfixée par l'ancien nom de l'app puis la
    // supprime. Doit s'exécuter avant toute lecture par les scripts métier.
    try {
        var keys = [];
        for (var i = 0; i < localStorage.length; i++) {
            var k = localStorage.key(i);
            if (k && k.indexOf('rad_') === 0) keys.push(k);
        }
        for (var j = 0; j < keys.length; j++) {
            var v = localStorage.getItem(keys[j]);
            localStorage.setItem('gm_' + keys[j].substring(4), v);
            localStorage.removeItem(keys[j]);
        }
    } catch (e) { /* localStorage indisponible (sans permis) : ignoré */ }

    var SUPABASE_URL = 'https://vgweufzwmfwplusskmuf.supabase.co';
    var SUPABASE_KEY = 'sb_publishable_c79HkCPMv7FmNvi1wGwlIg_N3isrSKo';

    var db = null;
    try { db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY); }
    catch (e) { console.error('gm-utils: supabase init', e); }

    // Runtime client accessor: modules may swap window.GM.db (tests, hot-swap).
    // The load-time interception below wraps the initial client; runtime calls
    // go through here so the same behavior applies to any client.
    function getClient() {
        return (window.GM && window.GM.db) ? window.GM.db : null;
    }

    var localRestriction = localStorage.getItem('gm_guild_restriction');
    window.currentGuildRestriction = localRestriction || null;
    window.currentGuild = localRestriction || localStorage.getItem('gm_current_guild') || 'ALPHA';
    // Chargée depuis la table guilds à l'init (app.js). Fallback vide: si la
    // liste ne charge pas, aucun sélecteur de guilde ne s'affiche plutôt que
    // d'en montrer une liste périmée.
    window.guildsList = window.guildsList || [];

    // ── Rôles : modèle sémantique (super_admin / guild_admin / member) ─────
    // Les anciennes valeurs numériques (R5/R4) et 'admin' sont normalisées
    // pour la compatibilité avec les sessions persistées en localStorage.
    function normalizeRole(r) {
        if (r === 'R5' || r === 'admin') return 'super_admin';
        if (r === 'R4') return 'guild_admin';
        if (r === 'super_admin' || r === 'guild_admin' || r === 'member') return r;
        return 'member';
    }

    // Rôle courant synchrone (localStorage + restriction). Un rôle 'member'
    // stocké avec une restriction de guilde désigne un ancien compte R4.
    function roleFromStorage() {
        var role = normalizeRole(localStorage.getItem('gm_role'));
        if (role === 'member' && window.currentGuildRestriction) role = 'guild_admin';
        return role;
    }

    function isSuperAdmin() {
        return roleFromStorage() === 'super_admin';
    }

    // Rôle courant asynchrone, priorité au JWT (app_metadata), fallback storage.
    async function getRoleInfo() {
        var info = await sessionInfo();
        var role = (info && info.role) ? info.role : roleFromStorage();
        return {
            role: role,
            isSuperAdmin: role === 'super_admin',
            isGuildAdmin: role === 'guild_admin',
            isAdmin: role === 'super_admin' || role === 'guild_admin',
            guild: window.currentGuildRestriction
        };
    }

    function isGuildSubscriptionExpired(guildId) {
        var role = roleFromStorage();
        if (role === 'super_admin' || window.currentGuildRestriction === null) {
            return false; // Super admin (or unrestricted officer) is never restricted
        }
        if (!guildId) return false;
        if (!window.guildsData || !window.guildsData[guildId]) return false;
        var sub = window.guildsData[guildId];
        if (!sub || sub.type === 'Unlimited' || sub.type === 'Lifetime') return false;
        if (sub.type === 'Premium') {
            if (!sub.end) return true; // Premium without end date is expired
            return new Date(sub.end).getTime() < Date.now();
        }
        return false;
    }

    function canWriteGuild(guildId) {
        var activeG = guildId || getActiveGuild();
        var role = roleFromStorage();

        // Super admin may write to every guild.
        if (role === 'super_admin') {
            return true;
        }

        // Rule 1: Guild admin can write to their dedicated assigned guild if active
        if (role === 'guild_admin') {
            var restricted = window.currentGuildRestriction;
            // Never fall back to a default guild: writing to the wrong tenant
            // is worse than blocking. If the restriction is missing, the
            // login flow failed; block writes (the UI shows read-only).
            if (!restricted) {
                return false;
            }
            return activeG === restricted && !isGuildSubscriptionExpired(activeG);
        }

        return false;
    }

    // Re-fetch the caller's guild restriction from accounts when it is
    // missing (defensive: login normally sets it, but stale sessions or
    // failed fetches may leave it unset). Returns the guild or null.
    async function ensureGuildRestriction() {
        var role = roleFromStorage();
        if (role === 'super_admin') return null;
        if (role !== 'guild_admin') return null;
        if (window.currentGuildRestriction) return window.currentGuildRestriction;

        var c = getClient();
        if (!c) return null;
        try {
            var info = await sessionInfo();
            if (!info || !info.accountId) return null;
            var res = await c.from('accounts').select('guild').ilike('id', info.accountId).maybeSingle();
            if (res && res.data && res.data.guild) {
                window.currentGuildRestriction = res.data.guild;
                window.currentGuild = res.data.guild;
                try {
                    localStorage.setItem('gm_current_guild', res.data.guild);
                    localStorage.setItem('gm_guild_restriction', res.data.guild);
                } catch (_) {}
                return res.data.guild;
            }
        } catch (_) {}
        return null;
    }

    // Intercept database calls to automatically add the 'guild' filter
    if (db) {
        var originalFrom = db.from;
        db.from = function (table) {
            var builder = originalFrom.call(db, table);
            var tenantTables = [
                'guild_members',
                'banned_players',
                'event_status',
                'event_participants',
                'sanctions',
                'weekly_scores',
                'guild_config',
                'push_subscriptions',
                'event_reminders_sent',
                'discord_notifications_sent',
                'shadowfront_signups',
                'shadowfront_squads',
                'player_name_history'
            ];
            if (tenantTables.indexOf(table) !== -1) {
                var originalDelete = builder.delete;
                builder.delete = function () {
                    var currentG = getActiveGuild();
                    if (!canWriteGuild(currentG)) {
                        return { then: function(resolve) { resolve({ data: null, error: { message: "Read-only access: Modifications are restricted on this guild." } }); } };
                    }
                    return originalDelete.apply(this, arguments).eq('guild', currentG);
                };

                var originalUpdate = builder.update;
                builder.update = function (values, options) {
                    var currentG = getActiveGuild();
                    if (!canWriteGuild(currentG)) {
                        return { then: function(resolve) { resolve({ data: null, error: { message: "Read-only access: Modifications are restricted on this guild." } }); } };
                    }
                    return originalUpdate.call(this, values, options).eq('guild', currentG);
                };

                var originalInsert = builder.insert;
                builder.insert = function (values, options) {
                    var currentG = getActiveGuild();
                    if (!canWriteGuild(currentG)) {
                        return { then: function(resolve) { resolve({ data: null, error: { message: "Read-only access: Modifications are restricted on this guild." } }); } };
                    }
                    if (Array.isArray(values)) {
                        values = values.map(function (v) {
                            return Object.assign({}, v, { guild: v && v.guild ? v.guild : currentG });
                        });
                    } else if (values && typeof values === 'object') {
                        values = Object.assign({}, values, { guild: values.guild ? values.guild : currentG });
                    }
                    return originalInsert.call(this, values, options);
                };

                var originalUpsert = builder.upsert;
                builder.upsert = function (values, options) {
                    var currentG = getActiveGuild();
                    if (!canWriteGuild(currentG)) {
                        return { then: function(resolve) { resolve({ data: null, error: { message: "Read-only access: Modifications are restricted on this guild." } }); } };
                    }
                    if (Array.isArray(values)) {
                        values = values.map(function (v) {
                            return Object.assign({}, v, { guild: v && v.guild ? v.guild : currentG });
                        });
                    } else if (values && typeof values === 'object') {
                        values = Object.assign({}, values, { guild: values.guild ? values.guild : currentG });
                    }
                    return originalUpsert.call(this, values, options);
                };
            }
            return builder;
        };
    }

    function t(key) {
        return window.GM_I18N ? window.GM_I18N.t(key) : key;
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
        if (!ws) return '';
        var d = new Date(ws.length === 10 ? ws + 'T12:00:00Z' : ws);
        if (isNaN(d.getTime())) return String(ws || '');
        var end = new Date(d); end.setUTCDate(end.getUTCDate() + 6);
        var opts = { day: '2-digit', month: '2-digit', timeZone: 'UTC' };
        var endOpts = { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' };
        return d.toLocaleDateString('en-GB', opts) + ' → ' + end.toLocaleDateString('en-GB', endOpts);
    }

    function newSessionId() {
        return new Date().toISOString();
    }

    // ── Human-readable event session ids (SaaS, all tenants) ────────────────
    // Every event session gets a deterministic, chronologically-sortable id
    // built from its type and battle date, so a re-Start of the same event
    // reuses the same session (no ghost duplicates). Mirrors the SQL helper
    // public.gm_event_session_id.
    //   SvS -> SVS-YYYY-Www | GvG -> GVG-YYYY-Www | Glory -> GLORY-YYYY-Www
    //   ARMS A/B -> ARA-/ARB-YYYYMMDD | DTR -> DTR-YYYYMMDD
    //   Shadowfront S1/S2 -> SF1-/SF2-YYYYMMDD
    function isoWeekKey(dateStr) {
        var d = dateStr ? new Date(dateStr) : new Date();
        if (isNaN(d.getTime())) d = new Date();
        // Force UTC to match the SQL to_char(..., 'IYYY-"W"IW').
        var utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
        var dayNum = utc.getUTCDay() || 7; // Mon=1 ... Sun=7
        utc.setUTCDate(utc.getUTCDate() + 4 - dayNum);
        var year = utc.getUTCFullYear();
        var firstThu = new Date(Date.UTC(year, 0, 4));
        var firstMon = new Date(firstThu.getTime() - ((firstThu.getUTCDay() || 7) - 1) * 86400000);
        var week = Math.floor((utc - firstMon) / 86400000 / 7) + 1;
        var isoYear = utc.getUTCFullYear();
        return isoYear + '-W' + (week < 10 ? '0' : '') + week;
    }

    function dateKey(dateStr) {
        var d = dateStr ? new Date(dateStr) : new Date();
        if (isNaN(d.getTime())) d = new Date();
        return d.getUTCFullYear() +
            (d.getUTCMonth() + 1 < 10 ? '0' : '') + (d.getUTCMonth() + 1) +
            (d.getUTCDate() < 10 ? '0' : '') + d.getUTCDate();
    }

    // ── Participation scoring key (SaaS, all tenants) ────────────────────────
    // One key per scoring unit, per the game rules:
    //   - SvS / GvG            -> once per week (SVS-2026-W32)
    //   - Shadowfront          -> once per week (Squad 1 + Squad 2 = one)
    //   - Arms Race (A or B)   -> each session counts (Stage A and Stage B
    //                             are two separate events, so 2 A + 2 B = 4)
    //   - Defend Trade Route   -> each event counts (one per session)
    // Mirrors the SQL helper public.gm_event_scoring_key(text,text,text).
    function eventScoringKey(eventName, sessionId, weekStart) {
        var up = (eventName || '').toUpperCase();
        var ws = weekStart || '';
        if (up.indexOf('ARMS RACE') !== -1) return 'Arms Race|' + (sessionId || ws);
        if (up === 'SHADOWFRONT') return 'Shadowfront|' + ws;
        if (up === 'SVS') return 'SvS|' + ws;
        if (up === 'GVG') return 'GvG|' + ws;
        if (up === 'DEFEND TRADE ROUTE') return 'DTR|' + (sessionId || ws);
        return (eventName || '') + '|' + (sessionId || ws);
    }

    // Date from a human-readable session_id (SF1-20260802-1, ARA-20260809, ...) :
    // returns a Date object or null. Weekly keys (SVS-2026-W32) return null.
    // Handles both legacy bare IDs (ARA-20260809) and sequenced IDs (ARA-20260809-2).
    function sessionDateFromId(sessionId) {
        if (!sessionId) return null;
        var m = String(sessionId).match(/-(\d{4})(\d{2})(\d{2})(-\d+)?$/);
        if (!m) return null;
        return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    }

    // Builds a deterministic, chronologically-sortable session ID from an event
    // name and a reference date (the admin-set battle date).
    //
    // Weekly events (SVS, GVG, GLORY) return an ISO-week key (SVS-2026-W32).
    // Daily events (DTR, Arms Race, Shadowfront) return a YYYYMMDD key with an
    // anti-collision sequence suffix: DTR-20260812-1, DTR-20260812-2, etc.
    //
    // existingIds (optional array) — all session_ids already present in DB for
    // this guild+event. The function finds the lowest -N not already taken.
    // If omitted, -1 is used (safe when you know no session exists yet for that day).
    //
    // Mirrors the SQL helper public.gm_event_session_id(text, date).
    function buildEventSessionId(eventName, startAt, existingIds) {
        var up = (eventName || '').toUpperCase();
        var ref = startAt || new Date();
        // Weekly events: no sequence suffix needed (deterministic per ISO week)
        if (up === 'SVS') return 'SVS-' + isoWeekKey(ref);
        if (up === 'GVG') return 'GVG-' + isoWeekKey(ref);
        if (up === 'GLORY') return 'GLORY-' + isoWeekKey(ref);
        // Daily events: base + anti-collision sequence
        var base;
        if (up === 'ARMS RACE STAGE A')  base = 'ARA-' + dateKey(ref);
        else if (up === 'ARMS RACE STAGE B')  base = 'ARB-' + dateKey(ref);
        else if (up === 'DEFEND TRADE ROUTE') base = 'DTR-' + dateKey(ref);
        else if (up === 'SHADOWFRONT SQUAD 1') base = 'SF1-' + dateKey(ref);
        else if (up === 'SHADOWFRONT SQUAD 2') base = 'SF2-' + dateKey(ref);
        else return newSessionId();
        // Find the lowest sequence number not already taken for this base+day
        var ids = existingIds || [];
        var n = 1;
        while (ids.indexOf(base + '-' + n) !== -1) { n++; }
        return base + '-' + n;
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
        var c = getClient();
        if (!c) return { ok: false, error: 'no_client' };
        var r;
        try {
            r = await c.functions.invoke('auth-login', { body: { id: id, password: password } });
        } catch (e) {
            return { ok: false, error: 'request_failed' };
        }
        var data = r && r.data;
        if (!data || !data.ok) return { ok: false, error: (data && data.error) || 'invalid' };
        var s = await c.auth.setSession({
            access_token: data.access_token,
            refresh_token: data.refresh_token
        });
        if (s.error) return { ok: false, error: 'session_set_failed' };
        return { ok: true, role: data.role, id: data.id };
    }

    async function logout() {
        var c = getClient();
        if (!c) return;
        try { await c.auth.signOut(); } catch (_) {}
    }

    async function ensureAuthSession() {
        var c = getClient();
        if (!c) return null;
        try {
            var s = await c.auth.getSession();
            var session = (s && s.data) ? s.data.session : null;
            if (session) {
                var exp = session.expires_at;
                var now = Math.floor(Date.now() / 1000);
                if (exp && (exp - now < 60)) {
                    var ref = await c.auth.refreshSession();
                    if (ref && ref.data && ref.data.session) return ref.data.session;
                }
                return session;
            }
            await new Promise(function (resolve) { setTimeout(resolve, 300); });
            s = await c.auth.getSession();
            return (s && s.data) ? s.data.session : null;
        } catch (e) {
            console.warn('ensureAuthSession error', e);
            return null;
        }
    }

    // Opérations admin sur les comptes (R5 only — vérifié côté serveur via le
    // JWT). La session courante est jointe automatiquement par supabase-js.
    async function adminAccounts(action, payload) {
        var c = getClient();
        if (!c) return { ok: false, error: 'no_client' };
        var body = Object.assign({ action: action }, payload || {});
        var r;
        try {
            r = await c.functions.invoke('admin-accounts', { body: body });
        } catch (e) {
            return { ok: false, error: 'request_failed' };
        }
        var data = r && r.data;
        if (!data) return { ok: false, error: (r && r.error && r.error.message) || 'request_failed' };
        return data;
    }

    // Player self-registration (anonymous): creates a pending account bound to
    // an in-game UID, gated by the tenant join code. Called from the login view.
    async function registerPlayer(id, password, uid, code) {
        var c = getClient();
        if (!c) return { ok: false, error: 'no_client' };
        var r;
        try {
            r = await c.functions.invoke('player-register', {
                body: {
                    id: (id || '').trim(),
                    password: password || '',
                    uid: (uid || '').trim(),
                    code: (code || '').trim().toUpperCase()
                }
            });
        } catch (e) {
            return { ok: false, error: 'request_failed' };
        }
        var data = r && r.data;
        if (!data || !data.ok) return { ok: false, error: (data && data.error) || 'registration_failed' };
        return { ok: true, status: data.status || 'pending' };
    }

    // Generate a tenant join code client-side (e.g. "FGF-7K2M-X9Q4").
    // The plain code is sent to the edge function which stores only its SHA-256.
    function generateJoinCode(prefix) {
        var alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        var block = function () {
            var s = '';
            for (var i = 0; i < 4; i++) {
                s += alphabet[Math.floor(Math.random() * alphabet.length)];
            }
            return s;
        };
        return (prefix || 'FGF') + '-' + block() + '-' + block();
    }

    // Restaure le rôle/identifiant depuis la session persistée (localStorage
    // supabase-js) — survit à une fermeture d'onglet, contrairement à
    // sessionStorage. Lit les claims app_metadata du JWT.
    async function sessionInfo() {
        var c = getClient();
        if (!c) return null;
        var res;
        try { res = await c.auth.getSession(); } catch (_) { return null; }
        var session = res && res.data && res.data.session;
        if (!session || !session.access_token) return null;
        try {
            var p = session.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
            p += '='.repeat((4 - p.length % 4) % 4);
            var jsonStr = atob(p).split('').map(function(c) {
                return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
            }).join('');
            var claims = JSON.parse(decodeURIComponent(jsonStr));
            var am = claims.app_metadata || {};
            return { role: normalizeRole(am.app_role || 'guild_admin'), accountId: am.account_id || null };
        } catch (e) {
            return { role: 'guild_admin', accountId: null };
        }
    }

    // Fallback for player-portal sessions: supabase-js may fail to restore the
    // session on a hard reload (storage race, expired access token, ...). Read
    // the refresh token straight from the supabase-js storage entry and exchange
    // it against the GoTrue endpoint, then re-inject the session into the client.
    function storageKeyForProject() {
        // supabase-js default: `sb-<projectRef>-auth-token`
        var m = SUPABASE_URL.match(/https:\/\/([a-z0-9]+)\.supabase\.co/);
        return m ? 'sb-' + m[1] + '-auth-token' : null;
    }

    async function forceRefreshPortalSession() {
        var c = getClient();
        if (!c) return null;
        var key = storageKeyForProject();
        if (!key) return null;

        var raw = null;
        try { raw = localStorage.getItem(key); } catch (_) { return null; }
        if (!raw) return null;

        var stored = null;
        try {
            // supabase-js stores a JSON object: { access_token, refresh_token, ... }
            stored = typeof raw === 'string' && raw.charAt(0) === '{' ? JSON.parse(raw) : null;
            if (!stored && raw.charAt(0) !== '{') {
                stored = JSON.parse(decodeURIComponent(raw));
            }
        } catch (_) { return null; }

        var refreshToken = stored && (stored.refresh_token || (stored.currentSession && stored.currentSession.refresh_token));
        if (!refreshToken) return null;

        try {
            var resp = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=refresh_token', {
                method: 'POST',
                headers: { 'apikey': SUPABASE_KEY, 'Content-Type': 'application/json' },
                body: JSON.stringify({ refresh_token: refreshToken })
            });
            var data = await resp.json();
            if (!data.access_token) return null;
            var s = await c.auth.setSession({
                access_token: data.access_token,
                refresh_token: data.refresh_token
            });
            if (s.error) return null;
            var p = data.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
            p += '='.repeat((4 - p.length % 4) % 4);
            var jsonStr = atob(p).split('').map(function(c) {
                return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
            }).join('');
            var claims = JSON.parse(decodeURIComponent(jsonStr));
            var am = claims.app_metadata || {};
            return { role: normalizeRole(am.app_role || 'member'), accountId: am.account_id || null };
        } catch (_) {
            return null;
        }
    }

    function showToast(message, type) {
        if (window.GM_APP && window.GM_APP.showToast) {
            window.GM_APP.showToast(message, type);
            return;
        }
        var tc = document.getElementById('toast-container');
        if (!tc) return;
        var icons = { success: 'ph-check-circle', error: 'ph-warning-circle', warning: 'ph-warning', info: 'ph-info' };
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

    // Format an ISO timestamp as a short UTC wall-clock label, eg "ven. 17/05 · 20:00 UTC".
    function formatDateTimeUTC(iso) {
        if (!iso) return '';
        var d = new Date(iso);
        if (isNaN(d.getTime())) return '';
        var lang = (window.GM_I18N && window.GM_I18N.getLang) ? window.GM_I18N.getLang() : 'en';
        var locale = lang === 'fr' ? 'fr-FR' : 'en-GB';
        var date = d.toLocaleDateString(locale, { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'UTC' });
        return date + ' · ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ' UTC';
    }

    // Modale jour + heure (interprétés en UTC). callback(isoString) si confirmé,
    // callback(null) si annulé. Réutilisée par events.js et shadowfront.js.
    function pickEventStart(opts, callback) {
        opts = opts || {};
        var existing = document.getElementById('evt-start-overlay');
        if (existing) existing.remove();

        var now = (opts && opts.defaultVal) ? new Date(opts.defaultVal) : new Date();
        if (isNaN(now.getTime())) now = new Date();
        var defDate = now.getUTCFullYear() + '-' + pad2(now.getUTCMonth() + 1) + '-' + pad2(now.getUTCDate());
        var defTime = pad2(now.getUTCHours()) + ':' + pad2(now.getUTCMinutes());

        var overlay = document.createElement('div');
        overlay.id = 'evt-start-overlay';
        overlay.className = 'confirm-overlay';
        overlay.innerHTML =
            '<div class="confirm-card glass-card">' +
                '<div class="confirm-icon"><i class="ph-fill ph-calendar-plus text-accent"></i></div>' +
                '<h3>' + t('event_start_when_title') + '</h3>' +
                '<p>' + (opts.eventLabel ? '<strong>' + escapeHTML(opts.eventLabel) + '</strong> - ' : '') + t('event_start_when_body') + '</p>' +
                '<div class="gm-col" style="gap:.75rem; text-align:left; margin:.25rem 0 1.2rem;">' +
                    '<div class="gm-col" style="gap:.3rem;">' +
                        '<span class="gm-dim" style="font-size:.8rem;">' + t('event_start_date') + '</span>' +
                        '<input type="date" id="evt-start-date" class="gm-input" value="' + defDate + '">' +
                    '</div>' +
                    '<div class="gm-col" style="gap:.3rem;">' +
                        '<span class="gm-dim" style="font-size:.8rem;">' + t('event_start_time') + '</span>' +
                        '<input type="time" id="evt-start-time" class="gm-input" value="' + defTime + '">' +
                    '</div>' +
                '</div>' +
                '<div class="confirm-actions" style="gap:1rem;">' +
                    '<button id="evt-start-cancel" class="btn-ghost">' + t('confirm_cancel') + '</button>' +
                    '<button id="evt-start-ok" class="primary-btn">' + t('event_start_confirm') + '</button>' +
                '</div>' +
            '</div>';
        document.body.appendChild(overlay);
        requestAnimationFrame(function () { overlay.classList.add('visible'); });

        var done = false;
        function close(result) {
            if (done) return;
            done = true;
            overlay.classList.remove('visible');
            setTimeout(function () { overlay.remove(); }, 300);
            callback(result);
        }
        document.getElementById('evt-start-cancel').addEventListener('click', function () { close(null); });
        overlay.addEventListener('click', function (ev) { if (ev.target === overlay) close(null); });
        document.getElementById('evt-start-ok').addEventListener('click', function () {
            var dateStr = document.getElementById('evt-start-date').value;
            var timeStr = document.getElementById('evt-start-time').value;
            if (!dateStr || !timeStr) { showToast(t('event_start_invalid'), 'error'); return; }
            var dm = dateStr.split('-');
            var tm = timeStr.split(':');
            var d = new Date(Date.UTC(
                parseInt(dm[0], 10), parseInt(dm[1], 10) - 1, parseInt(dm[2], 10),
                parseInt(tm[0], 10), parseInt(tm[1], 10), 0
            ));
            if (isNaN(d.getTime())) { showToast(t('event_start_invalid'), 'error'); return; }
            close(d.toISOString());
        });
    }

    var localConfigFallback = {
        coeff_svs: '5',
        coeff_gvg: '5',
        coeff_shadowfront: '3',
        coeff_dtr: '2',
        coeff_armsrace: '1',
        webhook_armsrace: '',
        webhook_dtr: '',
        webhook_shadowfront: '',
        webhook_calamity: '',
        webhook_gvg: '',
        webhook_svs: '',
        webhook_svs_opponent: '',
        webhook_gvg_opponent: '',
        notify_armsrace_reminder_30: 'true',
        notify_armsrace_reminder_5: 'true',
        notify_armsrace_start: 'true',
        notify_dtr_reminder_30: 'true',
        notify_dtr_reminder_5: 'true',
        notify_dtr_start: 'true',
        notify_shadowfront_reminder_30: 'true',
        notify_shadowfront_reminder_5: 'true',
        notify_shadowfront_start: 'true',
        notify_calamity_10: 'true',
        notify_gvg_pvp: 'true',
        notify_svs_garrison: 'true',
        notify_svs_pvp: 'true',
        notify_svs_won_prep: 'false'
    };

    async function getGuildConfig(key) {
        var currentG = getActiveGuild();
        var c = getClient();
        if (c) {
            try {
                var query = c.from('guild_config').select('value').eq('key', key).eq('guild', currentG);
                var res = await query.maybeSingle();
                if (res && res.error) {
                    console.error('guild_config select error for key ' + key + ':', res.error);
                }
                if (res && res.data) return res.data.value;
            } catch (e) {
                console.warn('guild_config table fetch error, falling back to LocalStorage', e);
            }
        }
        var local = localStorage.getItem('gm_config_' + currentG + '_' + key);
        return local !== null ? local : (localConfigFallback[key] !== undefined ? localConfigFallback[key] : '');
    }

    async function setGuildConfig(key, value) {
        var currentG = getActiveGuild();
        localStorage.setItem('gm_config_' + currentG + '_' + key, value);
        var c = getClient();
        if (c) {
            var res = await c.from('guild_config').upsert(
                { guild: currentG, key: key, value: value, updated_at: new Date().toISOString() },
                { onConflict: 'guild,key' }
            );
            if (res && res.error) {
                console.warn('setGuildConfig db error:', res.error);
                return false;
            }
        }
        return true;
    }

    function getCurrentPseudo() {
        try {
            return localStorage.getItem('gm_user') || localStorage.getItem('gm_pseudo') || null;
        } catch (_) { return null; }
    }

    function formatDiscordRoleMention(input) {
        if (!input || typeof input !== 'string') return '@everyone';
        var str = input.trim();
        if (!str || str === '@everyone') return '@everyone';
        if (str === '@here') return '@here';

        var match = str.match(/\d{15,22}/);
        if (match) {
            return '<@&' + match[0] + '>';
        }

        if (str.indexOf('<@&') === 0 && str.indexOf('>') === str.length - 1) {
            return str;
        }

        return str;
    }

    async function resolveDiscordWebhook(eventPrefix) {
        var webhookUrl = eventPrefix ? await getGuildConfig('webhook_' + eventPrefix) : null;
        if (!webhookUrl || webhookUrl.trim() === '') {
            webhookUrl = await getGuildConfig('discord_webhook_url');
        }
        if (!webhookUrl || webhookUrl.trim() === '') {
            var fallbackKeys = ['webhook_armsrace', 'webhook_svs', 'webhook_gvg', 'webhook_dtr', 'webhook_calamity', 'webhook_shadowfront'];
            for (var k = 0; k < fallbackKeys.length; k++) {
                var fb = await getGuildConfig(fallbackKeys[k]);
                if (fb && fb.trim() !== '') {
                    webhookUrl = fb;
                    break;
                }
            }
        }
        return (webhookUrl && webhookUrl.trim() !== '') ? webhookUrl : null;
    }

    async function sendDiscordWebhookDetailed(eventPrefix, body) {
        try { await ensureAuthSession(); } catch (_) {}
        var currentG = getActiveGuild();
        var webhookUrl = await resolveDiscordWebhook(eventPrefix);
        if (webhookUrl) {
            webhookUrl = webhookUrl.trim().replace(/^[<"'\s]+|[>'"\s]+$/g, '');
            if (webhookUrl.indexOf('http') !== 0) {
                webhookUrl = 'https://' + webhookUrl;
            }
        }

        console.log("=== DISCORD WEBHOOK DIAGNOSTIC ===");
        console.log("Original body:", JSON.parse(JSON.stringify(body)));
        console.log("Has embeds array:", Array.isArray(body.embeds));
        if (body.embeds && body.embeds.length > 0) {
            console.log("Embeds[0] fields:", body.embeds[0].fields);
        }

        // Attempt 1: Invoke Edge Function Proxy (bypasses browser CORS & adblocker restrictions)
        // Passes guild and eventPrefix so server-side proxy can resolve webhook if client-side is null/empty
        var client = getClient();
        if (client && client.functions && typeof client.functions.invoke === 'function') {
            var payloadToSend = Object.assign({
                webhookUrl: webhookUrl || '',
                eventPrefix: eventPrefix,
                guild: currentG,
                payload: body
            }, body);

            try {
                var invokeRes = await client.functions.invoke('discord-webhook-proxy', {
                    body: payloadToSend
                });

                if (invokeRes && invokeRes.data && invokeRes.data.ok) {
                    return { ok: true };
                }

                if (invokeRes && (invokeRes.error || (invokeRes.data && !invokeRes.data.ok))) {
                    console.warn('Proxy invocation error, attempting direct apikey proxy fallback...', invokeRes.error);
                    try {
                        var rawProxyRes = await fetch(SUPABASE_URL + '/functions/v1/discord-webhook-proxy', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'apikey': SUPABASE_KEY
                            },
                            body: JSON.stringify(payloadToSend)
                        });
                        if (rawProxyRes && typeof rawProxyRes.json === 'function') {
                            var rawData = await rawProxyRes.json();
                            if (rawData && rawData.ok) return { ok: true };
                            return { ok: false, error: rawData ? rawData.error : "Unknown proxy fallback error" };
                        }
                    } catch (eRaw) {
                        console.warn('Direct apikey proxy fallback failed:', eRaw);
                    }
                }

                if (invokeRes && invokeRes.data && invokeRes.data.error) {
                    console.warn('Discord webhook proxy returned error:', invokeRes.data.error);
                    return { ok: false, error: invokeRes.data.error };
                } else if (invokeRes && invokeRes.error) {
                    console.warn('Edge Function proxy invoke error:', invokeRes.error);
                    return { ok: false, error: invokeRes.error.message || invokeRes.error };
                }
                
                return { ok: false, error: "Unknown error from invoke" };
            } catch (eProxy) {
                console.warn('Edge Function proxy invoke failed, trying direct fetch fallback:', eProxy);
                return { ok: false, error: eProxy.message || eProxy };
            }
        }

        if (!webhookUrl) return { ok: false, error: "No webhook URL found" };

        // Attempt 2: Direct fetch fallback
        try {
            var res = await fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            if (res.ok || res.status === 204) return { ok: true };
            return { ok: false, error: "HTTP " + res.status + " " + res.statusText };
        } catch (e) {
            console.error('Discord webhook fetch error:', e);
            return { ok: false, error: e.message || e };
        }
    }

    async function sendDiscordWebhook(eventPrefix, body) {
        var res = await sendDiscordWebhookDetailed(eventPrefix, body);
        return res.ok;
    }

    async function shareMatchupRosterToDiscord(options) {
        options = options || {};
        var title = options.title || 'Target Roster';
        var eventPrefix = options.eventPrefix || 'svs';
        var rows = options.rows || [];
        var targetLabel = options.targetLabel || 'Target';

        if (!rows || rows.length === 0) {
            if (window.GM_APP && window.GM_APP.showToast) {
                window.GM_APP.showToast('No players in roster to share.', 'warning');
            } else if (typeof showToast === 'function') {
                showToast('No players in roster to share.', 'warning');
            }
            return false;
        }

        var webhookUrl = (options.webhookUrl && options.webhookUrl.trim()) ? options.webhookUrl.trim() : null;
        if (!webhookUrl) {
            webhookUrl = await getGuildConfig('webhook_' + eventPrefix + '_opponent');
        }
        if (!webhookUrl || !webhookUrl.trim()) {
            var inputUrl = window.prompt('No dedicated ' + eventPrefix.toUpperCase() + ' Opponent Discord Webhook URL configured. Please enter Webhook URL:');
            if (!inputUrl || !inputUrl.trim()) return false;
            webhookUrl = inputUrl.trim();
        }
        webhookUrl = webhookUrl.trim().replace(/^[<"'\s]+|[>'"\s]+$/g, '');
        if (webhookUrl.indexOf('http') !== 0) {
            webhookUrl = 'https://' + webhookUrl;
        }

        var totalPower = 0;
        var extremeCount = 0;
        var highCount = 0;

        rows.forEach(function (r) {
            totalPower += (r.power || 0);
            var tier = String(r.danger_tier || '').toUpperCase();
            if (tier === 'EXTREME') extremeCount++;
            if (tier === 'HIGH') highCount++;
        });

        var highPlusCount = extremeCount + highCount;

        var headerText = '⚔️ **' + title + ' — ' + targetLabel + '**\n' +
            '📊 **Players:** ' + rows.length + ' | 💥 **Total Power:** ' + formatPower(totalPower) + ' | ⚠️ **Threats (High+):** ' + highPlusCount + '\n\n' +
            '**Member** | **Guild** | **Power** | **Threat**\n' +
            '----------------------------------------\n';

        var playerLines = rows.map(function (r, idx) {
            var tier = String(r.danger_tier || '').toUpperCase();
            var threatBadge = '🟢 LOW';
            if (tier === 'EXTREME') threatBadge = '🔴 EXTREME';
            else if (tier === 'HIGH') threatBadge = '🟠 HIGH';
            else if (tier === 'MEDIUM') threatBadge = '🟡 MEDIUM';

            return '#' + (idx + 1) + ' `' + (r.pseudo || '') + '` | `' + (r.guild || '') + '` | ' + formatPower(r.power || 0) + ' | ' + threatBadge;
        });

        var chunks = [];
        var currentChunk = headerText;

        for (var i = 0; i < playerLines.length; i++) {
            var line = playerLines[i] + '\n';
            if (currentChunk.length + line.length > 1850) {
                chunks.push(currentChunk);
                currentChunk = line;
            } else {
                currentChunk += line;
            }
        }
        if (currentChunk.trim().length > 0) {
            chunks.push(currentChunk);
        }

        var successCount = 0;
        var lastErrReason = '';

        for (var cIdx = 0; cIdx < chunks.length; cIdx++) {
            var posted = false;

            // Attempt 1: Invoke Edge Function Proxy (bypasses browser CORS & adblocker restrictions)
            var client = getClient();
            if (client && client.functions && typeof client.functions.invoke === 'function') {
                try {
                    var invokeRes = await client.functions.invoke('discord-webhook-proxy', {
                        body: { webhookUrl: webhookUrl, content: chunks[cIdx] }
                    });
                    if (invokeRes && invokeRes.data && invokeRes.data.ok) {
                        posted = true;
                    } else if (invokeRes && invokeRes.data && invokeRes.data.error) {
                        lastErrReason = invokeRes.data.error;
                    } else if (invokeRes && invokeRes.error) {
                        lastErrReason = (invokeRes.error.message || String(invokeRes.error));
                    }
                } catch (eProxy) {
                    console.warn('Edge Function proxy invoke failed, trying direct fetch fallback:', eProxy);
                }
            }

            // Attempt 2: Fallback direct fetch if Edge Function proxy is unavailable
            if (!posted) {
                try {
                    var res = await fetch(webhookUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ content: chunks[cIdx] })
                    });
                    if (res.ok || res.status === 204 || res.status === 200) {
                        posted = true;
                    } else {
                        var errBody = '';
                        try { errBody = await res.text(); } catch (e) {}
                        lastErrReason = 'HTTP ' + res.status + ' ' + (res.statusText || '') + (errBody ? ': ' + errBody : '');
                    }
                } catch (err) {
                    lastErrReason = (err && err.message) || lastErrReason || 'Network/CORS error';
                }
            }

            if (posted) {
                successCount++;
            }

            if (chunks.length > 1) {
                await new Promise(function (r) { setTimeout(r, 300); });
            }
        }

        if (successCount > 0) {
            var msg = 'Target roster shared to Discord successfully! (' + successCount + ' message' + (successCount > 1 ? 's' : '') + ')';
            if (window.GM_APP && window.GM_APP.showToast) {
                window.GM_APP.showToast(msg, 'success');
            } else if (typeof showToast === 'function') {
                showToast(msg, 'success');
            }
            return true;
        } else {
            var errStr = 'Failed to post roster to Discord: ' + (lastErrReason || 'Unknown error');
            if (window.GM_APP && window.GM_APP.showToast) {
                window.GM_APP.showToast(errStr, 'error');
            } else if (typeof showToast === 'function') {
                showToast(errStr, 'error');
            }
            return false;
        }
    }

    async function notifyDiscordEvent(eventName, eventStart, action) {
        if (!getClient()) return;

        var eventPrefix = '';
        var nameUpper = String(eventName || '').toUpperCase();
        if (nameUpper.indexOf('ARMS RACE') !== -1) eventPrefix = 'armsrace';
        else if (nameUpper.indexOf('TRADE ROUTE') !== -1 || nameUpper.indexOf('DTR') !== -1) eventPrefix = 'dtr';
        else if (nameUpper.indexOf('SHADOWFRONT') !== -1) eventPrefix = 'shadowfront';
        else if (nameUpper.indexOf('CALAMITY') !== -1) eventPrefix = 'calamity';
        else if (nameUpper.indexOf('GVG') !== -1) eventPrefix = 'gvg';
        else if (nameUpper.indexOf('SVS') !== -1) eventPrefix = 'svs';

        if (!await resolveDiscordWebhook(eventPrefix)) return;

        if ((action === 'start' || action === 'edit') && eventPrefix) {
            var creationEnabled = await getGuildConfig('notify_' + eventPrefix + '_creation');
            if (creationEnabled === 'false' || creationEnabled === false) return;
        }


        var dateObj = new Date(eventStart);
        var dateFormatted = !isNaN(dateObj.getTime())
            ? dateObj.toLocaleString('en-US', {
                weekday: 'short', month: '2-digit', day: '2-digit', timeZone: 'UTC',
                hour: '2-digit', minute: '2-digit', hour12: false
              }) + ' UTC'
            : String(eventStart);

        var eventSpecificRoleId = eventPrefix ? await getGuildConfig('discord_role_id_' + eventPrefix) : null;
        var globalRoleId = await getGuildConfig('discord_role_id');
        var discordRoleId = (eventSpecificRoleId && eventSpecificRoleId.trim() !== '') 
            ? eventSpecificRoleId 
            : globalRoleId;

        var eventGuildTag = formatDiscordRoleMention(discordRoleId);

        var actionLabel = '';
        var content = '📢 **Guild Event Update:** ' + eventName + ' (' + action + ') ' + eventGuildTag;
        var embedTitle = '📢 Guild Event: ' + eventName;
        var embedDesc = 'A guild event schedule has been updated in the FGF Guild Management tool!';
        var color = 5763719; // Green

        if (action === 'start') {
            actionLabel = '🚀 Scheduled / Live';
            color = 5763719; // Green
        } else if (action === 'edit') {
            actionLabel = '📅 Schedule Updated';
            color = 16750848; // Orange
        } else if (action === 'reminder_30') {
            content = '⏰ **Reminder:** ' + eventName + ' starts in **30 minutes**! ' + eventGuildTag;
            embedTitle = '⏰ Reminder: ' + eventName + ' starts in 30 minutes!';
            embedDesc = 'Get ready, soldiers! Please log in and prepare for the event.';
            color = 16750848; // Orange
        } else if (action === 'reminder_5') {
            content = '🚨 **Immediate Reminder:** ' + eventName + ' starts in **5 minutes**! Get ready! ' + eventGuildTag;
            embedTitle = '🚨 Immediate Reminder: ' + eventName + ' starts in 5 minutes!';
            embedDesc = 'Action time! Join your squad now!';
            color = 15548997; // Bright Red
        }

        if (action !== 'edit') {
            var customContent = await getGuildConfig('tpl_' + eventPrefix + '_' + action + '_content');
            var customTitle = await getGuildConfig('tpl_' + eventPrefix + '_' + action + '_title');
            var customDesc = await getGuildConfig('tpl_' + eventPrefix + '_' + action + '_desc');

            var replacePlaceholders = function (str) {
                if (!str) return str;
                return str
                    .replace(/@{guild_tag}/g, '{guild_tag}')
                    .replace(/{event_name}/g, eventName)
                    .replace(/{date}/g, dateFormatted)
                    .replace(/{guild_tag}/g, eventGuildTag)
                    .replace(/<@(\d{15,22})>/g, '<@&$1>')
                    .replace(/(^|\s)@(\d{15,22})($|\s)/g, '$1<@&$2>$3');
            };

            if (customContent && customContent.trim() !== '') content = replacePlaceholders(customContent);
            if (customTitle && customTitle.trim() !== '') embedTitle = replacePlaceholders(customTitle);
            if (customDesc && customDesc.trim() !== '') embedDesc = replacePlaceholders(customDesc);
        }

        var fields = [];
        if (actionLabel) {
            fields.push({ name: 'Status', value: actionLabel, inline: true });
        }
        fields.push({ name: 'Start Time (UTC)', value: dateFormatted, inline: true });
        fields.push({ name: 'Guild Agenda', value: action.indexOf('reminder') !== -1 ? 'Please connect now.' : 'Please prepare and be ready at the scheduled time.', inline: false });

        var body = {
            content: content,
            embeds: [{
                title: embedTitle,
                description: embedDesc,
                color: color,
                fields: fields,
                timestamp: new Date().toISOString(),
                footer: {
                    text: 'FGF Guild Management Tool'
                }
            }]
        };

        await sendDiscordWebhook(eventPrefix, body);
    }

    function formatPower(val) {
        if (!val) return '-';
        var num = parseInt(val) || 0;
        if (num >= 1000000000) return (num / 1000000000).toFixed(1) + 'B';
        if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
        if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
        return String(num);
    }

    function getPowerTier(power, maxPower) {
        if (!power) return 'D';
        var p = parseInt(power) || 0;
        var m = parseInt(maxPower) || 0;
        if (m === 0) return 'D';
        var pct = p / m;
        if (pct >= 0.8) return 'S';
        if (pct >= 0.6) return 'A';
        if (pct >= 0.4) return 'B';
        if (pct >= 0.2) return 'C';
        return 'D';
    }

    function getPowerTierMeta(tier) {
        if (tier === 'S') return { cls: 'tier-s', label: 'Mythic', color: 'var(--accent)', icon: '👑' };
        if (tier === 'A') return { cls: 'tier-a', label: 'Legendary', color: '#ef4444', icon: '🔥' }; // Red
        if (tier === 'B') return { cls: 'tier-b', label: 'Epic', color: '#f97316', icon: '💎' }; // Orange
        if (tier === 'C') return { cls: 'tier-c', label: 'Rare', color: '#3b82f6', icon: '⭐' }; // Blue
        return { cls: 'tier-d', label: 'Common', color: 'var(--text-muted)', icon: '🛡️' };
    }

    function getEventIcon(name) {
        if (!name) return 'ph-calendar-dot';
        var lower = String(name).toLowerCase();
        if (lower.indexOf('svs') !== -1) return 'ph-swords';
        if (lower.indexOf('gvg') !== -1) return 'ph-flag-banner';
        if (lower.indexOf('shadowfront') !== -1) return 'ph-ghost';
        if (lower.indexOf('trade') !== -1 || lower.indexOf('dtr') !== -1) return 'ph-truck';
        if (lower.indexOf('stage a') !== -1) return 'ph-crosshair';
        if (lower.indexOf('stage b') !== -1) return 'ph-target';
        if (lower.indexOf('arms') !== -1 || lower.indexOf('race') !== -1) return 'ph-crosshair';
        if (lower.indexOf('glory') !== -1) return 'ph-trophy';
        if (lower.indexOf('sanction') !== -1) return 'ph-warning-octagon';
        return 'ph-calendar-dot';
    }

    function getEventTheme(name) {
        if (!name) return 'gm-task-card-dark';
        var lower = String(name).toLowerCase();
        if (lower.indexOf('svs') !== -1) return 'gm-task-card-lime';
        if (lower.indexOf('gvg') !== -1) return 'gm-task-card-coral';
        if (lower.indexOf('shadowfront') !== -1) return 'gm-task-card-lilac';
        if (lower.indexOf('trade') !== -1 || lower.indexOf('dtr') !== -1) return 'gm-task-card-cyan';
        if (lower.indexOf('arms') !== -1 || lower.indexOf('race') !== -1) return 'gm-task-card-amber';
        if (lower.indexOf('glory') !== -1) return 'gm-task-card-mint';
        if (lower.indexOf('sanction') !== -1) return 'gm-task-card-lilac';
        return 'gm-task-card-dark';
    }

    function getActiveGuild() {
        return window.currentGuildRestriction || window.currentGuild || localStorage.getItem('gm_current_guild') || 'ALPHA';
    }

    // True when a guild has payments disabled (self-service subscription flow
    // turned off). Data-driven from window.guildsData, which mirrors the
    // guilds.payments_disabled column; used by the shell nav and the
    // subscription page so the check lives in one place.
    function isPaymentsDisabled(guildId) {
        var g = guildId || getActiveGuild();
        if (!window.guildsData || !window.guildsData[g]) return false;
        return !!window.guildsData[g].paymentsDisabled;
    }

    function parseGeminiJson(jsonText) {
        if (!jsonText) return null;
        var cleaned = String(jsonText).replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
        try {
            return JSON.parse(cleaned);
        } catch (e) {
            var firstObj = cleaned.indexOf('{');
            var lastObj = cleaned.lastIndexOf('}');
            var firstArr = cleaned.indexOf('[');
            var lastArr = cleaned.lastIndexOf(']');
            
            var start = -1;
            var end = -1;

            if (firstObj !== -1 && lastObj > firstObj) {
                start = firstObj;
                end = lastObj + 1;
            }
            if (firstArr !== -1 && lastArr > firstArr) {
                if (start === -1 || (firstArr !== -1 && firstArr < start)) {
                    start = firstArr;
                    end = lastArr + 1;
                }
            }

            if (start !== -1 && end > start) {
                var sub = cleaned.substring(start, end);
                try {
                    return JSON.parse(sub);
                } catch (e2) {
                    console.warn('Fallback OCR JSON substring parse failed:', e2);
                }
            }
            throw e;
        }
    }

    window.GM = {
        db: db,
        t: t,
        login: login,
        logout: logout,
        ensureAuthSession: ensureAuthSession,
        adminAccounts: adminAccounts,
        registerPlayer: registerPlayer,
        generateJoinCode: generateJoinCode,
        sessionInfo: sessionInfo,
        forceRefreshPortalSession: forceRefreshPortalSession,
        normalizeRole: normalizeRole,
        roleFromStorage: roleFromStorage,
        isSuperAdmin: isSuperAdmin,
        getRoleInfo: getRoleInfo,
        getActiveGuild: getActiveGuild,
        getCurrentPseudo: getCurrentPseudo,
        isPaymentsDisabled: isPaymentsDisabled,
        isGuildSubscriptionExpired: isGuildSubscriptionExpired,
        canWriteGuild: canWriteGuild,
        ensureGuildRestriction: ensureGuildRestriction,
        escapeHTML: escapeHTML,
        getWeekStart: getWeekStart,
        getPrevWeekStart: getPrevWeekStart,
        formatWeek: formatWeek,
        newSessionId: newSessionId,
        buildEventSessionId: buildEventSessionId,
        eventScoringKey: eventScoringKey,
        sessionDateFromId: sessionDateFromId,
        formatDateTimeUTC: formatDateTimeUTC,
        pickEventStart: pickEventStart,
        showToast: showToast,
        validatePseudo: validatePseudo,
        validateUid: validateUid,
        formatNumber: formatNumber,
        parseNumber: parseNumber,
        parseGeminiJson: parseGeminiJson,
        attachNumberFormatter: attachNumberFormatter,
        avatarInit: avatarInit,
        MAX_NUMERIC: MAX_NUMERIC,
        formatPower: formatPower,
        getPowerTier: getPowerTier,
        getPowerTierMeta: getPowerTierMeta,
        getEventIcon: getEventIcon,
        getEventTheme: getEventTheme,
        config: {
            get: getGuildConfig,
            set: setGuildConfig
        },
        formatDiscordRoleMention: formatDiscordRoleMention,
        notifyDiscordEvent: notifyDiscordEvent,
        sendDiscordWebhookDetailed: sendDiscordWebhookDetailed,
        sendDiscordWebhook: sendDiscordWebhook,
        shareMatchupRosterToDiscord: shareMatchupRosterToDiscord
    };

})();
