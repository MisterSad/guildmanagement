/**
 * shadowfront.js — Shadowfront event: squad assignment + participation tracking
 * + History-based member recommendation (regulars vs rotation)
 * Squad 1 & Squad 2 → each 20 participants + 10 reserves
 */
(function () {

    var SUPABASE_URL = 'https://vgweufzwmfwplusskmuf.supabase.co';
    var SUPABASE_KEY = 'sb_publishable_c79HkCPMv7FmNvi1wGwlIg_N3isrSKo';
    var db;
    try { db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY); } catch (e) { console.error('shadowfront.js: supabase init', e); }

    var EVENT_NAME = 'Shadowfront';
    var PARTICIPANTS_MAX = 20;
    var RESERVES_MAX     = 10;

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

    // ── State ──────────────────────────────────────────────────────────────────
    var sfState = {
        isActive:     false,
        allMembers:   [],
        assignments:  [],
        participants: [],
        history:      {},   // pseudo → { assigned, participated }
        uidMap:       {}
    };

    // Current filter for unassigned list: 'all' | 'regular' | 'rotation'
    var sfFilter = 'all';
    var sfActiveTab = 'squads'; // 'squads' | 'tracking'

    // ── Public API ─────────────────────────────────────────────────────────────
    window.RAD_SHADOWFRONT = {
        load:   loadShadowfront,
        setShadowfrontActive: setShadowfrontActive
    };

    // ── Load ───────────────────────────────────────────────────────────────────
    async function loadShadowfront() {
        if (!db) return;
        try {
            var week = getWeekStart();

            var [statusRes, membersRes, assignRes, histSquads, histParts] = await Promise.all([
                db.from('event_status').select('is_active').eq('event_name', EVENT_NAME).single(),
                db.from('guild_members').select('pseudo, uid').order('pseudo', { ascending: true }),
                db.from('shadowfront_squads').select('*').eq('week_start', week).order('pseudo', { ascending: true }),
                // History: all past squad assignments (excluding this week)
                db.from('shadowfront_squads').select('pseudo').neq('week_start', week),
                // History: all past Shadowfront participations (excluding this week)
                db.from('event_participants').select('pseudo,participated')
                    .eq('event_name', EVENT_NAME).neq('week_start', week)
            ]);

            sfState.isActive    = statusRes.data ? statusRes.data.is_active : false;
            sfState.allMembers  = (membersRes.data || []).map(function (m) { return m.pseudo; });
            sfState.uidMap      = {};
            (membersRes.data || []).forEach(function(m) { sfState.uidMap[m.pseudo] = m.uid; });
            sfState.assignments = assignRes.data || [];

            // Build history map
            var hist = {};
            (histSquads.data || []).forEach(function (r) {
                if (!hist[r.pseudo]) hist[r.pseudo] = { assigned: 0, participated: 0 };
                hist[r.pseudo].assigned++;
            });
            (histParts.data || []).forEach(function (r) {
                if (!hist[r.pseudo]) hist[r.pseudo] = { assigned: 0, participated: 0 };
                if (r.participated > 0) hist[r.pseudo].participated += r.participated;
            });
            sfState.history = hist;

            if (sfState.isActive) {
                var partRes = await db.from('event_participants').select('*')
                    .eq('event_name', EVENT_NAME).eq('week_start', week).order('pseudo', { ascending: true });
                sfState.participants = partRes.data || [];
            }

            renderStatus();
            renderShadowfront();
        } catch (err) { console.error('loadShadowfront', err); }
    }

    // ── Set Active / Inactive ──────────────────────────────────────────────────
    async function setShadowfrontActive(newState) {
        if (!db) return;
        await db.from('event_status').upsert(
            { event_name: EVENT_NAME, is_active: newState, updated_at: new Date().toISOString() },
            { onConflict: 'event_name' }
        );
        sfState.isActive = newState;
        renderStatus();
        if (newState) {
            await syncParticipantRows();
        } else {
            if (window.RAD_APP) window.RAD_APP.showToast('Événement sauvegardé et terminé avec succès !', 'success');
        }
        renderShadowfront();
    }

    // ── Categorise a member based on history ───────────────────────────────────
    // Returns: 'regular' | 'rotation' | 'occasional'
    function categorise(pseudo) {
        var h = sfState.history[pseudo];
        if (!h || h.assigned === 0) return 'rotation';   // Never assigned
        var rate = h.participated / h.assigned;
        if (h.assigned >= 2 && rate >= 0.6) return 'regular';
        if (rate < 0.3)                     return 'rotation';
        return 'occasional';
    }

    function categoryMeta(cat) {
        if (cat === 'regular')    return { label: t('sf_cat_regular'),    cls: 'cat-regular',    icon: '🟢' };
        if (cat === 'rotation')   return { label: t('sf_cat_rotation'),   cls: 'cat-rotation',   icon: '🔵' };
        return                           { label: t('sf_cat_occasional'), cls: 'cat-occasional', icon: '🟡' };
    }

    // ── Assign ─────────────────────────────────────────────────────────────────
    async function assign(pseudo, squad, role) {
        if (!db) return;
        var week = getWeekStart();
        var existing = sfState.assignments.filter(function (a) { return a.squad === squad && a.role === role; });
        var max = role === 'participant' ? PARTICIPANTS_MAX : RESERVES_MAX;
        if (existing.length >= max) { showToastSF(t('sf_squad_full'), 'error'); return; }

        await db.from('shadowfront_squads').upsert(
            { week_start: week, pseudo: pseudo, squad: squad, role: role },
            { onConflict: 'week_start,pseudo' }
        );
        var res = await db.from('shadowfront_squads').select('*').eq('week_start', week);
        sfState.assignments = res.data || [];
        if (sfState.isActive) await syncParticipantRows();
        renderShadowfront();
    }

    // ── Unassign ───────────────────────────────────────────────────────────────
    async function unassign(pseudo) {
        if (!db) return;
        var week = getWeekStart();
        await db.from('shadowfront_squads').delete().eq('week_start', week).eq('pseudo', pseudo);
        sfState.assignments = sfState.assignments.filter(function (a) { return a.pseudo !== pseudo; });
        renderShadowfront();
    }

    // ── Sync participant rows ──────────────────────────────────────────────────
    async function syncParticipantRows() {
        if (!db) return;
        var week = getWeekStart();
        var existingRes = await db.from('event_participants').select('pseudo')
            .eq('event_name', EVENT_NAME).eq('week_start', week);
        var existing = new Set((existingRes.data || []).map(function (r) { return r.pseudo; }));

        var toInsert = sfState.assignments
            .filter(function (a) { return !existing.has(a.pseudo); })
            .map(function (a) { return { event_name: EVENT_NAME, week_start: week, pseudo: a.pseudo, participated: 0 }; });
        if (toInsert.length > 0) await db.from('event_participants').insert(toInsert);

        var partRes = await db.from('event_participants').select('*')
            .eq('event_name', EVENT_NAME).eq('week_start', week).order('pseudo', { ascending: true });
        sfState.participants = partRes.data || [];
    }

    async function saveParticipation(pseudo, participated) {
        if (!db) return;
        await db.from('event_participants').update({ participated: participated })
            .eq('event_name', EVENT_NAME).eq('week_start', getWeekStart()).eq('pseudo', pseudo);
    }

    // ── Render status badge + START/END buttons ────────────────────────────────
    function renderStatus() {
        var panel = document.getElementById('event-shadowfront');
        if (!panel) return;
        var badge    = panel.querySelector('.event-status-badge');
        var startBtn = panel.querySelector('.event-start-btn');
        var endBtn   = panel.querySelector('.event-end-btn');
        if (badge) {
            badge.className   = 'event-status-badge ' + (sfState.isActive ? 'active' : 'inactive');
            badge.textContent = sfState.isActive ? t('event_active') : t('event_inactive');
        }
        if (startBtn) startBtn.disabled = sfState.isActive;
        if (endBtn)   endBtn.disabled   = !sfState.isActive;
    }

    // ── Main render ────────────────────────────────────────────────────────────
    function renderShadowfront() {
        var area = document.querySelector('#event-shadowfront .event-participants-area');
        if (!area) return;

        if (!sfState.isActive) {
            area.innerHTML =
                '<div class="empty-state"><i class="ph-duotone ph-calendar-slash"></i>' +
                '<p>' + t('event_not_active') + '</p></div>';
            return;
        }

        var assignedPseudos = sfState.assignments.map(function (a) { return a.pseudo; });
        var unassigned = sfState.allMembers.filter(function (p) { return assignedPseudos.indexOf(p) === -1; });

        var s1p = sfState.assignments.filter(function (a) { return a.squad === 'squad1' && a.role === 'participant'; });
        var s1r = sfState.assignments.filter(function (a) { return a.squad === 'squad1' && a.role === 'reserve'; });
        var s2p = sfState.assignments.filter(function (a) { return a.squad === 'squad2' && a.role === 'participant'; });
        var s2r = sfState.assignments.filter(function (a) { return a.squad === 'squad2' && a.role === 'reserve'; });

        // Count categories in unassigned pool
        var counts = { regular: 0, rotation: 0, occasional: 0 };
        unassigned.forEach(function (p) { counts[categorise(p)]++; });

        var html = 
            '<div class="sf-sub-tabs">' +
                '<button class="sf-sub-tab' + (sfActiveTab === 'squads' ? ' active' : '') + '" data-tab="squads"><i class="ph ph-users"></i> ' + t('sf_tab_squads') + '</button>' +
                '<button class="sf-sub-tab' + (sfActiveTab === 'tracking' ? ' active' : '') + '" data-tab="tracking"><i class="ph ph-chart-bar"></i> ' + t('sf_tab_tracking') + '</button>' +
            '</div>' +
            '<div class="input-wrapper" style="margin-bottom: 1.5rem;">' +
                '<i class="ph ph-magnifying-glass"></i>' +
                '<input type="text" class="sf-search-input" placeholder="' + t('search_placeholder') + '">' +
            '</div>';

        // ── Panel: Squads ──────────────────────────────────────────────────
        html += '<div class="sf-sub-panel' + (sfActiveTab === 'squads' ? ' active' : '') + '">';
        html += '<div class="sf-layout">';

        // ── Unassigned column with history analysis ──────────────────────────
        html +=
            '<div class="sf-column sf-unassigned">' +
            '<div class="sf-col-header"><i class="ph-fill ph-users-three"></i> ' + t('sf_unassigned') +
                ' <span class="count-badge">' + unassigned.length + '</span></div>';

        // History legend summary
        html +=
            '<div class="sf-history-summary">' +
                '<span class="sf-cat-badge cat-regular">🟢 ' + counts.regular + ' ' + t('sf_cat_regular') + '</span>' +
                '<span class="sf-cat-badge cat-rotation">🔵 ' + counts.rotation + ' ' + t('sf_cat_rotation') + '</span>' +
                '<span class="sf-cat-badge cat-occasional">🟡 ' + counts.occasional + ' ' + t('sf_cat_occasional') + '</span>' +
            '</div>';

        // Filter tabs
        html +=
            '<div class="sf-filter-tabs">' +
                '<button class="sf-filter-btn' + (sfFilter === 'all'      ? ' active' : '') + '" data-filter="all">' + t('sf_filter_all') + '</button>' +
                '<button class="sf-filter-btn' + (sfFilter === 'regular'  ? ' active' : '') + '" data-filter="regular">🟢 ' + t('sf_filter_regular') + '</button>' +
                '<button class="sf-filter-btn' + (sfFilter === 'rotation' ? ' active' : '') + '" data-filter="rotation">🔵 ' + t('sf_filter_rotation') + '</button>' +
            '</div>';

        var sortedUnassigned = unassigned.slice().sort(function (a, b) {
            return a.localeCompare(b);
        });

        // Apply filter
        var filtered = sortedUnassigned.filter(function (p) {
            if (sfFilter === 'all') return true;
            return categorise(p) === sfFilter;
        });

        html += '<div class="sf-col-body">';
        if (filtered.length === 0) {
            html += '<div class="sf-empty">' + (unassigned.length === 0 ? t('sf_all_assigned') : t('sf_no_match_filter')) + '</div>';
        } else {
            filtered.forEach(function (pseudo) {
                var cat   = categorise(pseudo);
                var meta  = categoryMeta(cat);
                var h     = sfState.history[pseudo] || { assigned: 0, participated: 0 };
                var stats = h.assigned > 0
                    ? '<span class="sf-hist-stat">' + h.participated + '/' + h.assigned + ' ' + t('sf_hist_attended') + '</span>'
                    : '';

                html +=
                    '<div class="sf-member-row sf-member-' + cat + '">' +
                        '<div class="sf-member-info">' +
                            '<span class="sf-cat-dot ' + meta.cls + '" title="' + meta.label + '">' + meta.icon + '</span>' +
                            '<span class="sf-pseudo">' + escapeHTML(pseudo) + '</span>' +
                            stats +
                        '</div>' +
                        '<div class="sf-actions">' +
                            '<div class="sf-squad-btns">' +
                                '<span class="sf-squad-label">S1</span>' +
                                '<button class="sf-btn sf-btn-p" data-pseudo="' + escapeHTML(pseudo) + '" data-squad="squad1" data-role="participant" title="' + t('sf_participant') + '"><i class="ph ph-shield-check"></i></button>' +
                                '<button class="sf-btn sf-btn-r" data-pseudo="' + escapeHTML(pseudo) + '" data-squad="squad1" data-role="reserve" title="' + t('sf_reserve') + '"><i class="ph ph-clock-countdown"></i></button>' +
                            '</div>' +
                            '<div class="sf-squad-btns">' +
                                '<span class="sf-squad-label">S2</span>' +
                                '<button class="sf-btn sf-btn-p" data-pseudo="' + escapeHTML(pseudo) + '" data-squad="squad2" data-role="participant" title="' + t('sf_participant') + '"><i class="ph ph-shield-check"></i></button>' +
                                '<button class="sf-btn sf-btn-r" data-pseudo="' + escapeHTML(pseudo) + '" data-squad="squad2" data-role="reserve" title="' + t('sf_reserve') + '"><i class="ph ph-clock-countdown"></i></button>' +
                            '</div>' +
                        '</div>' +
                    '</div>';
            });
        }
        html += '</div></div>';

        // ── Squad columns ─────────────────────────────────────────────────────
        html += renderSquadColumn('squad1', s1p, s1r);
        html += renderSquadColumn('squad2', s2p, s2r);
        html += '</div>'; // sf-layout
        html += '</div>'; // sf-sub-panel (squads)

        // ── Panel: Tracking ────────────────────────────────────────────────
        html += '<div class="sf-sub-panel' + (sfActiveTab === 'tracking' ? ' active' : '') + '">';
        if (sfState.participants.length > 0) {
            html += renderTrackingTable();
        } else {
            html += '<div class="empty-state">' + t('sf_no_one') + '</div>';
        }
        html += '</div>'; // sf-sub-panel (tracking)

        area.innerHTML = html;
        attachSFListeners(area);
    }

    function renderSquadColumn(squad, participants, reserves) {
        var label = squad === 'squad1' ? t('sf_squad1') : t('sf_squad2');
        var pFull = participants.length >= PARTICIPANTS_MAX;
        var rFull = reserves.length >= RESERVES_MAX;

        var html = '<div class="sf-column sf-squad-col">' +
            '<div class="sf-col-header squad-header ' + squad + '">' +
                '<i class="ph-fill ph-shield-star"></i> ' + label +
            '</div>' +
            '<div class="sf-section-title">' + t('sf_participants') + ' <span class="sf-cap ' + (pFull ? 'full' : '') + '">' + participants.length + '/' + PARTICIPANTS_MAX + '</span></div>' +
            '<div class="sf-col-body">';

        if (participants.length === 0) {
            html += '<div class="sf-empty">' + t('sf_no_one') + '</div>';
        } else {
            participants.forEach(function (a) { html += renderAssignedRow(a.pseudo); });
        }
        html += '</div>';

        html += '<div class="sf-section-title">' + t('sf_reserves') + ' <span class="sf-cap ' + (rFull ? 'full' : '') + '">' + reserves.length + '/' + RESERVES_MAX + '</span></div>' +
            '<div class="sf-col-body">';

        if (reserves.length === 0) {
            html += '<div class="sf-empty">' + t('sf_no_one') + '</div>';
        } else {
            reserves.forEach(function (a) { html += renderAssignedRow(a.pseudo); });
        }
        html += '</div></div>';
        return html;
    }

    function renderAssignedRow(pseudo) {
        var cat  = categorise(pseudo);
        var meta = categoryMeta(cat);
        return '<div class="sf-assigned-row">' +
            '<span class="sf-cat-dot ' + meta.cls + '" title="' + meta.label + '">' + meta.icon + '</span>' +
            '<span class="sf-pseudo">' + escapeHTML(pseudo) + '</span>' +
            '<button class="sf-remove-btn" data-pseudo="' + escapeHTML(pseudo) + '" title="' + t('sf_remove') + '"><i class="ph ph-x"></i></button>' +
        '</div>';
    }

    function renderTrackingTable() {
        var participants = sfState.participants;
        var done = participants.reduce(function (s, p) { return s + (p.participated || 0); }, 0);

        var html =
            '<div class="sf-tracking">' +
                '<div class="sf-tracking-header"><i class="ph-fill ph-chart-bar"></i> ' + t('sf_tracking_title') + '</div>' +
                '<div class="event-stats">' +
                    '<span class="stat-chip"><i class="ph-fill ph-users"></i> ' + participants.length + ' ' + t('event_total') + '</span>' +
                    '<span class="stat-chip success"><i class="ph-fill ph-check-circle"></i> ' + done + ' ' + t('event_participated') + '</span>' +
                '</div>' +
                '<div class="participants-table-wrap"><table class="participants-table"><thead><tr>' +
                    '<th>' + t('col_member') + '</th>' +
                    '<th>' + t('sf_squad_col') + '</th>' +
                    '<th class="center">' + t('col_participated') + '</th>' +
                    '<th style="width: 40px;"></th>' +
                '</tr></thead><tbody>';

        participants.forEach(function (p) {
            var assignment = sfState.assignments.find(function (a) { return a.pseudo === p.pseudo; });
            var squadLabel = assignment
                ? (assignment.squad === 'squad1' ? t('sf_squad1') : t('sf_squad2')) + ' — ' + (assignment.role === 'participant' ? t('sf_participant') : t('sf_reserve'))
                : '—';
            html +=
                '<tr class="participant-row' + (p.participated ? ' participated' : '') + '">' +
                    '<td class="pseudo-cell"><i class="ph-fill ph-game-controller text-accent"></i> ' + escapeHTML(p.pseudo) + '</td>' +
                    '<td><span class="squad-chip ' + (assignment ? assignment.squad : '') + '">' + squadLabel + '</span></td>' +
                    '<td class="check-cell">' +
                        '<div class="counter-input">' +
                            '<button class="counter-btn minus sf-counter-btn" data-pseudo="' + escapeHTML(p.pseudo) + '"><i class="ph ph-minus"></i></button>' +
                            '<span class="counter-val">' + (p.participated || 0) + '</span>' +
                            '<button class="counter-btn plus sf-counter-btn" data-pseudo="' + escapeHTML(p.pseudo) + '"><i class="ph ph-plus"></i></button>' +
                        '</div>' +
                    '</td>' +
                    '<td><button class="delete-btn sf-delete-participant-btn" data-pseudo="' + escapeHTML(p.pseudo) + '" title="' + t('delete_title') + '"><i class="ph ph-trash"></i></button></td>' +
                '</tr>';
        });

        html += '</tbody></table></div></div>';
        return html;
    }

    // ── Event listeners ────────────────────────────────────────────────────────
    function attachSFListeners(area) {
        area.querySelectorAll('.sf-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                assign(btn.getAttribute('data-pseudo'), btn.getAttribute('data-squad'), btn.getAttribute('data-role'));
            });
        });
        area.querySelectorAll('.sf-remove-btn').forEach(function (btn) {
            btn.addEventListener('click', function () { unassign(btn.getAttribute('data-pseudo')); });
        });
        // SF Participation counter
        area.querySelectorAll('.sf-counter-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var isPlus = btn.classList.contains('plus');
                var valEl = btn.parentElement.querySelector('.counter-val');
                var currentVal = parseInt(valEl.textContent, 10) || 0;
                var newVal = isPlus ? currentVal + 1 : Math.max(0, currentVal - 1);
                if (currentVal === newVal) return;
                
                valEl.textContent = newVal;
                var row = btn.closest('.participant-row');
                if (row) row.classList.toggle('participated', newVal > 0);
                
                saveParticipation(btn.getAttribute('data-pseudo'), newVal)
                    .then(function () { loadShadowfront(); });
            });
        });
        // Filter tabs
        area.querySelectorAll('.sf-filter-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                sfFilter = btn.getAttribute('data-filter');
                renderShadowfront();
            });
        });

        // Delete participant from tracking
        area.querySelectorAll('.sf-delete-participant-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var pseudo = btn.getAttribute('data-pseudo');
                window.showConfirm(
                    t('delete_title'),
                    '<strong>' + escapeHTML(pseudo) + '</strong><br>' + t('confirm_remove_participant_body'),
                    async function () {
                        if (!db) return;
                        await db.from('event_participants')
                            .delete()
                            .eq('event_name', EVENT_NAME)
                            .eq('week_start', getWeekStart())
                            .eq('pseudo', pseudo);
                        loadShadowfront();
                    }
                );
            });
        });
        
        // Sub tabs
        area.querySelectorAll('.sf-sub-tab').forEach(function (btn) {
            btn.addEventListener('click', function () {
                sfActiveTab = btn.getAttribute('data-tab');
                renderShadowfront();
            });
        });
        
        // Search filter
        var searchInput = area.querySelector('.sf-search-input');
        if (searchInput) {
            searchInput.addEventListener('input', function(e) {
                var q = e.target.value.toLowerCase();
                // Filter unassigned rows
                area.querySelectorAll('.sf-member-row').forEach(function(row) {
                    var btn = row.querySelector('.sf-btn');
                    var pseudo = btn ? btn.getAttribute('data-pseudo') : '';
                    var uid = sfState.uidMap[pseudo] || '';
                    if ((pseudo.toLowerCase() + ' ' + uid.toLowerCase()).indexOf(q) !== -1) {
                        row.style.display = 'flex';
                    } else {
                        row.style.display = 'none';
                    }
                });
                // Filter assigned rows
                area.querySelectorAll('.sf-assigned-row').forEach(function(row) {
                    var btn = row.querySelector('.sf-remove-btn');
                    var pseudo = btn ? btn.getAttribute('data-pseudo') : '';
                    var uid = sfState.uidMap[pseudo] || '';
                    if ((pseudo.toLowerCase() + ' ' + uid.toLowerCase()).indexOf(q) !== -1) {
                        row.style.display = 'flex';
                    } else {
                        row.style.display = 'none';
                    }
                });
                // Filter participant rows
                area.querySelectorAll('.participant-row').forEach(function(row) {
                    var btn = row.querySelector('.sf-counter-btn');
                    var pseudo = btn ? btn.getAttribute('data-pseudo') : '';
                    var uid = sfState.uidMap[pseudo] || '';
                    if ((pseudo.toLowerCase() + ' ' + uid.toLowerCase()).indexOf(q) !== -1) {
                        row.style.display = '';
                    } else {
                        row.style.display = 'none';
                    }
                });
            });
        }
    }

    // ── Toast ──────────────────────────────────────────────────────────────────
    function showToastSF(message, type) {
        var tc = document.getElementById('toast-container');
        if (!tc) return;
        var icons = { success: 'ph-check-circle', error: 'ph-warning-circle', info: 'ph-info' };
        var toast = document.createElement('div');
        toast.className = 'toast ' + (type || 'info');
        toast.innerHTML = '<i class="ph-fill ' + (icons[type] || 'ph-info') + '"></i> <span>' + message + '</span>';
        tc.appendChild(toast);
        setTimeout(function () {
            toast.classList.add('fade-out');
            setTimeout(function () { toast.remove(); }, 300);
        }, 3500);
    }

    // ── Wire START / END buttons ───────────────────────────────────────────────
    var sfStartBtn = document.querySelector('.event-start-btn[data-event="Shadowfront"]');
    if (sfStartBtn) {
        sfStartBtn.addEventListener('click', function () {
            window.RAD_SHADOWFRONT.setShadowfrontActive(true);
        });
    }
    var sfEndBtn = document.querySelector('.event-end-btn[data-event="Shadowfront"]');
    if (sfEndBtn) {
        sfEndBtn.addEventListener('click', function () {
            window.RAD_SHADOWFRONT.setShadowfrontActive(false);
        });
    }

})();
