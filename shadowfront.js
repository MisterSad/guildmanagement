/**
 * shadowfront.js — Shadowfront event: squad assignment + participation tracking
 * Chaque START crée une nouvelle session : nouveaux squads, nouveau suivi.
 * L'historique (catégorisation) consulte toutes les sessions passées.
 */
(function () {

    var db  = window.RAD ? window.RAD.db : null;
    var t   = window.RAD ? window.RAD.t  : function (k) { return k; };
    var esc = window.RAD ? window.RAD.escapeHTML : function (s) { return s; };

    var EVENT_NAME = 'Shadowfront';
    var PARTICIPANTS_MAX = 20;
    var RESERVES_MAX     = 10;

    // ── State ──────────────────────────────────────────────────────────────────
    var sfState = {
        isActive:     false,
        sessionId:    null,
        allMembers:   [],
        assignments:  [],
        participants: [],
        history:      {},   // pseudo → { assigned, participated }
        uidMap:       {}
    };

    var sfFilter    = 'all';      // 'all' | 'regular' | 'rotation'
    var sfActiveTab = 'squads';   // 'squads' | 'tracking'

    // ── Public API ─────────────────────────────────────────────────────────────
    window.RAD_SHADOWFRONT = { load: loadShadowfront };

    // ── Load ───────────────────────────────────────────────────────────────────
    async function loadShadowfront() {
        if (!db) return;
        try {
            var [statusRes, membersRes, histSquads, histParts] = await Promise.all([
                db.from('event_status').select('is_active, session_id').eq('event_name', EVENT_NAME).maybeSingle(),
                db.from('guild_members').select('pseudo, uid').order('pseudo', { ascending: true }),
                db.from('shadowfront_squads').select('pseudo, session_id'),
                db.from('event_participants').select('pseudo, participated, session_id').eq('event_name', EVENT_NAME)
            ]);

            sfState.isActive  = statusRes.data ? statusRes.data.is_active : false;
            sfState.sessionId = statusRes.data ? statusRes.data.session_id : null;
            sfState.allMembers = (membersRes.data || []).map(function (m) { return m.pseudo; });
            sfState.uidMap = {};
            (membersRes.data || []).forEach(function (m) { sfState.uidMap[m.pseudo] = m.uid; });

            // Histoire : exclure la session courante
            var hist = {};
            (histSquads.data || []).forEach(function (r) {
                if (sfState.sessionId && r.session_id === sfState.sessionId) return;
                if (!hist[r.pseudo]) hist[r.pseudo] = { assigned: 0, participated: 0 };
                hist[r.pseudo].assigned++;
            });
            (histParts.data || []).forEach(function (r) {
                if (sfState.sessionId && r.session_id === sfState.sessionId) return;
                if (!hist[r.pseudo]) hist[r.pseudo] = { assigned: 0, participated: 0 };
                if (r.participated > 0) hist[r.pseudo].participated += r.participated;
            });
            sfState.history = hist;

            if (sfState.isActive && sfState.sessionId) {
                var [assignRes, partRes] = await Promise.all([
                    db.from('shadowfront_squads').select('*')
                        .eq('session_id', sfState.sessionId).order('pseudo', { ascending: true }),
                    db.from('event_participants').select('*')
                        .eq('event_name', EVENT_NAME).eq('session_id', sfState.sessionId)
                        .order('pseudo', { ascending: true })
                ]);
                sfState.assignments  = assignRes.data || [];
                sfState.participants = partRes.data || [];
            } else {
                sfState.assignments  = [];
                sfState.participants = [];
            }

            renderStatus();
            renderShadowfront();
        } catch (err) { console.error('loadShadowfront', err); }
    }

    // ── Set Active / Inactive ──────────────────────────────────────────────────
    async function setShadowfrontActive(newState) {
        if (!db) return;
        if (newState) {
            // Nouvelle session
            var sessionId = window.RAD.newSessionId();
            await db.from('event_status').upsert(
                {
                    event_name: EVENT_NAME,
                    is_active:  true,
                    session_id: sessionId,
                    updated_at: new Date().toISOString()
                },
                { onConflict: 'event_name' }
            );
            sfState.isActive  = true;
            sfState.sessionId = sessionId;
            window.RAD.showToast(t('event_session_started_sf'), 'success');
        } else {
            await db.from('event_status').upsert(
                {
                    event_name: EVENT_NAME,
                    is_active:  false,
                    session_id: sfState.sessionId,
                    updated_at: new Date().toISOString()
                },
                { onConflict: 'event_name' }
            );
            sfState.isActive = false;
            window.RAD.showToast(t('event_session_ended'), 'success');
        }
        await loadShadowfront();
    }

    // ── Catégorisation ─────────────────────────────────────────────────────────
    function categorise(pseudo) {
        var h = sfState.history[pseudo];
        if (!h || h.assigned === 0) return 'rotation';
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

    // ── Assign / Unassign ──────────────────────────────────────────────────────
    async function assign(pseudo, squad, role) {
        if (!db || !sfState.sessionId) return;
        var existing = sfState.assignments.filter(function (a) { return a.squad === squad && a.role === role; });
        var max = role === 'participant' ? PARTICIPANTS_MAX : RESERVES_MAX;
        if (existing.length >= max) { window.RAD.showToast(t('sf_squad_full'), 'error'); return; }

        // Supprimer la précédente affectation s'il y en a une (cette session)
        await db.from('shadowfront_squads').delete()
            .eq('session_id', sfState.sessionId).eq('pseudo', pseudo);

        await db.from('shadowfront_squads').insert({
            week_start: window.RAD.getWeekStart(),
            session_id: sfState.sessionId,
            pseudo: pseudo,
            squad: squad,
            role: role
        });

        await syncParticipantRows();
        await loadShadowfront();
    }

    async function unassign(pseudo) {
        if (!db || !sfState.sessionId) return;
        await db.from('shadowfront_squads').delete()
            .eq('session_id', sfState.sessionId).eq('pseudo', pseudo);
        await loadShadowfront();
    }

    // ── Sync participant rows ──────────────────────────────────────────────────
    async function syncParticipantRows() {
        if (!db || !sfState.sessionId) return;
        var existingRes = await db.from('event_participants').select('pseudo')
            .eq('event_name', EVENT_NAME).eq('session_id', sfState.sessionId);
        var existing = new Set((existingRes.data || []).map(function (r) { return r.pseudo; }));

        var assignRes = await db.from('shadowfront_squads').select('pseudo')
            .eq('session_id', sfState.sessionId);
        var assigned = (assignRes.data || []).map(function (a) { return a.pseudo; });

        var toInsert = assigned
            .filter(function (p) { return !existing.has(p); })
            .map(function (p) {
                return {
                    event_name: EVENT_NAME,
                    week_start: window.RAD.getWeekStart(),
                    session_id: sfState.sessionId,
                    pseudo: p,
                    participated: 0
                };
            });
        if (toInsert.length > 0) await db.from('event_participants').insert(toInsert);
    }

    async function saveParticipation(pseudo, value) {
        if (!db || !sfState.sessionId) return;
        await db.from('event_participants').update({ participated: value })
            .eq('event_name', EVENT_NAME).eq('session_id', sfState.sessionId).eq('pseudo', pseudo);
    }

    // ── Render status badge + START/END buttons ────────────────────────────────
    function renderStatus() {
        var panel = document.getElementById('event-shadowfront');
        if (!panel) return;
        var badge    = panel.querySelector('.event-status-badge');
        var startBtn = panel.querySelector('.event-start-btn');
        var endBtn   = panel.querySelector('.event-end-btn');
        if (badge) {
            badge.className = 'event-status-badge gm-chip' + (sfState.isActive ? ' gm-chip-success active' : '');
            badge.innerHTML = '<span class="gm-dot"></span> ' +
                (sfState.isActive ? t('event_active') : t('event_inactive'));
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
                '<div class="gm-empty">' +
                    '<i class="ph-duotone ph-rocket-launch gm-icon"></i>' +
                    '<div class="gm-empty-title">' + t('event_not_active') + '</div>' +
                    '<div class="gm-empty-hint">' + t('event_not_active_hint') + '</div>' +
                '</div>';
            return;
        }

        var assignedPseudos = sfState.assignments.map(function (a) { return a.pseudo; });
        var unassigned = sfState.allMembers.filter(function (p) { return assignedPseudos.indexOf(p) === -1; });

        var s1p = sfState.assignments.filter(function (a) { return a.squad === 'squad1' && a.role === 'participant'; });
        var s1r = sfState.assignments.filter(function (a) { return a.squad === 'squad1' && a.role === 'reserve'; });
        var s2p = sfState.assignments.filter(function (a) { return a.squad === 'squad2' && a.role === 'participant'; });
        var s2r = sfState.assignments.filter(function (a) { return a.squad === 'squad2' && a.role === 'reserve'; });

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

        html +=
            '<div class="sf-column sf-unassigned">' +
            '<div class="sf-col-header"><i class="ph-fill ph-users-three"></i> ' + t('sf_unassigned') +
                ' <span class="count-badge">' + unassigned.length + '</span></div>';

        html +=
            '<div class="sf-history-summary">' +
                '<span class="sf-cat-badge cat-regular">🟢 ' + counts.regular + ' ' + t('sf_cat_regular') + '</span>' +
                '<span class="sf-cat-badge cat-rotation">🔵 ' + counts.rotation + ' ' + t('sf_cat_rotation') + '</span>' +
                '<span class="sf-cat-badge cat-occasional">🟡 ' + counts.occasional + ' ' + t('sf_cat_occasional') + '</span>' +
            '</div>';

        html +=
            '<div class="sf-filter-tabs">' +
                '<button class="sf-filter-btn' + (sfFilter === 'all'      ? ' active' : '') + '" data-filter="all">' + t('sf_filter_all') + '</button>' +
                '<button class="sf-filter-btn' + (sfFilter === 'regular'  ? ' active' : '') + '" data-filter="regular">🟢 ' + t('sf_filter_regular') + '</button>' +
                '<button class="sf-filter-btn' + (sfFilter === 'rotation' ? ' active' : '') + '" data-filter="rotation">🔵 ' + t('sf_filter_rotation') + '</button>' +
            '</div>';

        var sortedUnassigned = unassigned.slice().sort(function (a, b) { return a.localeCompare(b); });
        var filtered = sortedUnassigned.filter(function (p) {
            return sfFilter === 'all' ? true : categorise(p) === sfFilter;
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
                            '<span class="sf-pseudo">' + esc(pseudo) + '</span>' +
                            stats +
                        '</div>' +
                        '<div class="sf-actions">' +
                            '<div class="sf-squad-btns">' +
                                '<span class="sf-squad-label">S1</span>' +
                                '<button class="sf-btn sf-btn-p" data-pseudo="' + esc(pseudo) + '" data-squad="squad1" data-role="participant" title="' + t('sf_participant') + '"><i class="ph ph-shield-check"></i></button>' +
                                '<button class="sf-btn sf-btn-r" data-pseudo="' + esc(pseudo) + '" data-squad="squad1" data-role="reserve" title="' + t('sf_reserve') + '"><i class="ph ph-clock-countdown"></i></button>' +
                            '</div>' +
                            '<div class="sf-squad-btns">' +
                                '<span class="sf-squad-label">S2</span>' +
                                '<button class="sf-btn sf-btn-p" data-pseudo="' + esc(pseudo) + '" data-squad="squad2" data-role="participant" title="' + t('sf_participant') + '"><i class="ph ph-shield-check"></i></button>' +
                                '<button class="sf-btn sf-btn-r" data-pseudo="' + esc(pseudo) + '" data-squad="squad2" data-role="reserve" title="' + t('sf_reserve') + '"><i class="ph ph-clock-countdown"></i></button>' +
                            '</div>' +
                        '</div>' +
                    '</div>';
            });
        }
        html += '</div></div>';

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
        html += '</div>';

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
            '<span class="sf-pseudo">' + esc(pseudo) + '</span>' +
            '<button class="sf-remove-btn" data-pseudo="' + esc(pseudo) + '" title="' + t('sf_remove') + '"><i class="ph ph-x"></i></button>' +
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
            var isChecked = p.participated > 0;
            html +=
                '<tr class="participant-row' + (isChecked ? ' participated' : '') + '">' +
                    '<td class="pseudo-cell"><i class="ph-fill ph-game-controller text-accent"></i> ' + esc(p.pseudo) + '</td>' +
                    '<td><span class="squad-chip ' + (assignment ? assignment.squad : '') + '">' + squadLabel + '</span></td>' +
                    '<td class="check-cell">' +
                        '<label class="participation-check">' +
                            '<input type="checkbox" class="participation-checkbox sf-participation-checkbox" data-pseudo="' + esc(p.pseudo) + '"' + (isChecked ? ' checked' : '') + '>' +
                            '<span class="check-mark"><i class="ph ph-check"></i></span>' +
                        '</label>' +
                    '</td>' +
                    '<td><button class="delete-btn sf-delete-participant-btn" data-pseudo="' + esc(p.pseudo) + '" title="' + t('delete_title') + '"><i class="ph ph-trash"></i></button></td>' +
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
        area.querySelectorAll('.sf-participation-checkbox').forEach(function (cb) {
            cb.addEventListener('change', function () {
                var next = cb.checked ? 1 : 0;
                var row  = cb.closest('.participant-row');
                if (row) row.classList.toggle('participated', cb.checked);

                var pseudo = cb.getAttribute('data-pseudo');
                saveParticipation(pseudo, next).then(function () {
                    var pp = sfState.participants.find(function (p) { return p.pseudo === pseudo; });
                    if (pp) pp.participated = next;
                });
            });
        });
        area.querySelectorAll('.sf-filter-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                sfFilter = btn.getAttribute('data-filter');
                renderShadowfront();
            });
        });

        area.querySelectorAll('.sf-delete-participant-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var pseudo = btn.getAttribute('data-pseudo');
                window.showConfirm(
                    t('delete_title'),
                    '<strong>' + esc(pseudo) + '</strong><br>' + t('confirm_remove_participant_body'),
                    async function () {
                        if (!db || !sfState.sessionId) return;
                        await db.from('event_participants').delete()
                            .eq('event_name', EVENT_NAME)
                            .eq('session_id', sfState.sessionId)
                            .eq('pseudo', pseudo);
                        loadShadowfront();
                    }
                );
            });
        });

        area.querySelectorAll('.sf-sub-tab').forEach(function (btn) {
            btn.addEventListener('click', function () {
                sfActiveTab = btn.getAttribute('data-tab');
                renderShadowfront();
            });
        });

        var searchInput = area.querySelector('.sf-search-input');
        if (searchInput) {
            searchInput.addEventListener('input', function (e) {
                var q = e.target.value.toLowerCase();
                area.querySelectorAll('.sf-member-row, .sf-assigned-row').forEach(function (row) {
                    var btn = row.querySelector('.sf-btn, .sf-remove-btn');
                    var pseudo = btn ? btn.getAttribute('data-pseudo') : '';
                    var uid = sfState.uidMap[pseudo] || '';
                    var match = (pseudo.toLowerCase() + ' ' + uid.toLowerCase()).indexOf(q) !== -1;
                    row.style.display = match ? 'flex' : 'none';
                });
                area.querySelectorAll('.participant-row').forEach(function (row) {
                    var cb = row.querySelector('.sf-participation-checkbox');
                    var pseudo = cb ? cb.getAttribute('data-pseudo') : '';
                    var uid = sfState.uidMap[pseudo] || '';
                    var match = (pseudo.toLowerCase() + ' ' + uid.toLowerCase()).indexOf(q) !== -1;
                    row.style.display = match ? '' : 'none';
                });
            });
        }
    }

    // ── Wire START / END buttons ───────────────────────────────────────────────
    var sfStartBtn = document.querySelector('.event-start-btn[data-event="Shadowfront"]');
    if (sfStartBtn) sfStartBtn.addEventListener('click', function () { setShadowfrontActive(true); });
    var sfEndBtn = document.querySelector('.event-end-btn[data-event="Shadowfront"]');
    if (sfEndBtn) sfEndBtn.addEventListener('click', function () { setShadowfrontActive(false); });

})();
