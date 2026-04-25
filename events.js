/**
 * events.js — Standard events: SvS, GvG, Defend Trade Route, Glory
 */
(function () {

    var SUPABASE_URL = 'https://vgweufzwmfwplusskmuf.supabase.co';
    var SUPABASE_KEY = 'sb_publishable_c79HkCPMv7FmNvi1wGwlIg_N3isrSKo';
    var db;
    try { db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY); } catch (e) { console.error('events.js: supabase init', e); }

    var STANDARD_EVENTS = ['SvS', 'GvG', 'Defend Trade Route', 'ARMS RACE STAGE A', 'ARMS RACE STAGE B'];
    var PANEL_MAP = {
        'SvS':                'event-svs',
        'GvG':                'event-gvg',
        'Defend Trade Route': 'event-dtr',
        'ARMS RACE STAGE A':  'event-arms-a',
        'ARMS RACE STAGE B':  'event-arms-b'
    };

    function t(k) { return window.RAD_I18N ? window.RAD_I18N.t(k) : k; }

    function getWeekStart() {
        var d = new Date();
        var day = d.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
        var diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday-based
        var monday = new Date(d.getFullYear(), d.getMonth(), diff);
        var mm = String(monday.getMonth() + 1).padStart(2, '0');
        var dd = String(monday.getDate()).padStart(2, '0');
        return monday.getFullYear() + '-' + mm + '-' + dd;
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

    // ── State ────────────────────────────────────────────────────────────────
    var state = {};
    STANDARD_EVENTS.forEach(function (n) { state[n] = { isActive: false, participants: [] }; });
    var uidMap = {};

    // ── Public API ────────────────────────────────────────────────────────────
    window.RAD_EVENTS = {
        loadEvent:      loadEvent,
        setEventActive: setEventActive
    };

    // ── Load event (called when tab is clicked) ────────────────────────────
    async function loadEvent(eventName) {
        if (!db) return;
        try {
            var res = await db.from('event_status').select('is_active').eq('event_name', eventName).single();
            var isActive = res.data ? res.data.is_active : false;
            state[eventName].isActive = isActive;
            renderStatus(eventName, isActive);
            if (isActive) {
                await fetchParticipants(eventName);
            } else {
                renderInactive(eventName);
            }
        } catch (err) { console.error('loadEvent', err); }
    }

    // ── Set event active / inactive ───────────────────────────────────────
    async function setEventActive(eventName, newState) {
        if (!db) return;
        try {
            await db.from('event_status').upsert(
                { event_name: eventName, is_active: newState, updated_at: new Date().toISOString() },
                { onConflict: 'event_name' }
            );
            state[eventName].isActive = newState;
            renderStatus(eventName, newState);
            if (newState) {
                await populateParticipants(eventName);
            } else {
                renderInactive(eventName);
                if (window.RAD_APP) window.RAD_APP.showToast('Événement sauvegardé et terminé avec succès !', 'success');
            }
        } catch (err) { console.error('setEventActive', err); }
    }

    // ── Auto-populate members when event is activated ─────────────────────
    async function populateParticipants(eventName) {
        if (!db) return;
        var week = getWeekStart();
        var membersRes = await db.from('guild_members').select('pseudo');
        if (!membersRes.data) return;

        var existingRes = await db.from('event_participants').select('pseudo')
            .eq('event_name', eventName).eq('week_start', week);
        var existing = new Set((existingRes.data || []).map(function (r) { return r.pseudo; }));

        var toInsert = membersRes.data
            .filter(function (m) { return !existing.has(m.pseudo); })
            .map(function (m) { return { event_name: eventName, week_start: week, pseudo: m.pseudo, participated: 0, score: null }; });

        if (toInsert.length > 0) {
            await db.from('event_participants').insert(toInsert);
        }
        await fetchParticipants(eventName);
    }

    // ── Fetch participants ────────────────────────────────────────────────
    async function fetchParticipants(eventName) {
        if (!db) return;
        var [partRes, memRes] = await Promise.all([
            db.from('event_participants').select('*').eq('event_name', eventName).eq('week_start', getWeekStart()).order('pseudo', { ascending: true }),
            db.from('guild_members').select('pseudo, uid')
        ]);
        if (partRes.error) return;
        (memRes.data || []).forEach(function(m) { uidMap[m.pseudo] = m.uid; });
        state[eventName].participants = partRes.data || [];
        renderParticipants(eventName, state[eventName].participants);
    }

    // ── Save participation checkbox ───────────────────────────────────────
    async function saveParticipation(eventName, pseudo, participated) {
        if (!db) return;
        await db.from('event_participants').update({ participated: participated })
            .eq('event_name', eventName).eq('week_start', getWeekStart()).eq('pseudo', pseudo);
    }

    // ── Save score (debounced 600ms) ──────────────────────────────────────
    async function saveScore(eventName, pseudo, value) {
        if (!db) return;
        await db.from('event_participants').update({ score: value === '' ? null : parseInt(value, 10) })
            .eq('event_name', eventName).eq('week_start', getWeekStart()).eq('pseudo', pseudo);
    }

    // ── Render helpers ────────────────────────────────────────────────────
    function getContentEl(eventName) {
        var panel = document.getElementById(PANEL_MAP[eventName]);
        return panel ? panel.querySelector('.event-participants-area') : null;
    }

    function renderStatus(eventName, isActive) {
        var panel = document.getElementById(PANEL_MAP[eventName]);
        if (!panel) return;
        var badge    = panel.querySelector('.event-status-badge');
        var startBtn = panel.querySelector('.event-start-btn');
        var endBtn   = panel.querySelector('.event-end-btn');
        if (badge) {
            badge.className   = 'event-status-badge ' + (isActive ? 'active' : 'inactive');
            badge.textContent = isActive ? t('event_active') : t('event_inactive');
        }
        if (startBtn) startBtn.disabled = isActive;
        if (endBtn)   endBtn.disabled   = !isActive;
    }

    function renderInactive(eventName) {
        var el = getContentEl(eventName);
        if (!el) return;
        el.innerHTML =
            '<div class="empty-state">' +
                '<i class="ph-duotone ph-calendar-slash"></i>' +
                '<p>' + t('event_not_active') + '</p>' +
            '</div>';
    }

    function renderParticipants(eventName, participants) {
        var el = getContentEl(eventName);
        if (!el) return;
        if (!participants.length) {
            el.innerHTML = '<div class="empty-state"><i class="ph-duotone ph-ghost"></i><p>' + t('empty_members') + '</p></div>';
            return;
        }

        var done = participants.reduce(function (s, p) { return s + (p.participated || 0); }, 0);
        var totalScore = participants.reduce(function (s, p) { return s + (p.score || 0); }, 0);
        var hasScore = (eventName !== 'ARMS RACE STAGE A' && eventName !== 'ARMS RACE STAGE B');

        var html =
            '<div class="event-stats">' +
                '<span class="stat-chip"><i class="ph-fill ph-users"></i> ' + participants.length + ' ' + t('event_total') + '</span>' +
                '<span class="stat-chip success"><i class="ph-fill ph-check-circle"></i> ' + done + ' ' + t('event_participated') + '</span>' +
                '<span class="stat-chip muted"><i class="ph-fill ph-x-circle"></i> ' + (participants.length - done) + ' ' + t('event_absent') + '</span>' +
                (hasScore ? '<span class="stat-chip accent"><i class="ph-fill ph-trophy"></i> ' + t('event_total_score') + ' ' + totalScore + '</span>' : '') +
            '</div>' +
            '<div class="input-wrapper" style="margin-bottom: 1rem;">' +
                '<i class="ph ph-magnifying-glass"></i>' +
                '<input type="text" class="event-search-input" placeholder="' + t('search_placeholder') + '">' +
            '</div>' +
            '<div class="participants-table-wrap">' +
            '<table class="participants-table">' +
                '<thead><tr>' +
                    '<th>' + t('col_member') + '</th>' +
                    '<th class="center">' + t('col_participated') + '</th>' +
                    (hasScore ? '<th class="center">' + t('col_score') + '</th>' : '') +
                '</tr></thead><tbody>';

        participants.forEach(function (p) {
            html +=
                '<tr class="participant-row' + (p.participated ? ' participated' : '') + '" data-pseudo="' + escapeHTML(p.pseudo) + '">' +
                    '<td class="pseudo-cell"><i class="ph-fill ph-game-controller text-accent"></i> ' + escapeHTML(p.pseudo) + '</td>' +
                    '<td class="check-cell">' +
                        '<div class="counter-input">' +
                            '<button class="counter-btn minus" data-event="' + escapeHTML(eventName) + '" data-pseudo="' + escapeHTML(p.pseudo) + '"><i class="ph ph-minus"></i></button>' +
                            '<span class="counter-val">' + (p.participated || 0) + '</span>' +
                            '<button class="counter-btn plus" data-event="' + escapeHTML(eventName) + '" data-pseudo="' + escapeHTML(p.pseudo) + '"><i class="ph ph-plus"></i></button>' +
                        '</div>' +
                    '</td>' +
                    (hasScore ? '<td class="score-cell">' +
                        '<input type="number" min="0" class="score-input" value="' + (p.score != null ? p.score : '') + '" placeholder="—"' +
                            ' data-event="' + escapeHTML(eventName) + '" data-pseudo="' + escapeHTML(p.pseudo) + '">' +
                    '</td>' : '') +
                '</tr>';
        });

        html += '</tbody></table></div>';
        el.innerHTML = html;

        // Participation counter
        el.querySelectorAll('.counter-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var isPlus = btn.classList.contains('plus');
                var valEl = btn.parentElement.querySelector('.counter-val');
                var currentVal = parseInt(valEl.textContent, 10) || 0;
                var newVal = isPlus ? currentVal + 1 : Math.max(0, currentVal - 1);
                if (currentVal === newVal) return;
                
                valEl.textContent = newVal;
                var row = btn.closest('.participant-row');
                if (row) row.classList.toggle('participated', newVal > 0);
                
                // Update live
                saveParticipation(btn.getAttribute('data-event'), btn.getAttribute('data-pseudo'), newVal)
                    .then(function () { fetchParticipants(eventName); });
            });
        });

        // Score input (debounced)
        el.querySelectorAll('.score-input').forEach(function (inp) {
            var timer;
            inp.addEventListener('input', function () {
                clearTimeout(timer);
                timer = setTimeout(function () {
                    saveScore(inp.getAttribute('data-event'), inp.getAttribute('data-pseudo'), inp.value);
                }, 700);
            });
        });

        // Search filter
        var searchInput = el.querySelector('.event-search-input');
        if (searchInput) {
            searchInput.addEventListener('input', function(e) {
                var q = e.target.value.toLowerCase();
                el.querySelectorAll('.participant-row').forEach(function(row) {
                    var pseudo = row.getAttribute('data-pseudo').toLowerCase();
                    var uid = (uidMap[row.getAttribute('data-pseudo')] || '').toLowerCase();
                    if ((pseudo + ' ' + uid).indexOf(q) !== -1) {
                        row.style.display = '';
                    } else {
                        row.style.display = 'none';
                    }
                });
            });
        }
    }

    // ── Wire START / END buttons ──────────────────────────────────────────
    document.querySelectorAll('.event-start-btn[data-event]').forEach(function (btn) {
        var ev = btn.getAttribute('data-event');
        if (STANDARD_EVENTS.indexOf(ev) !== -1) {
            btn.addEventListener('click', function () { setEventActive(ev, true); });
        }
    });
    document.querySelectorAll('.event-end-btn[data-event]').forEach(function (btn) {
        var ev = btn.getAttribute('data-event');
        if (STANDARD_EVENTS.indexOf(ev) !== -1) {
            btn.addEventListener('click', function () { setEventActive(ev, false); });
        }
    });

})();
