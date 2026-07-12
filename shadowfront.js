/**
 * shadowfront.js — Shadowfront: Squad 1 & Squad 2 launched independently.
 *
 * Each squad is its own event_status row ("Shadowfront Squad 1/2") with its
 * own active state, session and UTC start_at — so they can start at
 * different times and surface as two distinct agenda/notification entries.
 * Participation/scoring stays under event_name 'Shadowfront' (unchanged),
 * partitioned per squad session. Players assigned to Squad 1 (participant
 * OR reserve) are excluded from the Squad 2 pool, and vice-versa.
 */
(function () {

    var db  = window.RAD ? window.RAD.db : null;
    var t   = window.RAD ? window.RAD.t  : function (k) { return k; };
    var esc = window.RAD ? window.RAD.escapeHTML : function (s) { return s; };

    var EVENT_NAME = 'Shadowfront'; // event_participants identity (scoring/history)
    var SQUAD_EVENT = { squad1: 'Shadowfront Squad 1', squad2: 'Shadowfront Squad 2' };
    var PARTICIPANTS_MAX = 20;
    var RESERVES_MAX     = 10;

    // ── State ──────────────────────────────────────────────────────────────────
    var sfState = {
        squads: {
            squad1: { active: false, sessionId: null, startAt: null },
            squad2: { active: false, sessionId: null, startAt: null }
        },
        allMembers:   [],
        assignments:  [],
        participants: [],
        history:      {},   // pseudo → { assigned, participated }
        uidMap:       {}
    };

    var sfFilter      = 'all';      // 'all' | 'excellent' | 'good' | 'average' | 'poor' | 'none'
    var sfActiveTab   = 'squads';   // 'squads' | 'tracking'
    var sfActiveSquad = 'squad1';   // 'squad1' | 'squad2'

    // ── Public API ─────────────────────────────────────────────────────────────
    window.RAD_SHADOWFRONT = { load: loadShadowfront };

    function squadLabel(squad) { return squad === 'squad1' ? t('sf_squad1') : t('sf_squad2'); }
    function activeSquadKeys() {
        return ['squad1', 'squad2'].filter(function (k) { return sfState.squads[k].active; });
    }
    function anySquadActive() { return activeSquadKeys().length > 0; }
    function currentSessionIds() {
        return ['squad1', 'squad2']
            .map(function (k) { return sfState.squads[k].sessionId; })
            .filter(Boolean);
    }

    // ── Load ───────────────────────────────────────────────────────────────────
    async function loadShadowfront() {
        if (!db) return;
        try {
            var [statusRes, membersRes, histSquads, histParts] = await Promise.all([
                db.from('event_status').select('event_name, is_active, session_id, start_at')
                    .in('event_name', [SQUAD_EVENT.squad1, SQUAD_EVENT.squad2]),
                db.from('guild_members').select('pseudo, uid').order('pseudo', { ascending: true }),
                db.from('shadowfront_squads').select('pseudo, session_id').limit(100000),
                db.from('event_participants').select('pseudo, participated, session_id').eq('event_name', EVENT_NAME).limit(100000)
            ]);

            ['squad1', 'squad2'].forEach(function (k) {
                var row = (statusRes.data || []).find(function (r) { return r.event_name === SQUAD_EVENT[k]; });
                sfState.squads[k] = {
                    active:    row ? !!row.is_active : false,
                    sessionId: row ? row.session_id : null,
                    startAt:   row ? row.start_at : null
                };
            });

            sfState.allMembers = (membersRes.data || []).map(function (m) { return m.pseudo; });
            sfState.uidMap = {};
            (membersRes.data || []).forEach(function (m) { sfState.uidMap[m.pseudo] = m.uid; });

            var sids = currentSessionIds();

            // Histoire : exclure les sessions de l'occurrence courante
            var hist = {};
            (histSquads.data || []).forEach(function (r) {
                if (sids.indexOf(r.session_id) !== -1) return;
                if (!hist[r.pseudo]) hist[r.pseudo] = { assigned: 0, participated: 0 };
                hist[r.pseudo].assigned++;
            });
            (histParts.data || []).forEach(function (r) {
                if (sids.indexOf(r.session_id) !== -1) return;
                if (!hist[r.pseudo]) hist[r.pseudo] = { assigned: 0, participated: 0 };
                if (r.participated > 0) hist[r.pseudo].participated += r.participated;
            });
            sfState.history = hist;

            if (sids.length) {
                var [assignRes, partRes] = await Promise.all([
                    db.from('shadowfront_squads').select('*')
                        .in('session_id', sids).order('pseudo', { ascending: true }),
                    db.from('event_participants').select('*')
                        .eq('event_name', EVENT_NAME).in('session_id', sids)
                        .order('pseudo', { ascending: true })
                ]);
                sfState.assignments  = assignRes.data || [];
                sfState.participants = partRes.data || [];
            } else {
                sfState.assignments  = [];
                sfState.participants = [];
            }

            renderShadowfront();
        } catch (err) { console.error('loadShadowfront', err); }
    }

    // ── Start / End a squad ────────────────────────────────────────────────────
    async function startSquad(squad, startAt) {
        if (!db) return;
        var sessionId = window.RAD.newSessionId();
        try {
            var res = await db.from('event_status').upsert(
                {
                    event_name: SQUAD_EVENT[squad],
                    is_active:  true,
                    session_id: sessionId,
                    start_at:   startAt || null,
                    updated_at: new Date().toISOString()
                },
                { onConflict: 'guild,event_name' }
            );
            if (res.error) throw res.error;
            window.RAD.showToast(squadLabel(squad) + ' — ' + t('sf_squad_started'), 'success');

            if (window.RAD.notifyDiscordEvent) {
                window.RAD.notifyDiscordEvent(SQUAD_EVENT[squad], startAt || sessionId, 'start');
            }
        } catch (err) {
            console.error('startSquad', err);
            window.RAD.showToast(t('toast_err_generic') + ' ' + err.message, 'error');
        }
        await loadShadowfront();
    }

    async function endSquads(squads) {
        if (!db) return;
        for (var i = 0; i < squads.length; i++) {
            var squad = squads[i];
            try {
                await db.from('event_status').upsert(
                    {
                        event_name: SQUAD_EVENT[squad],
                        is_active:  false,
                        session_id: sfState.squads[squad].sessionId, // gardé pour l'historique
                        start_at:   null,                             // retire de l'agenda / rappels
                        updated_at: new Date().toISOString()
                    },
                    { onConflict: 'guild,event_name' }
                );
            } catch (err) { console.error('endSquad', err); }
        }
        window.RAD.showToast(t('sf_squad_ended'), 'success');
        await loadShadowfront();
    }

    async function editSquadSchedule(squad) {
        if (!db) return;
        var sq = sfState.squads[squad];
        if (!sq || !sq.active || !sq.sessionId) return;

        try {
            var res = await db.from('event_status').select('start_at')
                .eq('event_name', SQUAD_EVENT[squad]).single();
            if (res.error) throw res.error;

            var currentStartAt = res.data ? res.data.start_at : null;

            window.RAD.pickEventStart({
                eventLabel: squadLabel(squad) + ' — ' + t('edit_title'),
                defaultVal: currentStartAt
            }, async function (startAt) {
                if (!startAt) return;

                try {
                    var updateRes = await db.from('event_status').update({
                        start_at: startAt,
                        updated_at: new Date().toISOString()
                    }).eq('event_name', SQUAD_EVENT[squad]);
                    if (updateRes.error) throw updateRes.error;

                    var newWeek = window.RAD.getWeekStart(startAt);
                    await db.from('shadowfront_squads').update({
                        week_start: newWeek
                    }).eq('session_id', sq.sessionId);

                    await db.from('event_participants').update({
                        week_start: newWeek
                    }).eq('event_name', EVENT_NAME)
                      .eq('session_id', sq.sessionId);

                    window.RAD.showToast(t('toast_member_updated'), 'success');

                    if (window.RAD.notifyDiscordEvent) {
                        window.RAD.notifyDiscordEvent(SQUAD_EVENT[squad], startAt, 'edit');
                    }

                    await loadShadowfront();
                } catch (err) {
                    console.error('editSquadSchedule update', err);
                    window.RAD.showToast(t('toast_err_generic') + ' ' + err.message, 'error');
                }
            });
        } catch (err) {
            console.error('editSquadSchedule fetch', err);
            window.RAD.showToast(t('toast_err_generic') + ' ' + err.message, 'error');
        }
    }

    function deleteSquadSession(squad) {
        if (!db) return;
        var sq = sfState.squads[squad];
        if (!sq || !sq.sessionId) return;

        window.showConfirm(
            t('confirm_delete_session_title'),
            '<strong>' + esc(squadLabel(squad)) + '</strong><br>' + t('confirm_delete_session_body'),
            async function () {
                try {
                    // 1. Delete matching participants in event_participants
                    var delPartRes = await db.from('event_participants')
                        .delete()
                        .eq('event_name', EVENT_NAME)
                        .eq('session_id', sq.sessionId);
                    if (delPartRes.error) throw delPartRes.error;

                    // 2. Delete matching assignments in shadowfront_squads
                    var delSquadsRes = await db.from('shadowfront_squads')
                        .delete()
                        .eq('session_id', sq.sessionId);
                    if (delSquadsRes.error) throw delSquadsRes.error;

                    // 3. Delete from event_status
                    var delStatusRes = await db.from('event_status')
                        .delete()
                        .eq('event_name', SQUAD_EVENT[squad]);
                    if (delStatusRes.error) throw delStatusRes.error;

                    window.RAD.showToast(t('toast_account_deleted'), 'success');
                    await loadShadowfront();
                } catch (err) {
                    console.error('deleteSquadSession', err);
                    window.RAD.showToast(t('toast_err_generic') + ' ' + err.message, 'error');
                }
            }
        );
    }

    // ── Catégorisation ─────────────────────────────────────────────────────────
    function categorise(pseudo) {
        var h = sfState.history[pseudo];
        if (!h || h.assigned === 0) return 'none';
        var rate = h.participated / h.assigned;
        if (rate > 0.8) return 'excellent';
        if (rate >= 0.5) return 'good';
        if (rate >= 0.2) return 'average';
        return 'poor';
    }

    function categoryMeta(cat) {
        if (cat === 'excellent')  return { label: t('sf_filter_excellent'), cls: 'excellent', icon: '🟢' };
        if (cat === 'good')       return { label: t('sf_filter_good'),      cls: 'good',      icon: '🔵' };
        if (cat === 'average')    return { label: t('sf_filter_average'),   cls: 'average',   icon: '🟡' };
        if (cat === 'poor')       return { label: t('sf_filter_poor'),      cls: 'poor',      icon: '🔴' };
        return                    { label: t('sf_filter_none'),      cls: 'none',      icon: '⚫' };
    }

    // ── Assign / Unassign ──────────────────────────────────────────────────────
    async function assign(pseudo, squad, role) {
        if (!db) return;
        var sq = sfState.squads[squad];
        if (!sq || !sq.active || !sq.sessionId) {
            window.RAD.showToast(t('sf_squad_inactive_hint'), 'error');
            return;
        }
        var existing = sfState.assignments.filter(function (a) { return a.squad === squad && a.role === role; });
        var max = role === 'participant' ? PARTICIPANTS_MAX : RESERVES_MAX;
        if (existing.length >= max) { window.RAD.showToast(t('sf_squad_full'), 'error'); return; }

        // Supprimer une précédente affectation dans la session de ce squad
        await db.from('shadowfront_squads').delete()
            .eq('session_id', sq.sessionId).eq('pseudo', pseudo);

        await db.from('shadowfront_squads').insert({
            week_start: window.RAD.getWeekStart(sq.startAt || new Date(sq.sessionId)),
            session_id: sq.sessionId,
            pseudo: pseudo,
            squad: squad,
            role: role
        });

        await syncParticipantRows(sq.sessionId);
        await loadShadowfront();
    }

    async function unassign(pseudo) {
        if (!db) return;
        var a = sfState.assignments.find(function (x) { return x.pseudo === pseudo; });
        if (!a) return;
        await db.from('shadowfront_squads').delete()
            .eq('session_id', a.session_id).eq('pseudo', pseudo);
        await loadShadowfront();
    }

    async function toggleCommander(pseudo) {
        if (!db) return;
        var assignment = sfState.assignments.find(function (a) { return a.pseudo === pseudo; });
        if (!assignment) return;

        var isNewCommander = !assignment.is_commander;
        var sq = sfState.squads[assignment.squad];
        if (!sq || !sq.sessionId) return;

        if (isNewCommander) {
            var currentCommanders = sfState.assignments.filter(function (a) {
                return a.squad === assignment.squad && a.is_commander;
            });
            if (currentCommanders.length >= 3) {
                window.RAD.showToast('You can only have up to 3 commanders per squad!', 'error');
                return;
            }
        }

        await db.from('shadowfront_squads').update({ is_commander: isNewCommander })
            .eq('session_id', sq.sessionId).eq('pseudo', pseudo);

        await loadShadowfront();
    }

    // ── Sync participant rows ──────────────────────────────────────────────────
    async function syncParticipantRows(sessionId) {
        if (!db || !sessionId) return;
        var existingRes = await db.from('event_participants').select('pseudo')
            .eq('event_name', EVENT_NAME).eq('session_id', sessionId);
        var existing = new Set((existingRes.data || []).map(function (r) { return r.pseudo; }));

        var assignRes = await db.from('shadowfront_squads').select('pseudo')
            .eq('session_id', sessionId);
        var assigned = (assignRes.data || []).map(function (a) { return a.pseudo; });

        var sq = Object.values(sfState.squads).find(function (s) { return s.sessionId === sessionId; });
        var startAt = sq ? sq.startAt : null;
        var week = window.RAD.getWeekStart(startAt || new Date(sessionId));

        var toInsert = assigned
            .filter(function (p) { return !existing.has(p); })
            .map(function (p) {
                return {
                    event_name: EVENT_NAME,
                    week_start: week,
                    session_id: sessionId,
                    pseudo: p,
                    participated: 0
                };
            });
        if (toInsert.length > 0) await db.from('event_participants').insert(toInsert);
    }

    async function saveParticipation(pseudo, value) {
        if (!db) return;
        var p = sfState.participants.find(function (x) { return x.pseudo === pseudo; });
        if (!p) return;
        await db.from('event_participants').update({ participated: value })
            .eq('event_name', EVENT_NAME).eq('session_id', p.session_id).eq('pseudo', pseudo);
    }

    async function saveLate(pseudo, value) {
        if (!db) return;
        var p = sfState.participants.find(function (x) { return x.pseudo === pseudo; });
        if (!p) return;
        await db.from('event_participants').update({ late: value })
            .eq('event_name', EVENT_NAME).eq('session_id', p.session_id).eq('pseudo', pseudo);
    }

    async function saveExcused(pseudo, value) {
        if (!db) return;
        var p = sfState.participants.find(function (x) { return x.pseudo === pseudo; });
        if (!p) return;
        await db.from('event_participants').update({ excused: value })
            .eq('event_name', EVENT_NAME).eq('session_id', p.session_id).eq('pseudo', pseudo);
    }


    // ── Main render ────────────────────────────────────────────────────────────
    function renderShadowfront() {
        var area = document.querySelector('#event-shadowfront .event-participants-area');
        if (!area) return;

        var sq = sfState.squads[sfActiveSquad];
        var sqLabel = squadLabel(sfActiveSquad);
        var isActive = sq.active;
        
        var statusBadgeClass = isActive ? 'gm-chip-success active' : 'gm-chip-muted';
        var statusText = isActive ? t('event_active') : t('event_inactive');
        var dotColor = isActive ? 'var(--success)' : 'var(--fg-dim)';
        var subText = sq.startAt 
            ? window.RAD.formatDateTimeUTC(sq.startAt)
            : (isActive ? t('event_active') : t('sf_squad_inactive_hint'));

        // 1. Selector for Squad 1 / Squad 2 at the top
        var html =
            '<div class="sf-main-tabs">' +
                '<button class="sf-main-tab squad1' + (sfActiveSquad === 'squad1' ? ' active' : '') + '" data-squad="squad1"><i class="ph ph-shield-star"></i> ' + t('sf_squad1') + '</button>' +
                '<button class="sf-main-tab squad2' + (sfActiveSquad === 'squad2' ? ' active' : '') + '" data-squad="squad2"><i class="ph ph-shield-star"></i> ' + t('sf_squad2') + '</button>' +
            '</div>';

        // 2. Dynamic Banner for currently selected squad
        html +=
            '<div class="gm-event-banner" style="display: flex; margin-bottom: 1.5rem; background: var(--card-bg); border: 1px solid var(--card-border); border-radius: var(--radius-lg); padding: 1rem 1.5rem; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 1rem;">' +
                '<div class="gm-event-meta" style="display: flex; align-items: center; gap: 1rem; flex: 1; min-width: 250px;">' +
                    '<div class="gm-event-icon" style="width: 48px; height: 48px; border-radius: 50%; background: ' + (isActive ? 'var(--primary-soft)' : 'rgba(255,255,255,0.05)') + '; color: ' + (isActive ? 'var(--primary)' : 'var(--text-muted)') + '; display: flex; align-items: center; justify-content: center; font-size: 1.5rem;"><i class="ph ph-ghost"></i></div>' +
                    '<div class="gm-grow" style="display: flex; flex-direction: column; gap: 0.25rem;">' +
                        '<div class="gm-event-name" style="font-size: 1.2rem; font-weight: 700; font-family: var(--font-family-title);">' + esc(sqLabel) + '</div>' +
                        '<div class="gm-event-status-line" style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">' +
                            '<span class="event-status-badge gm-chip ' + statusBadgeClass + '" style="display: inline-flex; align-items: center; gap: 0.35rem; font-size: 0.78rem;"><span class="gm-dot" style="background: ' + dotColor + '; width: 8px; height: 8px; border-radius: 50%;"></span> ' + statusText + '</span>' +
                            '<span class="gm-dim" style="font-size: 0.8rem; color: var(--text-muted);">' + esc(subText) + '</span>' +
                        '</div>' +
                    '</div>' +
                '</div>' +
                '<div class="gm-event-actions" style="display: flex; gap: 0.5rem;">' +
                    (isActive ? 
                        '<button class="gm-btn gm-btn-danger event-end-btn sf-squad-end-btn" data-squad="' + sfActiveSquad + '" style="margin-right: 0.25rem;"><i class="ph ph-stop-circle"></i> <span>' + t('event_end') + '</span></button>' +
                        '<button class="gm-btn sf-squad-edit-btn" style="background: rgba(99,102,241,0.15); border: 1px solid rgba(99,102,241,0.3); color: #a5b4fc; margin-right: 0.25rem;" data-squad="' + sfActiveSquad + '" title="' + t('edit_title') + '"><i class="ph ph-calendar"></i> <span>' + t('edit_title') + '</span></button>' +
                        '<button class="gm-btn sf-squad-delete-btn" style="background: rgba(239,68,68,0.12); border: 1px solid rgba(239,68,68,0.25); color: var(--error);" data-squad="' + sfActiveSquad + '" title="' + t('delete_title') + '"><i class="ph ph-trash"></i></button>'
                    :
                        '<button class="gm-btn gm-btn-success event-start-btn sf-squad-start-btn" data-squad="' + sfActiveSquad + '"><i class="ph ph-play"></i> <span>' + t('event_start') + '</span></button>' +
                        '<button class="gm-btn gm-btn-danger event-end-btn sf-squad-end-btn" data-squad="' + sfActiveSquad + '" disabled><i class="ph ph-stop-circle"></i> <span>' + t('event_end') + '</span></button>'
                    ) +
                '</div>' +
            '</div>';

        if (!isActive) {
            html +=
                '<div class="gm-empty" style="margin-top: 2rem;">' +
                    '<i class="ph-duotone ph-rocket-launch gm-icon"></i>' +
                    '<div class="gm-empty-title">' + t('event_not_active') + '</div>' +
                    '<div class="gm-empty-hint">' + t('sf_squad_inactive_hint') + '</div>' +
                '</div>';
            area.innerHTML = html;
            attachSFListeners(area);
            return;
        }

        var assignedPseudos = sfState.assignments.map(function (a) { return a.pseudo; });
        var unassigned = sfState.allMembers.filter(function (p) { return assignedPseudos.indexOf(p) === -1; });

        var squadParticipants = sfState.assignments.filter(function (a) { return a.squad === sfActiveSquad && a.role === 'participant'; });
        var squadReserves = sfState.assignments.filter(function (a) { return a.squad === sfActiveSquad && a.role === 'reserve'; });

        var counts = { excellent: 0, good: 0, average: 0, poor: 0, none: 0 };
        unassigned.forEach(function (p) { counts[categorise(p)]++; });

        html +=
            '<div class="sf-sub-tabs">' +
                '<button class="sf-sub-tab' + (sfActiveTab === 'squads' ? ' active' : '') + '" data-tab="squads"><i class="ph ph-users"></i> ' + t('sf_tab_composition') + '</button>' +
                '<button class="sf-sub-tab' + (sfActiveTab === 'tracking' ? ' active' : '') + '" data-tab="tracking"><i class="ph ph-chart-bar"></i> ' + t('sf_tab_tracking') + '</button>' +
            '</div>' +
            '<div class="input-wrapper" style="margin-bottom: 1.5rem;">' +
                '<i class="ph ph-magnifying-glass"></i>' +
                '<input type="text" class="sf-search-input" placeholder="' + t('search_placeholder') + '">' +
            '</div>';

        // ── Panel: Squads ──────────────────────────────────────────────────
        html += '<div class="sf-sub-panel' + (sfActiveTab === 'squads' ? ' active' : '') + '">';
        html += '<div class="sf-layout">';

        // Column 1: Unassigned
        html +=
            '<div class="sf-column sf-unassigned">' +
            '<div class="sf-col-header"><i class="ph-fill ph-users-three"></i> ' + t('sf_unassigned') +
                ' <span class="count-badge">' + unassigned.length + '</span></div>';

        html +=
            '<div class="sf-history-summary" style="display: flex; gap: 0.35rem; flex-wrap: wrap; justify-content: center; padding: 0.5rem 0.25rem;">' +
                '<span class="sf-cat-badge sf-rate-badge excellent">🟢 ' + counts.excellent + '</span>' +
                '<span class="sf-cat-badge sf-rate-badge good">🔵 ' + counts.good + '</span>' +
                '<span class="sf-cat-badge sf-rate-badge average">🟡 ' + counts.average + '</span>' +
                '<span class="sf-cat-badge sf-rate-badge poor">🔴 ' + counts.poor + '</span>' +
                '<span class="sf-cat-badge sf-rate-badge none">⚫ ' + counts.none + '</span>' +
            '</div>';

        html +=
            '<div class="sf-filter-tabs" style="padding: 0.5rem; justify-content: center; gap: 0.2rem;">' +
                '<button class="sf-filter-btn' + (sfFilter === 'all'      ? ' active' : '') + '" data-filter="all">' + t('sf_filter_all') + '</button>' +
                '<button class="sf-filter-btn' + (sfFilter === 'excellent'? ' active' : '') + '" data-filter="excellent">🟢 ' + t('sf_filter_excellent').split(' (')[0] + ' <span>' + counts.excellent + '</span></button>' +
                '<button class="sf-filter-btn' + (sfFilter === 'good'     ? ' active' : '') + '" data-filter="good">🔵 ' + t('sf_filter_good').split(' (')[0] + ' <span>' + counts.good + '</span></button>' +
                '<button class="sf-filter-btn' + (sfFilter === 'average'  ? ' active' : '') + '" data-filter="average">🟡 ' + t('sf_filter_average').split(' (')[0] + ' <span>' + counts.average + '</span></button>' +
                '<button class="sf-filter-btn' + (sfFilter === 'poor'     ? ' active' : '') + '" data-filter="poor">🔴 ' + t('sf_filter_poor').split(' (')[0] + ' <span>' + counts.poor + '</span></button>' +
                '<button class="sf-filter-btn' + (sfFilter === 'none'     ? ' active' : '') + '" data-filter="none">⚫ ' + t('sf_filter_none').split(' /')[0] + ' <span>' + counts.none + '</span></button>' +
            '</div>';

        var sortedUnassigned = unassigned.slice().sort(function (a, b) { return a.localeCompare(b); });
        var filtered = sortedUnassigned.filter(function (p) {
            return sfFilter === 'all' ? true : categorise(p) === sfFilter;
        });

        html += '<div class="sf-col-body" style="max-height: 480px; overflow-y: auto;">';
        if (filtered.length === 0) {
            html += '<div class="sf-empty">' + (unassigned.length === 0 ? t('sf_all_assigned') : t('sf_no_match_filter')) + '</div>';
        } else {
            filtered.forEach(function (pseudo) {
                var cat   = categorise(pseudo);
                var meta  = categoryMeta(cat);
                var h     = sfState.history[pseudo] || { assigned: 0, participated: 0 };
                var rateText = h.assigned > 0
                    ? Math.round((h.participated / h.assigned) * 100) + '%'
                    : 'N/A';
                var stats = h.assigned > 0
                    ? '<span class="sf-hist-stat">' + h.participated + '/' + h.assigned + '</span>'
                    : '<span class="sf-hist-stat">—</span>';

                var btns =
                    '<div class="sf-squad-btns">' +
                        '<button class="sf-btn sf-btn-p" data-pseudo="' + esc(pseudo) + '" data-squad="' + sfActiveSquad + '" data-role="participant" title="' + t('sf_participant') + '"><i class="ph ph-shield-check"></i></button>' +
                        '<button class="sf-btn sf-btn-r" data-pseudo="' + esc(pseudo) + '" data-squad="' + sfActiveSquad + '" data-role="reserve" title="' + t('sf_reserve') + '"><i class="ph ph-clock-countdown"></i></button>' +
                    '</div>';

                html +=
                    '<div class="sf-member-row sf-member-' + cat + '" style="border-left: 3px solid ' + (cat === 'excellent' ? 'var(--success)' : cat === 'good' ? '#60a5fa' : cat === 'average' ? '#fb923c' : cat === 'poor' ? 'var(--error)' : 'var(--text-muted)') + ';">' +
                        '<div class="sf-member-info" style="display: flex; align-items: center; gap: 0.4rem; min-width: 0; overflow: hidden; flex: 1;">' +
                            '<span class="sf-rate-badge ' + meta.cls + '" style="font-size: 0.72rem; padding: 0.15rem 0.45rem;">' + rateText + '</span>' +
                            '<span class="sf-pseudo" style="margin-left: 0.2rem; font-size: 0.85rem; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="' + esc(pseudo) + '">' + esc(pseudo) + '</span>' +
                            stats +
                        '</div>' +
                        '<div class="sf-actions">' + btns + '</div>' +
                    '</div>';
            });
        }
        html += '</div></div>'; // Column 1: Unassigned

        // Columns 2 & 3: Participants & Reserves
        html += renderSquadColumn(sfActiveSquad, squadParticipants, squadReserves);
        html += '</div>'; // sf-layout
        html += '</div>'; // sf-sub-panel (squads)

        // ── Panel: Tracking ────────────────────────────────────────────────
        html += '<div class="sf-sub-panel' + (sfActiveTab === 'tracking' ? ' active' : '') + '">';
        var activeSessionId = sq.sessionId;
        var squadTrackingParticipants = sfState.participants.filter(function (p) { return p.session_id === activeSessionId; });

        if (squadTrackingParticipants.length > 0) {
            html += renderTrackingTable(squadTrackingParticipants);
        } else {
            html += '<div class="empty-state">' + t('sf_no_one') + '</div>';
        }
        html += '</div>';

        area.innerHTML = html;
        attachSFListeners(area);
    }

    function renderSquadColumn(squad, participants, reserves) {
        var sq = sfState.squads[squad];
        var pFull = participants.length >= PARTICIPANTS_MAX;
        var rFull = reserves.length >= RESERVES_MAX;

        var html = '';

        // Column 2: Participants
        html += '<div class="sf-column sf-squad-col' + (sq.active ? '' : ' sf-squad-off') + '">' +
            '<div class="sf-col-header squad-header ' + squad + '">' +
                '<i class="ph-fill ph-shield-check"></i> ' + t('sf_participants') +
                ' <span class="sf-cap ' + (pFull ? 'full' : '') + '" style="margin-left: auto;">' + participants.length + '/' + PARTICIPANTS_MAX + '</span>' +
            '</div>' +
            '<div class="sf-col-body" style="max-height: 520px; overflow-y: auto;">';

        if (participants.length === 0) {
            html += '<div class="sf-empty">' + t('sf_no_one') + '</div>';
        } else {
            participants.forEach(function (a) { html += renderAssignedRow(a.pseudo, true, a.is_commander); });
        }
        html += '</div></div>';

        // Column 3: Reserves
        html += '<div class="sf-column sf-squad-col' + (sq.active ? '' : ' sf-squad-off') + '">' +
            '<div class="sf-col-header squad-header ' + squad + '" style="filter: brightness(0.95);">' +
                '<i class="ph-fill ph-clock-countdown"></i> ' + t('sf_reserves') +
                ' <span class="sf-cap ' + (rFull ? 'full' : '') + '" style="margin-left: auto;">' + reserves.length + '/' + RESERVES_MAX + '</span>' +
            '</div>' +
            '<div class="sf-col-body" style="max-height: 520px; overflow-y: auto;">';

        if (reserves.length === 0) {
            html += '<div class="sf-empty">' + t('sf_no_one') + '</div>';
        } else {
            reserves.forEach(function (a) { html += renderAssignedRow(a.pseudo, false); });
        }
        html += '</div></div>';

        return html;
    }

    function renderAssignedRow(pseudo, isParticipant, isCommander) {
        var cat  = categorise(pseudo);
        var meta = categoryMeta(cat);
        var h     = sfState.history[pseudo] || { assigned: 0, participated: 0 };
        var rateText = h.assigned > 0
            ? Math.round((h.participated / h.assigned) * 100) + '%'
            : 'N/A';

        var cmdBtn = '';
        if (isParticipant) {
            var iconClass = isCommander ? 'ph-fill ph-star' : 'ph ph-star';
            var starColor = isCommander ? 'color: #eab308; cursor: pointer;' : 'color: var(--fg-dim); cursor: pointer;';
            cmdBtn = '<button class="sf-commander-btn" data-pseudo="' + esc(pseudo) + '" title="Toggle Commander" style="background: none; border: none; padding: 0.2rem; margin-right: 0.25rem;' + starColor + '">' +
                '<i class="' + iconClass + '" style="font-size: 1.1rem;"></i>' +
            '</button>';
        }

        return '<div class="sf-assigned-row" style="display: flex; align-items: center; justify-content: space-between; padding: 0.5rem 0.6rem;">' +
            '<span class="sf-rate-badge ' + meta.cls + '" style="font-size: 0.7rem; padding: 0.1rem 0.35rem; margin-right: 0.25rem;">' + rateText + '</span>' +
            '<span class="sf-pseudo" style="font-weight: 500; font-size: 0.85rem; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">' + esc(pseudo) + '</span>' +
            '<div style="display: flex; align-items: center; gap: 0.2rem;">' +
                cmdBtn +
                '<button class="sf-remove-btn" data-pseudo="' + esc(pseudo) + '" title="' + t('sf_remove') + '"><i class="ph ph-x"></i></button>' +
            '</div>' +
        '</div>';
    }

    function renderTrackingTable(participants) {
        var done = participants.reduce(function (s, p) { return s + (p.participated || 0); }, 0);

        var html =
            '<div class="sf-tracking">' +
                '<div class="sf-tracking-header"><i class="ph-fill ph-chart-bar"></i> ' + t('sf_tracking_title') + '</div>' +
                '<div class="event-stats" style="margin-bottom: 1rem;">' +
                    '<span class="stat-chip"><i class="ph-fill ph-users"></i> ' + participants.length + ' ' + t('event_total') + '</span>' +
                    '<span class="stat-chip success"><i class="ph-fill ph-check-circle"></i> ' + done + ' ' + t('event_participated') + '</span>' +
                '</div>' +
                '<div class="participants-table-wrap"><table class="participants-table"><thead><tr>' +
                    '<th>' + t('col_member') + '</th>' +
                    '<th>' + t('sf_squad_col') + '</th>' +
                    '<th class="center">' + t('col_participated') + '</th>' +
                    '<th class="center">Late</th>' +
                    '<th class="center">Excused</th>' +
                    '<th style="width: 40px;"></th>' +
                '</tr></thead><tbody>';

        participants.forEach(function (p) {
            var assignment = sfState.assignments.find(function (a) { return a.pseudo === p.pseudo; });
            var squadLbl = assignment
                ? squadLabel(assignment.squad) + ' — ' + (assignment.role === 'participant' ? t('sf_participant') : t('sf_reserve'))
                : '—';
            var isChecked = p.participated > 0;
            var isLateChecked = !!p.late;
            var isExcusedChecked = !!p.excused;
            
            var cat = categorise(p.pseudo);
            var meta = categoryMeta(cat);
            var h = sfState.history[p.pseudo] || { assigned: 0, participated: 0 };
            var rateText = h.assigned > 0
                ? Math.round((h.participated / h.assigned) * 100) + '%'
                : 'N/A';

            html +=
                '<tr class="participant-row' + (isChecked ? ' participated' : '') + '">' +
                    '<td class="pseudo-cell" style="display: flex; align-items: center; gap: 0.5rem;">' +
                        '<span class="sf-rate-badge ' + meta.cls + '" style="font-size: 0.7rem; padding: 0.1rem 0.35rem;">' + rateText + '</span>' +
                        '<strong style="font-size: 0.88rem;">' + esc(p.pseudo) + '</strong>' +
                    '</td>' +
                    '<td><span class="squad-chip ' + (assignment ? assignment.squad : '') + '">' + squadLbl + '</span></td>' +
                    '<td class="check-cell">' +
                        '<label class="participation-check">' +
                            '<input type="checkbox" class="participation-checkbox sf-participation-checkbox" data-pseudo="' + esc(p.pseudo) + '"' + (isChecked ? ' checked' : '') + '>' +
                            '<span class="check-mark"><i class="ph ph-check"></i></span>' +
                        '</label>' +
                    '</td>' +
                    '<td class="check-cell">' +
                        '<label class="participation-check">' +
                            '<input type="checkbox" class="sf-late-checkbox" data-pseudo="' + esc(p.pseudo) + '"' + (isLateChecked ? ' checked' : '') + '>' +
                            '<span class="check-mark"><i class="ph ph-check"></i></span>' +
                        '</label>' +
                    '</td>' +
                    '<td class="check-cell">' +
                        '<label class="participation-check">' +
                            '<input type="checkbox" class="sf-excused-checkbox" data-pseudo="' + esc(p.pseudo) + '"' + (isExcusedChecked ? ' checked' : '') + '>' +
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
        area.querySelectorAll('.sf-main-tab').forEach(function (btn) {
            btn.addEventListener('click', function () {
                sfActiveSquad = btn.getAttribute('data-squad');
                renderShadowfront();
            });
        });

        var startBtn = area.querySelector('.sf-squad-start-btn');
        if (startBtn) {
            startBtn.addEventListener('click', function () {
                var squad = startBtn.getAttribute('data-squad');
                window.RAD.pickEventStart({ eventLabel: 'Shadowfront — ' + squadLabel(squad) }, function (startAt) {
                    if (!startAt) return; // annulé
                    startSquad(squad, startAt);
                });
            });
        }

        var endBtn = area.querySelector('.sf-squad-end-btn');
        if (endBtn) {
            endBtn.addEventListener('click', function () {
                var squad = endBtn.getAttribute('data-squad');
                window.showConfirm(
                    t('event_end'),
                    '<strong>' + squadLabel(squad) + '</strong><br>' + t('sf_squad_ended'),
                    function () {
                        endSquads([squad]);
                    }
                );
            });
        }

        var editBtn = area.querySelector('.sf-squad-edit-btn');
        if (editBtn) {
            editBtn.addEventListener('click', function () {
                var squad = editBtn.getAttribute('data-squad');
                editSquadSchedule(squad);
            });
        }

        var deleteBtn = area.querySelector('.sf-squad-delete-btn');
        if (deleteBtn) {
            deleteBtn.addEventListener('click', function () {
                var squad = deleteBtn.getAttribute('data-squad');
                deleteSquadSession(squad);
            });
        }

        area.querySelectorAll('.sf-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                assign(btn.getAttribute('data-pseudo'), btn.getAttribute('data-squad'), btn.getAttribute('data-role'));
            });
        });
        area.querySelectorAll('.sf-remove-btn').forEach(function (btn) {
            btn.addEventListener('click', function () { unassign(btn.getAttribute('data-pseudo')); });
        });
        area.querySelectorAll('.sf-commander-btn').forEach(function (btn) {
            btn.addEventListener('click', function () { toggleCommander(btn.getAttribute('data-pseudo')); });
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
        area.querySelectorAll('.sf-late-checkbox').forEach(function (cb) {
            cb.addEventListener('change', function () {
                var pseudo = cb.getAttribute('data-pseudo');
                saveLate(pseudo, cb.checked).then(function () {
                    var pp = sfState.participants.find(function (p) { return p.pseudo === pseudo; });
                    if (pp) pp.late = cb.checked;
                });
            });
        });
        area.querySelectorAll('.sf-excused-checkbox').forEach(function (cb) {
            cb.addEventListener('change', function () {
                var pseudo = cb.getAttribute('data-pseudo');
                saveExcused(pseudo, cb.checked).then(function () {
                    var pp = sfState.participants.find(function (p) { return p.pseudo === pseudo; });
                    if (pp) pp.excused = cb.checked;
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
                        if (!db) return;
                        var p = sfState.participants.find(function (x) { return x.pseudo === pseudo; });
                        if (!p) return;
                        await db.from('event_participants').delete()
                            .eq('event_name', EVENT_NAME)
                            .eq('session_id', p.session_id)
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



})();
