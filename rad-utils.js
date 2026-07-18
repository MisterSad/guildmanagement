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

    var localRestriction = localStorage.getItem('rad_guild_restriction');
    window.currentGuildRestriction = localRestriction || null;
    window.currentGuild = localRestriction || localStorage.getItem('rad_current_guild') || 'ALPHA';
    window.guildsList = ['ALPHA', 'OMEGA', 'IMK'];

    function isGuildSubscriptionExpired(guildId) {
        if (localStorage.getItem('rad_role') === 'admin') {
            return false; // Super admin is never restricted
        }
        if (!guildId) return false;
        if (!window.guildsData || !window.guildsData[guildId]) return false;
        var sub = window.guildsData[guildId];
        if (sub.type === 'Unlimited') return false;
        if (sub.type === 'Premium') {
            if (!sub.end) return true; // Premium without end date is expired
            return new Date(sub.end).getTime() < Date.now();
        }
        return false;
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
                'shadowfront_squads',
                'sanctions',
                'weekly_scores',
                'guild_config',
                'push_subscriptions',
                'event_reminders_sent',
                'discord_notifications_sent',
                'shadowfront_signups',
                'player_name_history'
            ];
            if (tenantTables.indexOf(table) !== -1) {
                var originalSelect = builder.select;
                builder.select = function () {
                    return originalSelect.apply(this, arguments).eq('guild', window.currentGuild || 'ALPHA');
                };

                var originalDelete = builder.delete;
                builder.delete = function () {
                    if (isGuildSubscriptionExpired(window.currentGuild)) {
                        return { then: function(resolve) { resolve({ data: null, error: { message: "The subscription for this guild has expired. Read-only access only." } }); } };
                    }
                    return originalDelete.apply(this, arguments).eq('guild', window.currentGuild || 'ALPHA');
                };

                var originalUpdate = builder.update;
                builder.update = function (values, options) {
                    if (isGuildSubscriptionExpired(window.currentGuild)) {
                        return { then: function(resolve) { resolve({ data: null, error: { message: "The subscription for this guild has expired. Read-only access only." } }); } };
                    }
                    return originalUpdate.call(this, values, options).eq('guild', window.currentGuild || 'ALPHA');
                };

                var originalInsert = builder.insert;
                builder.insert = function (values, options) {
                    if (isGuildSubscriptionExpired(window.currentGuild)) {
                        return { then: function(resolve) { resolve({ data: null, error: { message: "The subscription for this guild has expired. Read-only access only." } }); } };
                    }
                    var guildVal = window.currentGuild || 'ALPHA';
                    if (Array.isArray(values)) {
                        values = values.map(function (v) {
                            return Object.assign({ guild: guildVal }, v);
                        });
                    } else if (values && typeof values === 'object') {
                        values = Object.assign({ guild: guildVal }, values);
                    }
                    return originalInsert.call(this, values, options);
                };

                var originalUpsert = builder.upsert;
                builder.upsert = function (values, options) {
                    if (isGuildSubscriptionExpired(window.currentGuild)) {
                        return { then: function(resolve) { resolve({ data: null, error: { message: "The subscription for this guild has expired. Read-only access only." } }); } };
                    }
                    var guildVal = window.currentGuild || 'ALPHA';
                    if (Array.isArray(values)) {
                        values = values.map(function (v) {
                            return Object.assign({ guild: guildVal }, v);
                        });
                    } else if (values && typeof values === 'object') {
                        values = Object.assign({ guild: guildVal }, values);
                    }
                    return originalUpsert.call(this, values, options);
                };
            }
            return builder;
        };
    }

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

    // Format an ISO timestamp as a short UTC wall-clock label, eg "ven. 17/05 · 20:00 UTC".
    function formatDateTimeUTC(iso) {
        if (!iso) return '';
        var d = new Date(iso);
        if (isNaN(d.getTime())) return '';
        var lang = (window.RAD_I18N && window.RAD_I18N.getLang) ? window.RAD_I18N.getLang() : 'en';
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
                '<p>' + (opts.eventLabel ? '<strong>' + escapeHTML(opts.eventLabel) + '</strong> — ' : '') + t('event_start_when_body') + '</p>' +
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
        if (db) {
            try {
                var res = await db.from('guild_config').select('value').eq('key', key).maybeSingle();
                if (res && res.error) {
                    console.error('guild_config select error for key ' + key + ':', res.error);
                }
                if (res && res.data) return res.data.value;
            } catch (e) {
                console.warn('guild_config table fetch error, falling back to LocalStorage', e);
            }
        }
        var local = localStorage.getItem('rad_config_' + (window.currentGuild || 'ALPHA') + '_' + key);
        return local !== null ? local : (localConfigFallback[key] !== undefined ? localConfigFallback[key] : '');
    }

    async function setGuildConfig(key, value) {
        localStorage.setItem('rad_config_' + (window.currentGuild || 'ALPHA') + '_' + key, value);
        if (db) {
            var res = await db.from('guild_config').upsert(
                { key: key, value: value, updated_at: new Date().toISOString() },
                { onConflict: 'guild,key' }
            );
            if (res && res.error) {
                throw new Error(res.error.message || 'upsert_failed');
            }
        }
        return true;
    }

    async function notifyDiscordEvent(eventName, startAt, action) {
        var eventPrefix = '';
        if (eventName.indexOf('ARMS RACE') !== -1) {
            eventPrefix = 'armsrace';
        } else if (eventName === 'Defend Trade Route') {
            eventPrefix = 'dtr';
        } else if (eventName.indexOf('Shadowfront Squad') !== -1) {
            eventPrefix = 'shadowfront';
        } else if (eventName === 'GvG') {
            eventPrefix = 'gvg';
        } else if (eventName === 'SvS') {
            eventPrefix = 'svs';
        } else if (eventName.indexOf('Calamity') !== -1) {
            eventPrefix = 'calamity';
        }

        if (!eventPrefix) return;

        var webhookUrl = await getGuildConfig('webhook_' + eventPrefix);
        if (!webhookUrl || webhookUrl.trim() === '') return;

        // Check if this type of notification is enabled
        var configKey = 'notify_' + eventPrefix + '_';
        if (action === 'start' || action === 'edit') {
            configKey += 'start';
        } else if (action === 'reminder_30') {
            configKey += 'reminder_30';
        } else if (action === 'reminder_5') {
            configKey += 'reminder_5';
        } else if (action === 'reminder_10') {
            configKey += 'reminder_10';
        } else {
            configKey = ''; // unknown/fallback
        }

        if (configKey) {
            var isNotificationEnabled = await getGuildConfig(configKey);
            if (isNotificationEnabled === 'false') {
                console.log('Discord notification for ' + eventName + ' (' + action + ') is disabled in configuration.');
                return;
            }
        }

        var allowedEvents = [
            'ARMS RACE STAGE A',
            'ARMS RACE STAGE B',
            'Defend Trade Route',
            'Shadowfront Squad 1',
            'Shadowfront Squad 2'
        ];
        if (allowedEvents.indexOf(eventName) === -1) return;
        
        var dateFormatted = formatDateTimeUTC(startAt);
        var content = '';
        var embedTitle = '📢 Guild Event: ' + eventName;
        var embedDesc = 'A guild event has been configured in the FGF Guild Management tool!';
        var actionLabel = '';
        var color = 5763719; // Green

        var guildTag = '@everyone';

        var isDtrOrArmsRaceOrShadowfront = eventName === 'Defend Trade Route' || 
                                           eventName.indexOf('ARMS RACE') !== -1 ||
                                           eventName.indexOf('Shadowfront Squad') !== -1;
        var eventGuildTag = isDtrOrArmsRaceOrShadowfront ? '@everyone' : guildTag;

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
                    .replace(/{event_name}/g, eventName)
                    .replace(/{date}/g, dateFormatted)
                    .replace(/{guild_tag}/g, eventGuildTag);
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

        try {
            await fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
        } catch (e) {
            console.error('Discord webhook notify failed', e);
        }
    }

    function formatPower(val) {
        if (!val) return '—';
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
        formatDateTimeUTC: formatDateTimeUTC,
        pickEventStart: pickEventStart,
        showToast: showToast,
        validatePseudo: validatePseudo,
        validateUid: validateUid,
        formatNumber: formatNumber,
        parseNumber: parseNumber,
        attachNumberFormatter: attachNumberFormatter,
        avatarInit: avatarInit,
        MAX_NUMERIC: MAX_NUMERIC,
        formatPower: formatPower,
        getPowerTier: getPowerTier,
        getPowerTierMeta: getPowerTierMeta,
        config: {
            get: getGuildConfig,
            set: setGuildConfig
        },
        notifyDiscordEvent: notifyDiscordEvent
    };

})();
