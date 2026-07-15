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
        membersData:  [],
        assignments:  [],
        participants: [],
        history:      {},   // pseudo → { assigned, participated, excused_count, late_count, sub_present_count }
        uidMap:       {},
        signups:      [],   // signups for roster prep
        maxPower:     0
    };

    var sfFilter      = 'all';      // 'all' | 'excellent' | 'good' | 'average' | 'poor' | 'none'
    var sfActiveTab   = 'squads';   // 'squads' | 'prep' | 'running' | 'tracking'
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
            var currentWeek = window.RAD.getWeekStart();
            var [statusRes, membersRes, histSquads, histParts, signupRes] = await Promise.all([
                db.from('event_status').select('event_name, is_active, session_id, start_at')
                    .in('event_name', [SQUAD_EVENT.squad1, SQUAD_EVENT.squad2]),
                db.from('guild_members').select('pseudo, uid, overall_power, strongest_fleet').order('pseudo', { ascending: true }),
                db.from('shadowfront_squads').select('pseudo, session_id').limit(100000),
                db.from('event_participants').select('pseudo, participated, session_id, excused, late, sub_present').eq('event_name', EVENT_NAME).limit(100000),
                db.from('shadowfront_signups').select('*').eq('week_start', currentWeek)
            ]);

            ['squad1', 'squad2'].forEach(function (k) {
                var row = (statusRes.data || []).find(function (r) { return r.event_name === SQUAD_EVENT[k]; });
                sfState.squads[k] = {
                    active:    row ? !!row.is_active : false,
                    sessionId: row ? row.session_id : null,
                    startAt:   row ? row.start_at : null
                };
            });

            sfState.membersData = membersRes.data || [];
            sfState.allMembers = sfState.membersData.map(function (m) { return m.pseudo; });
            sfState.uidMap = {};
            sfState.membersData.forEach(function (m) { sfState.uidMap[m.pseudo] = m.uid; });
            sfState.signups = signupRes.data || [];

            var powers = sfState.membersData.map(function (m) { return parseInt(m.overall_power) || 0; });
            sfState.maxPower = powers.length ? Math.max.apply(null, powers) : 0;

            var sids = currentSessionIds();

            // Histoire : exclure les sessions de l'occurrence courante et calculer les détails
            var hist = {};
            var partMap = {};
            (histParts.data || []).forEach(function (r) {
                partMap[r.pseudo + '|' + r.session_id] = {
                    participated: r.participated || 0,
                    excused: !!r.excused,
                    sub_present: !!r.sub_present,
                    late: !!r.late
                };
            });

            (histSquads.data || []).forEach(function (r) {
                if (sids.indexOf(r.session_id) !== -1) return;
                if (!hist[r.pseudo]) hist[r.pseudo] = { assigned: 0, participated: 0, excused_count: 0, late_count: 0, sub_present_count: 0 };
                
                var partInfo = partMap[r.pseudo + '|' + r.session_id];
                if (partInfo) {
                    if (partInfo.excused) {
                        hist[r.pseudo].excused_count++;
                    } else if (partInfo.sub_present) {
                        hist[r.pseudo].assigned++;
                        hist[r.pseudo].participated++; // Remplaçant présent = participation valide
                        hist[r.pseudo].sub_present_count++;
                    } else {
                        hist[r.pseudo].assigned++;
                        if (partInfo.participated > 0) {
                            hist[r.pseudo].participated++;
                        }
                        if (partInfo.late) {
                            hist[r.pseudo].late_count++;
                        }
                    }
                } else {
                    hist[r.pseudo].assigned++;
                }
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

                    window.RAD.showToast(t('toast_session_deleted'), 'success');
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

        // 3. Sub-tabs navigation (always available)
        html +=
            '<div class="sf-sub-tabs" style="margin-bottom: 1.5rem;">' +
                '<button class="sf-sub-tab' + (sfActiveTab === 'squads' ? ' active' : '') + '" data-tab="squads"><i class="ph ph-users"></i> ' + t('sf_tab_composition') + '</button>' +
                '<button class="sf-sub-tab' + (sfActiveTab === 'prep' ? ' active' : '') + '" data-tab="prep"><i class="ph ph-clipboard-text"></i> Roster Prep</button>' +
                '<button class="sf-sub-tab' + (sfActiveTab === 'running' ? ' active' : '') + '" data-tab="running"><i class="ph ph-list-numbers"></i> Running Tab</button>' +
                '<button class="sf-sub-tab' + (sfActiveTab === 'tracking' ? ' active' : '') + '" data-tab="tracking"><i class="ph ph-chart-bar"></i> ' + t('sf_tab_tracking') + '</button>' +
            '</div>';

        if (sfActiveTab !== 'running') {
            html +=
                '<div class="input-wrapper" style="margin-bottom: 1.5rem;">' +
                    '<i class="ph ph-magnifying-glass"></i>' +
                    '<input type="text" class="sf-search-input" placeholder="' + t('search_placeholder') + '">' +
                '</div>';
        }

        // ── Panel: Composition (Squads) ───────────────────────────────────────
        if (sfActiveTab === 'squads') {
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

            html += '<div class="sf-sub-panel active">';
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
                    var h     = sfState.history[pseudo] || { assigned: 0, participated: 0, excused_count: 0 };
                    var missed = h.assigned - h.participated;
                    var rateText = h.assigned > 0
                        ? Math.round((h.participated / h.assigned) * 100) + '%'
                        : 'N/A';
                    var stats = h.assigned > 0
                        ? '<span class="sf-hist-stat">' + h.participated + '/' + h.assigned + '</span>'
                        : '<span class="sf-hist-stat">—</span>';
                    var tooltipText = h.assigned > 0
                        ? h.participated + ' Play / ' + missed + ' Miss / ' + h.excused_count + ' Exc'
                        : 'No history';

                    var member = sfState.membersData.find(function (m) { return m.pseudo === pseudo; });
                    var powerVal = member ? parseInt(member.overall_power) || 0 : 0;
                    var pTier = window.RAD.getPowerTier(powerVal, sfState.maxPower);
                    var pMeta = window.RAD.getPowerTierMeta(pTier);
                    var formattedPower = powerVal > 0 ? window.RAD.formatPower(powerVal) : '';

                    var powerBadge = powerVal > 0
                        ? '<span class="gm-chip" style="font-size:0.68rem; padding:0.05rem 0.2rem; color:' + pMeta.color + '; border:1px solid ' + pMeta.color + '22; background:' + pMeta.color + '05; display:inline-flex; align-items:center; gap:0.15rem; margin-left:0.25rem;"><span style="font-size:0.75rem;">' + pMeta.icon + '</span> ' + formattedPower + '</span>'
                        : '';

                    var btns =
                        '<div class="sf-squad-btns">' +
                            '<button class="sf-btn sf-btn-p" data-pseudo="' + esc(pseudo) + '" data-squad="' + sfActiveSquad + '" data-role="participant" title="' + t('sf_participant') + '"><i class="ph ph-shield-check"></i></button>' +
                            '<button class="sf-btn sf-btn-r" data-pseudo="' + esc(pseudo) + '" data-squad="' + sfActiveSquad + '" data-role="reserve" title="' + t('sf_reserve') + '"><i class="ph ph-clock-countdown"></i></button>' +
                        '</div>';

                    html +=
                        '<div class="sf-member-row sf-member-' + cat + '" style="border-left: 3px solid ' + (cat === 'excellent' ? 'var(--success)' : cat === 'good' ? '#60a5fa' : cat === 'average' ? '#fb923c' : cat === 'poor' ? 'var(--error)' : 'var(--text-muted)') + ';">' +
                            '<div class="sf-member-info" style="display: flex; align-items: center; gap: 0.4rem; min-width: 0; overflow: hidden; flex: 1;">' +
                                '<span class="sf-rate-badge ' + meta.cls + '" style="font-size: 0.72rem; padding: 0.15rem 0.45rem;">' + rateText + '</span>' +
                                '<span class="sf-pseudo" title="' + esc(tooltipText) + '" style="margin-left: 0.2rem; font-size: 0.85rem; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">' + esc(pseudo) + '</span>' +
                                powerBadge +
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
            html += '</div>'; // active sub panel
        }

        // ── Panel: Roster Prep ─────────────────────────────────────────────────
        else if (sfActiveTab === 'prep') {
            html += '<div class="sf-sub-panel active">';
            html += '<div class="sf-prep-panel" style="display: flex; flex-direction: column; gap: 1.5rem; margin-top: 1rem;">';
            
            // Part 1: Availability registration (bulk select)
            html += '<div class="glass-card" style="padding: 1.25rem; border:1px solid var(--card-border); border-radius:var(--radius-lg);">' +
                '<h3 style="margin: 0 0 1rem 0; font-size: 1.1rem; display:flex; align-items:center; gap:0.5rem;"><i class="ph ph-clipboard-text"></i> Declare Availability (Current Week)</h3>' +
                '<div style="max-height: 250px; overflow-y: auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 0.5rem; padding: 0.25rem;">';
            
            sfState.membersData.forEach(function (m) {
                var signup = sfState.signups.find(function (s) { return s.pseudo === m.pseudo; });
                var avail = signup ? signup.availability : 'none';
                
                var tier = window.RAD.getPowerTier(m.overall_power, sfState.maxPower);
                var meta = window.RAD.getPowerTierMeta(tier);
                var formattedPower = window.RAD.formatPower(m.overall_power);
                
                var powerBadge = m.overall_power > 0 
                    ? '<span class="gm-chip" style="font-size:0.7rem; padding:0.05rem 0.25rem; color:' + meta.color + '; border:1px solid ' + meta.color + '22; background: ' + meta.color + '05; display:inline-flex; align-items:center; gap:0.15rem;"><span style="font-size:0.75rem;">' + meta.icon + '</span> ' + formattedPower + '</span>'
                    : '';

                html += '<div class="sf-prep-member-row" data-pseudo="' + esc(m.pseudo) + '" style="display: flex; align-items: center; justify-content: space-between; background: var(--bg-dim); border: 1px solid var(--border-soft); padding: 0.4rem 0.6rem; border-radius: var(--radius-md);">' +
                    '<div style="display: flex; flex-direction: column; gap: 0.15rem; min-width: 0; flex: 1; margin-right: 0.5rem;">' +
                        '<span style="font-size: 0.85rem; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">' + esc(m.pseudo) + '</span>' +
                        '<div>' + powerBadge + '</div>' +
                    '</div>' +
                    '<div class="sf-prep-buttons" style="display: flex; gap: 0.15rem;">' +
                        '<button class="gm-chip sf-avail-btn' + (avail === 'squad1' ? ' active gm-chip-accent' : '') + '" data-pseudo="' + esc(m.pseudo) + '" data-avail="squad1" style="font-size:0.72rem; padding:0.15rem 0.35rem; cursor:pointer;">S1</button>' +
                        '<button class="gm-chip sf-avail-btn' + (avail === 'squad2' ? ' active gm-chip-accent' : '') + '" data-pseudo="' + esc(m.pseudo) + '" data-avail="squad2" style="font-size:0.72rem; padding:0.15rem 0.35rem; cursor:pointer;">S2</button>' +
                        '<button class="gm-chip sf-avail-btn' + (avail === 'both' ? ' active gm-chip-accent' : '') + '" data-pseudo="' + esc(m.pseudo) + '" data-avail="both" style="font-size:0.72rem; padding:0.15rem 0.35rem; cursor:pointer;">Both</button>' +
                        '<button class="gm-chip sf-avail-btn' + (avail === 'none' ? ' active' : '') + '" data-pseudo="' + esc(m.pseudo) + '" data-avail="none" style="font-size:0.72rem; padding:0.15rem 0.35rem; cursor:pointer; background:rgba(255,255,255,0.05); color:var(--text-muted); border:1px solid var(--border-soft);"><i class="ph ph-trash" style="font-size:0.7rem;"></i></button>' +
                    '</div>' +
                '</div>';
            });
            
            html += '</div></div>';

            // Part 2: Availability groups Columns
            var availS1 = sfState.signups.filter(function (s) { return s.availability === 'squad1'; }).map(function (s) { return s.pseudo; });
            var availS2 = sfState.signups.filter(function (s) { return s.availability === 'squad2'; }).map(function (s) { return s.pseudo; });
            var availBoth = sfState.signups.filter(function (s) { return s.availability === 'both'; }).map(function (s) { return s.pseudo; });
            var availNone = sfState.allMembers.filter(function (pseudo) {
                return !sfState.signups.some(function (s) { return s.pseudo === pseudo && s.availability !== 'none'; });
            });

            html += '<div style="display: flex; gap: 1rem; flex-wrap: wrap;">';
            html += renderPrepColumn('Squad 1 Only', availS1, 'squad1');
            html += renderPrepColumn('Squad 2 Only', availS2, 'squad2');
            html += renderPrepColumn('Available Both', availBoth, 'both');
            html += renderPrepColumn('Not Registered', availNone, 'none');
            html += '</div>';

            html += '</div></div>';
        }

        // ── Panel: Running Tab ─────────────────────────────────────────────────
        else if (sfActiveTab === 'running') {
            html += '<div class="sf-sub-panel active">';
            html += renderRunningTab();
            html += '</div>';
        }

        // ── Panel: Tracking ────────────────────────────────────────────────────
        else if (sfActiveTab === 'tracking') {
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

            html += '<div class="sf-sub-panel active">';
            var activeSessionId = sq.sessionId;
            var squadTrackingParticipants = sfState.participants.filter(function (p) { return p.session_id === activeSessionId; });

            if (squadTrackingParticipants.length > 0) {
                html += renderTrackingTable(squadTrackingParticipants);
            } else {
                html += '<div class="empty-state">' + t('sf_no_one') + '</div>';
            }
            html += '</div>';
        }

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
        var h     = sfState.history[pseudo] || { assigned: 0, participated: 0, excused_count: 0 };
        var missed = h.assigned - h.participated;
        var rateText = h.assigned > 0
            ? Math.round((h.participated / h.assigned) * 100) + '%'
            : 'N/A';
        var tooltipText = h.assigned > 0
            ? h.participated + ' Played / ' + missed + ' Missed / ' + h.excused_count + ' Excused'
            : 'No previous matches';

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
            '<span class="sf-pseudo" title="' + esc(tooltipText) + '" style="font-weight: 500; font-size: 0.85rem; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">' + esc(pseudo) + '</span>' +
            '<div style="display: flex; align-items: center; gap: 0.2rem;">' +
                cmdBtn +
                '<button class="sf-remove-btn" data-pseudo="' + esc(pseudo) + '" title="' + t('sf_remove') + '"><i class="ph ph-x"></i></button>' +
            '</div>' +
        '</div>';
    }

    function renderPrepColumn(title, list, key) {
        var headerColor = key === 'squad1' ? 'border-top: 3px solid #6366f1;' : key === 'squad2' ? 'border-top: 3px solid #8b5cf6;' : key === 'both' ? 'border-top: 3px solid #ec4899;' : 'border-top: 3px solid var(--border-soft);';
        
        var html = '<div class="sf-column" style="flex: 1; min-width: 240px; background:var(--card-bg); border:1px solid var(--card-border); border-radius:var(--radius-lg); padding: 0.75rem;' + headerColor + '">' +
            '<div class="sf-col-header" style="font-weight:700; margin-bottom:0.75rem; display:flex; justify-content:space-between; align-items:center; font-size: 0.95rem;">' + esc(title) + ' <span class="count-badge">' + list.length + '</span></div>' +
            '<div style="max-height: 400px; overflow-y:auto; display:flex; flex-direction:column; gap:0.4rem;">';
        
        if (list.length === 0) {
            html += '<div class="sf-empty" style="font-size:0.8rem; padding:1.5rem 0.5rem; text-align: center;">No players</div>';
        } else {
            list.forEach(function (pseudo) {
                var member = sfState.membersData.find(function (m) { return m.pseudo === pseudo; });
                var power = member ? parseInt(member.overall_power) || 0 : 0;
                var tier = window.RAD.getPowerTier(power, sfState.maxPower);
                var meta = window.RAD.getPowerTierMeta(tier);
                
                var assignment = sfState.assignments.find(function (a) { return a.pseudo === pseudo; });
                var assignedHtml = '';
                var actionsHtml = '';
                
                if (assignment) {
                    var squadName = assignment.squad === 'squad1' ? 'S1' : 'S2';
                    var roleName = assignment.role === 'participant' ? 'P' : 'R';
                    assignedHtml = '<span class="gm-chip" style="font-size:0.65rem; padding:0.15rem 0.35rem; background:rgba(16,185,129,0.1); color:var(--success); border:1px solid rgba(16,185,129,0.2); font-weight:700; border-radius: 4px;">Assigned (' + squadName + ' ' + roleName + ')</span>';
                } else {
                    actionsHtml = '<div style="display:flex; gap:0.2rem; margin-top:0.35rem; width: 100%; flex-wrap: wrap;">' +
                        '<button class="gm-btn gm-btn-xs sf-quick-assign-btn" data-pseudo="' + esc(pseudo) + '" data-squad="squad1" data-role="participant" title="Squad 1 Participant" style="font-size:0.68rem; padding:2px 4px; flex: 1; min-width: 45px;">+S1 P</button>' +
                        '<button class="gm-btn gm-btn-xs sf-quick-assign-btn" data-pseudo="' + esc(pseudo) + '" data-squad="squad1" data-role="reserve" title="Squad 1 Reserve" style="font-size:0.68rem; padding:2px 4px; flex: 1; min-width: 45px;">+S1 R</button>' +
                        '<button class="gm-btn gm-btn-xs sf-quick-assign-btn" data-pseudo="' + esc(pseudo) + '" data-squad="squad2" data-role="participant" title="Squad 2 Participant" style="font-size:0.68rem; padding:2px 4px; flex: 1; min-width: 45px;">+S2 P</button>' +
                        '<button class="gm-btn gm-btn-xs sf-quick-assign-btn" data-pseudo="' + esc(pseudo) + '" data-squad="squad2" data-role="reserve" title="Squad 2 Reserve" style="font-size:0.68rem; padding:2px 4px; flex: 1; min-width: 45px;">+S2 R</button>' +
                        '</div>';
                }

                var powerText = power > 0 ? window.RAD.formatPower(power) : '—';
                
                html += '<div style="background:var(--bg-dim); border:1px solid var(--border-soft); padding:0.5rem; border-radius:var(--radius-md); display:flex; flex-direction:column; gap:0.2rem; align-items:flex-start;">' +
                    '<div style="width:100%; display:flex; justify-content:space-between; align-items:center; gap:0.5rem;">' +
                        '<span style="font-size:0.8rem; font-weight:600; text-overflow:ellipsis; overflow:hidden; white-space:nowrap; flex:1;" title="' + esc(pseudo) + '">' + esc(pseudo) + '</span>' +
                        '<span style="font-size:0.75rem; font-weight:700; color:' + meta.color + ';"><span style="font-size:0.8rem;">' + meta.icon + '</span> ' + powerText + '</span>' +
                    '</div>' +
                    assignedHtml +
                    actionsHtml +
                    '</div>';
            });
        }
        html += '</div></div>';
        return html;
    }

    function renderRunningTab() {
        var uniqueSessions = Array.from(new Set(
            (sfState.participants || []).map(function (p) { return p.session_id; })
                .concat(Object.keys(sfState.history).length ? [] : [])
        )).concat(
            Array.from(new Set(
                (sfState.historicalParts || []).map(function (p) { return p.session_id; })
            ))
        );

        uniqueSessions = Array.from(new Set(uniqueSessions)).filter(Boolean)
            .sort(function (a, b) { return new Date(b).getTime() - new Date(a).getTime(); });
        
        var runningSessions = uniqueSessions.slice(0, 8); // Last 8 matches

        var html = '<div class="sf-running-tab-panel" style="margin-top: 1rem; width:100%;">';
        html += '<div style="font-weight:700; font-size:1.1rem; margin-bottom:1rem; display:flex; align-items:center; gap:0.5rem;"><i class="ph ph-list-numbers"></i> Running Tab (Last ' + runningSessions.length + ' Matches)</div>';

        if (runningSessions.length === 0) {
            html += '<div class="gm-empty"><i class="ph-duotone ph-clock gm-icon"></i><div class="gm-empty-title">No Shadowfront matches found in history</div></div>';
            html += '</div>';
            return html;
        }

        html += '<div class="participants-table-wrap" style="overflow-x: auto;"><table class="participants-table" style="width:100%; border-collapse: collapse;"><thead><tr>' +
            '<th style="text-align: left; padding: 0.75rem;">' + t('col_member') + '</th>' +
            '<th style="text-align: left; padding: 0.75rem;">Power Tier</th>';

        runningSessions.forEach(function (sid) {
            var dateStr = new Date(sid).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
            html += '<th style="text-align: center; padding: 0.75rem; white-space: nowrap; font-size:0.8rem;">' + dateStr + '</th>';
        });

        html += '<th style="text-align: center; padding: 0.75rem;">Stats (P/M/E)</th>';
        html += '</tr></thead><tbody>';

        var sortedMembers = sfState.membersData.slice().sort(function (a, b) {
            return (parseInt(b.overall_power) || 0) - (parseInt(a.overall_power) || 0);
        });

        sortedMembers.forEach(function (m) {
            var tier = window.RAD.getPowerTier(m.overall_power, sfState.maxPower);
            var meta = window.RAD.getPowerTierMeta(tier);
            var formattedPower = window.RAD.formatPower(m.overall_power);
            
            var tierBadge = m.overall_power > 0 
                ? '<span class="gm-chip" style="font-size:0.7rem; padding:0.1rem 0.3rem; color:' + meta.color + '; border:1px solid ' + meta.color + '22; background: ' + meta.color + '05; display:inline-flex; align-items:center; gap:0.2rem;"><span style="font-size:0.75rem;">' + meta.icon + '</span> ' + formattedPower + '</span>'
                : '—';

            var played = 0;
            var missed = 0;
            var excused = 0;
            var cellsHtml = '';

            runningSessions.forEach(function (sid) {
                var wasAssigned = (sfState.historicalSquads || []).some(function (s) { return s.pseudo === m.pseudo && s.session_id === sid; }) ||
                    sfState.assignments.some(function (s) { return s.pseudo === m.pseudo && s.session_id === sid; });
                var partRow = (sfState.historicalParts || []).find(function (p) { return p.pseudo === m.pseudo && p.session_id === sid; }) ||
                    sfState.participants.find(function (p) { return p.pseudo === m.pseudo && p.session_id === sid; });

                if (partRow) {
                    if (partRow.excused) {
                        excused++;
                        cellsHtml += '<td style="text-align: center; padding: 0.5rem;"><span class="gm-chip" style="background: rgba(245,158,11,0.1); color: var(--warning); border: 1px solid rgba(245,158,11,0.2); font-size:0.75rem; padding:0.1rem 0.35rem;">Excused</span></td>';
                    } else if (partRow.sub_present) {
                        played++;
                        cellsHtml += '<td style="text-align: center; padding: 0.5rem;"><span class="gm-chip" style="background: rgba(59,130,246,0.1); color: #60a5fa; border: 1px solid rgba(59,130,246,0.2); font-size:0.75rem; padding:0.1rem 0.35rem;">Sub Pres</span></td>';
                    } else if (partRow.participated > 0) {
                        played++;
                        cellsHtml += '<td style="text-align: center; padding: 0.5rem;"><span class="gm-chip" style="background: rgba(16,185,129,0.1); color: var(--success); border: 1px solid rgba(16,185,129,0.2); font-size:0.75rem; padding:0.1rem 0.35rem;">Present</span></td>';
                    } else {
                        missed++;
                        cellsHtml += '<td style="text-align: center; padding: 0.5rem;"><span class="gm-chip" style="background: rgba(239,68,68,0.1); color: var(--error); border: 1px solid rgba(239,68,68,0.2); font-size:0.75rem; padding:0.1rem 0.35rem;">No Show</span></td>';
                    }
                } else {
                    if (wasAssigned) {
                        missed++;
                        cellsHtml += '<td style="text-align: center; padding: 0.5rem;"><span class="gm-chip" style="background: rgba(239,68,68,0.1); color: var(--error); border: 1px solid rgba(239,68,68,0.2); font-size:0.75rem; padding:0.1rem 0.35rem;">No Show</span></td>';
                    } else {
                        cellsHtml += '<td style="text-align: center; padding: 0.5rem; color: var(--text-muted); font-weight: 300;">—</td>';
                    }
                }
            });

            html += '<tr style="border-bottom: 1px solid var(--border-soft);">' +
                '<td style="padding: 0.75rem; font-weight: 600;">' + esc(m.pseudo) + '</td>' +
                '<td style="padding: 0.75rem;">' + tierBadge + '</td>' +
                cellsHtml +
                '<td style="text-align: center; padding: 0.75rem; font-weight: 700; font-size:0.8rem;"><span style="color:var(--success);">' + played + 'P</span> / <span style="color:var(--error);">' + missed + 'M</span> / <span style="color:var(--warning);">' + excused + 'E</span></td>' +
                '</tr>';
        });

        html += '</tbody></table></div></div>';
        return html;
    }

    function renderTrackingTable(participants) {
        var done = participants.reduce(function (s, p) { return s + (p.participated || 0); }, 0);

        var pendingCount = participants.reduce(function (s, p) { return s + (p.is_pending ? 1 : 0); }, 0);
        var approveAllBtn = pendingCount > 0
            ? '<button type="button" class="gm-btn gm-btn-sm gm-btn-success approve-sf-all-btn" style="margin-left: auto; font-size: 0.8rem; padding: 0.25rem 0.5rem;"><i class="ph ph-check-square"></i> Approve All (' + pendingCount + ')</button>'
            : '';

        var html =
            '<div class="sf-tracking">' +
                '<div class="sf-tracking-header"><i class="ph-fill ph-chart-bar"></i> ' + t('sf_tracking_title') + '</div>' +
                '<div class="event-stats" style="margin-bottom: 1rem; display: flex; align-items: center; flex-wrap: wrap; gap: 0.5rem;">' +
                    '<span class="stat-chip"><i class="ph-fill ph-users"></i> ' + participants.length + ' ' + t('event_total') + '</span>' +
                    '<span class="stat-chip success"><i class="ph-fill ph-check-circle"></i> ' + done + ' ' + t('event_participated') + '</span>' +
                    approveAllBtn +
                '</div>' +
                '<div class="participants-table-wrap"><table class="participants-table"><thead><tr>' +
                    '<th>' + t('col_member') + '</th>' +
                    '<th>' + t('sf_squad_col') + '</th>' +
                    '<th class="center">' + t('col_participated') + '</th>' +
                    '<th class="center">Late</th>' +
                    '<th class="center">Excused</th>' +
                    '<th class="center">Sub Present</th>' +
                    '<th style="width: 140px; text-align: right;">Actions</th>' +
                '</tr></thead><tbody>';

        participants.forEach(function (p) {
            var assignment = sfState.assignments.find(function (a) { return a.pseudo === p.pseudo; });
            var squadLbl = assignment
                ? squadLabel(assignment.squad) + ' — ' + (assignment.role === 'participant' ? t('sf_participant') : t('sf_reserve'))
                : '—';
            var isChecked = p.participated > 0;
            var isLateChecked = !!p.late;
            var isExcusedChecked = !!p.excused;
            var isSubPresentChecked = !!p.sub_present;
            
            var cat = categorise(p.pseudo);
            var meta = categoryMeta(cat);
            var h = sfState.history[p.pseudo] || { assigned: 0, participated: 0 };
            var rateText = h.assigned > 0
                ? Math.round((h.participated / h.assigned) * 100) + '%'
                : 'N/A';

            var rowClass = 'participant-row' + (isChecked ? ' participated' : '') + (p.is_pending ? ' pending-approval-row' : '');
            var rowStyle = p.is_pending ? 'background: rgba(245, 158, 11, 0.05); border-left: 3px solid var(--warning);' : '';

            var actionBtn = p.is_pending
                ? '<button type="button" class="gm-btn gm-btn-success approve-sf-single-btn" data-pseudo="' + esc(p.pseudo) + '" style="font-size:0.75rem; padding:0.2rem 0.4rem; display:inline-flex; align-items:center; gap:0.25rem; margin-right:0.4rem; border:none; border-radius:4px; cursor:pointer;"><i class="ph ph-check"></i> Approve</button>'
                : '';

            html +=
                '<tr class="' + rowClass + '" style="' + rowStyle + '">' +
                    '<td class="pseudo-cell" style="display: flex; align-items: center; gap: 0.5rem;">' +
                        '<span class="sf-rate-badge ' + meta.cls + '" style="font-size: 0.7rem; padding: 0.1rem 0.35rem;">' + rateText + '</span>' +
                        '<strong style="font-size: 0.88rem; display:inline-flex; align-items:center; gap:0.4rem;">' + 
                            esc(p.pseudo) + 
                            (p.is_pending ? '<span class="gm-chip" style="font-size:0.65rem; padding:0.05rem 0.25rem; background:rgba(245,158,11,0.1); color:var(--warning); border:1px solid rgba(245,158,11,0.25);">Pending</span>' : '') +
                        '</strong>' +
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
                    '<td class="check-cell">' +
                        '<label class="participation-check">' +
                            '<input type="checkbox" class="sf-sub-present-checkbox" data-pseudo="' + esc(p.pseudo) + '"' + (isSubPresentChecked ? ' checked' : '') + '>' +
                            '<span class="check-mark"><i class="ph ph-check"></i></span>' +
                        '</label>' +
                    '</td>' +
                    '<td style="white-space: nowrap; text-align: right;">' + actionBtn + '<button class="delete-btn sf-delete-participant-btn" data-pseudo="' + esc(p.pseudo) + '" title="' + t('delete_title') + '"><i class="ph ph-trash"></i></button></td>' +
                '</tr>';
        });

        html += '</tbody></table></div></div>';
        return html;
    }

    async function saveAvailability(pseudo, availability) {
        if (!db) return;
        var week = window.RAD.getWeekStart();
        try {
            if (availability === 'none') {
                await db.from('shadowfront_signups').delete().eq('week_start', week).eq('pseudo', pseudo);
            } else {
                await db.from('shadowfront_signups').upsert({
                    week_start: week,
                    pseudo: pseudo,
                    availability: availability
                }, { onConflict: 'guild,week_start,pseudo' });
            }
            window.RAD.showToast(pseudo + '\'s availability updated', 'success');
            await loadShadowfront();
        } catch (err) {
            console.error('saveAvailability failed', err);
            window.RAD.showToast('Failed to save availability', 'error');
        }
    }

    async function saveSubPresent(pseudo, value) {
        if (!db) return;
        var p = sfState.participants.find(function (x) { return x.pseudo === pseudo; });
        if (!p) return;
        await db.from('event_participants').update({ sub_present: value })
            .eq('event_name', EVENT_NAME).eq('session_id', p.session_id).eq('pseudo', pseudo);
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

        area.querySelectorAll('.sf-avail-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var pseudo = btn.getAttribute('data-pseudo');
                var avail = btn.getAttribute('data-avail');
                saveAvailability(pseudo, avail);
            });
        });

        area.querySelectorAll('.sf-quick-assign-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var pseudo = btn.getAttribute('data-pseudo');
                var squad = btn.getAttribute('data-squad');
                var role = btn.getAttribute('data-role');
                assign(pseudo, squad, role);
            });
        });

        area.querySelectorAll('.approve-sf-single-btn').forEach(function (btn) {
            btn.addEventListener('click', async function () {
                var pseudo = btn.getAttribute('data-pseudo');
                btn.disabled = true;
                btn.textContent = '...';
                try {
                    await db.from('event_participants').update({ is_pending: false })
                        .eq('event_name', EVENT_NAME)
                        .in('session_id', sfState.squads.squad1.sessionId ? [sfState.squads.squad1.sessionId, sfState.squads.squad2.sessionId].filter(Boolean) : [sfState.squads.squad2.sessionId].filter(Boolean))
                        .eq('pseudo', pseudo);
                    
                    var pp = sfState.participants.find(function (p) { return p.pseudo === pseudo; });
                    if (pp) pp.is_pending = false;
                    renderShadowfront();
                } catch (err) {
                    window.RAD_APP.showToast('Failed to approve submission.', 'error');
                    btn.disabled = false;
                    btn.textContent = 'Approve';
                }
            });
        });

        var approveAllBtnEl = area.querySelector('.approve-sf-all-btn');
        if (approveAllBtnEl) {
            approveAllBtnEl.addEventListener('click', async function () {
                approveAllBtnEl.disabled = true;
                approveAllBtnEl.textContent = 'Approving...';
                try {
                    await db.from('event_participants').update({ is_pending: false })
                        .eq('event_name', EVENT_NAME)
                        .in('session_id', sfState.squads.squad1.sessionId ? [sfState.squads.squad1.sessionId, sfState.squads.squad2.sessionId].filter(Boolean) : [sfState.squads.squad2.sessionId].filter(Boolean))
                        .eq('is_pending', true);
                    
                    sfState.participants.forEach(function (p) {
                        if (p.is_pending) p.is_pending = false;
                    });
                    renderShadowfront();
                } catch (err) {
                    window.RAD_APP.showToast('Failed to approve all submissions.', 'error');
                    approveAllBtnEl.disabled = false;
                    approveAllBtnEl.textContent = 'Approve All';
                }
            });
        }

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
        area.querySelectorAll('.sf-sub-present-checkbox').forEach(function (cb) {
            cb.addEventListener('change', function () {
                var pseudo = cb.getAttribute('data-pseudo');
                saveSubPresent(pseudo, cb.checked).then(function () {
                    var pp = sfState.participants.find(function (p) { return p.pseudo === pseudo; });
                    if (pp) pp.sub_present = cb.checked;
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
                area.querySelectorAll('.sf-member-row, .sf-assigned-row, .sf-prep-member-row').forEach(function (row) {
                    var btn = row.querySelector('.sf-btn, .sf-remove-btn, .sf-avail-btn');
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
