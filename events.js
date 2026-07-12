/**
 * events.js — SvS, GvG, DTR, Arms Race (A & B fusionnés).
 * Chaque START crée une nouvelle session (timestamp). END termine la session courante.
 * Le DTR n'a pas de score, seulement une participation.
 */
(function () {

    var db   = window.RAD ? window.RAD.db : null;
    var t    = window.RAD ? window.RAD.t  : function (k) { return k; };
    var esc  = window.RAD ? window.RAD.escapeHTML : function (s) { return s; };
    var fmt  = window.RAD ? window.RAD.formatNumber : function (n) { return String(n); };

    // event_name "logique" → event_name côté DB (Arms Race a 2 stages)
    var STANDARD_EVENTS = ['SvS', 'GvG', 'Defend Trade Route'];

    // Onglet UI → liste d'event_names DB qu'il pilote
    var TAB_TO_DB_EVENTS = {
        'SvS':                ['SvS'],
        'GvG':                ['GvG'],
        'Defend Trade Route': ['Defend Trade Route']
    };

    var PANEL_MAP = {
        'SvS':                'event-svs',
        'GvG':                'event-gvg',
        'Defend Trade Route': 'event-dtr'
    };

    var EVENTS_WITHOUT_SCORE = ['Defend Trade Route'];

    // ── State ────────────────────────────────────────────────────────────────
    // tabKey → { activeEventName, sessionId, stage, isActive, participants[] }
    var state = {};
    Object.keys(TAB_TO_DB_EVENTS).forEach(function (k) {
        state[k] = { activeEventName: null, sessionId: null, stage: null, isActive: false, participants: [] };
    });
    var uidMap = {};

    // ── Public API ────────────────────────────────────────────────────────────
    window.RAD_EVENTS = { loadEvent: loadEvent, addMemberToActiveEvents: addMemberToActiveEvents };

    // ── Load event (called when tab is clicked) ────────────────────────────
    async function loadEvent(tabKey) {
        if (!db || !TAB_TO_DB_EVENTS[tabKey]) return;
        try {
            var dbEvents = TAB_TO_DB_EVENTS[tabKey];
            var res = await db.from('event_status').select('event_name, is_active, session_id, stage, start_at')
                .in('event_name', dbEvents);

            var active = (res.data || []).find(function (r) { return r.is_active; });
            var s = state[tabKey];
            if (active) {
                s.activeEventName = active.event_name;
                s.sessionId       = active.session_id;
                s.stage           = active.stage;
                s.startAt         = active.start_at;
                s.isActive        = true;
                renderStatus(tabKey);
                await fetchParticipants(tabKey);
                // Self-heal : session active mais aucun participant ⇒ repopuler
                if (s.sessionId && s.participants.length === 0) {
                    await populateParticipants(tabKey);
                }
            } else {
                s.activeEventName = null;
                s.sessionId       = null;
                s.stage           = null;
                s.startAt         = null;
                s.isActive        = false;
                renderStatus(tabKey);
                renderInactive(tabKey);
            }
        } catch (err) { console.error('loadEvent', err); }
    }

    // ── Démarrage d'une nouvelle session ──────────────────────────────────
    async function startEvent(tabKey, dbEventName, stage, startAt) {
        if (!db) return;
        var sessionId = window.RAD.newSessionId();
        try {
            var statusRes = await db.from('event_status').upsert(
                {
                    event_name: dbEventName,
                    is_active:  true,
                    session_id: sessionId,
                    stage:      stage || null,
                    start_at:   startAt || null,
                    updated_at: new Date().toISOString()
                },
                { onConflict: 'guild,event_name' }
            );
            if (statusRes.error) throw statusRes.error;

            state[tabKey].activeEventName = dbEventName;
            state[tabKey].sessionId       = sessionId;
            state[tabKey].stage           = stage || null;
            state[tabKey].startAt         = startAt || null;
            state[tabKey].isActive        = true;
            renderStatus(tabKey);
            await populateParticipants(tabKey);

            if (window.RAD.notifyDiscordEvent) {
                window.RAD.notifyDiscordEvent(dbEventName, startAt || sessionId, 'start');
            }
        } catch (err) {
            console.error('startEvent', err);
            window.RAD.showToast(t('toast_err_generic') + ' ' + err.message, 'error');
        }
    }

    // ── Arrêt de la session courante ──────────────────────────────────────
    async function endEvent(tabKey) {
        if (!db) return;
        var s = state[tabKey];
        if (!s.activeEventName) return;
        try {
            await db.from('event_status').upsert(
                {
                    event_name: s.activeEventName,
                    is_active:  false,
                    session_id: s.sessionId, // on garde la dernière, pour info
                    stage:      s.stage,
                    updated_at: new Date().toISOString()
                },
                { onConflict: 'guild,event_name' }
            );
            s.activeEventName = null;
            s.sessionId       = null;
            s.stage           = null;
            s.isActive        = false;
            renderStatus(tabKey);
            renderInactive(tabKey);
            window.RAD.showToast(t('event_session_ended'), 'success');
        } catch (err) {
            console.error('endEvent', err);
            window.RAD.showToast(t('toast_err_generic') + ' ' + err.message, 'error');
        }
    }

    // ── Auto-populate members pour une nouvelle session ──────────────────
    // Utilise la RPC populate_event_participants pour contourner les problèmes
    // de schema cache PostgREST et garantir l'exécution atomique côté DB.
    async function populateParticipants(tabKey) {
        if (!db) return;
        var s = state[tabKey];
        if (!s.activeEventName || !s.sessionId) return;

        var week = window.RAD.getWeekStart(s.startAt);
        var rpcRes = await db.rpc('populate_event_participants', {
            p_event_name: s.activeEventName,
            p_session_id: s.sessionId,
            p_week_start: week
        });

        if (rpcRes.error) {
            console.error('populateParticipants: rpc error', rpcRes.error);
            window.RAD.showToast(t('toast_err_import_participants') + ' ' + rpcRes.error.message, 'error');
            return;
        }

        var inserted = (typeof rpcRes.data === 'number') ? rpcRes.data : 0;
        if (inserted > 0) {
            window.RAD.showToast(inserted + ' ' + t('toast_members_imported'), 'success');
        }
        await fetchParticipants(tabKey);
    }

    // ── Ajout dynamique d'un membre aux événements actifs ─────────────────
    // Appelé après l'insertion d'un membre dans guild_members. Insère une
    // ligne event_participants pour chaque event actif (hors Shadowfront,
    // dont les participants sont liés aux assignations de squad).
    // Retourne le nombre d'events mis à jour.
    async function addMemberToActiveEvents(pseudo) {
        if (!db || !pseudo) return 0;

        var dbEventNames = [];
        Object.keys(TAB_TO_DB_EVENTS).forEach(function (k) {
            TAB_TO_DB_EVENTS[k].forEach(function (n) { dbEventNames.push(n); });
        });

        try {
            var statusRes = await db.from('event_status')
                .select('event_name, session_id, start_at')
                .eq('is_active', true)
                .in('event_name', dbEventNames);
            if (statusRes.error) throw statusRes.error;

            var active = (statusRes.data || []).filter(function (r) { return r.session_id; });
            if (active.length === 0) return 0;

            var rows = active.map(function (r) {
                return {
                    event_name:   r.event_name,
                    session_id:   r.session_id,
                    week_start:   window.RAD.getWeekStart(r.start_at || new Date(r.session_id)),
                    pseudo:       pseudo,
                    participated: 0,
                    score:        null
                };
            });

            var insRes = await db.from('event_participants').insert(rows);
            if (insRes.error) throw insRes.error;

            // Sync UI : pour chaque onglet ouvert dont la session courante a été enrichie,
            // ajoute le membre en mémoire et re-rendu.
            Object.keys(state).forEach(function (tabKey) {
                var s = state[tabKey];
                if (!s.isActive || !s.sessionId) return;
                var matched = active.find(function (a) {
                    return a.event_name === s.activeEventName && a.session_id === s.sessionId;
                });
                if (!matched) return;
                if (s.participants.some(function (p) { return p.pseudo === pseudo; })) return;
                s.participants.push({
                    event_name:   s.activeEventName,
                    session_id:   s.sessionId,
                    week_start:   window.RAD.getWeekStart(matched.start_at || new Date(s.sessionId)),
                    pseudo:       pseudo,
                    participated: 0,
                    score:        null
                });
                s.participants.sort(function (a, b) {
                    return String(a.pseudo).localeCompare(String(b.pseudo));
                });
                renderParticipants(tabKey);
            });

            return active.length;
        } catch (err) {
            console.error('addMemberToActiveEvents', err);
            return 0;
        }
    }

    // ── Fetch participants de la session active ──────────────────────────
    async function fetchParticipants(tabKey) {
        if (!db) return;
        var s = state[tabKey];
        if (!s.activeEventName || !s.sessionId) return;
        var [partRes, memRes] = await Promise.all([
            db.from('event_participants').select('*')
                .eq('event_name', s.activeEventName)
                .eq('session_id', s.sessionId)
                .order('pseudo', { ascending: true }),
            db.from('guild_members').select('pseudo, uid')
        ]);
        if (partRes.error) return;
        (memRes.data || []).forEach(function (m) { uidMap[m.pseudo] = m.uid; });
        s.participants = partRes.data || [];
        renderParticipants(tabKey);
    }

    // ── Save participation / score ────────────────────────────────────────
    async function saveParticipation(tabKey, pseudo, value) {
        if (!db) return;
        var s = state[tabKey];
        await db.from('event_participants').update({ participated: value })
            .eq('event_name', s.activeEventName)
            .eq('session_id', s.sessionId)
            .eq('pseudo', pseudo);
    }

    async function saveAppointed(tabKey, pseudo, value) {
        if (!db) return;
        var s = state[tabKey];
        await db.from('event_participants').update({ appointed: value })
            .eq('event_name', s.activeEventName)
            .eq('session_id', s.sessionId)
            .eq('pseudo', pseudo);
    }

    async function saveScore(tabKey, pseudo, value) {
        return saveScoreField(tabKey, pseudo, 'score', value);
    }

    // SvS has two scores (Preparation Stage + PvP Day) ; ce helper update une
    // colonne arbitraire de event_participants.
    async function saveScoreField(tabKey, pseudo, field, value) {
        if (!db) return;
        var s = state[tabKey];
        var num = window.RAD.parseNumber(value);
        var update = {};
        update[field] = num;
        await db.from('event_participants').update(update)
            .eq('event_name', s.activeEventName)
            .eq('session_id', s.sessionId)
            .eq('pseudo', pseudo);
    }

    // ── Render helpers ────────────────────────────────────────────────────
    function getPanel(tabKey)   { return document.getElementById(PANEL_MAP[tabKey]); }
    function getContentEl(tabKey) {
        var p = getPanel(tabKey);
        return p ? p.querySelector('.event-participants-area') : null;
    }

    // Ces événements demandent un jour + heure de début (UTC) au lancement
    var SCHEDULED_TABS = ['Defend Trade Route'];

    async function editEventSchedule(tabKey) {
        if (!db) return;
        var s = state[tabKey];
        if (!s.activeEventName || !s.sessionId) return;
        
        try {
            var res = await db.from('event_status').select('start_at')
                .eq('event_name', s.activeEventName).single();
            if (res.error) throw res.error;
            
            var currentStartAt = res.data ? res.data.start_at : null;
            
            window.RAD.pickEventStart({ 
                eventLabel: s.activeEventName + ' — ' + t('edit_title'), 
                defaultVal: currentStartAt 
            }, async function (startAt) {
                if (!startAt) return;
                
                try {
                    var updateRes = await db.from('event_status').update({
                        start_at: startAt,
                        updated_at: new Date().toISOString()
                    }).eq('event_name', s.activeEventName);
                    if (updateRes.error) throw updateRes.error;

                    var newWeek = window.RAD.getWeekStart(startAt);
                    var updatePartRes = await db.from('event_participants').update({
                        week_start: newWeek
                    }).eq('event_name', s.activeEventName)
                      .eq('session_id', s.sessionId);
                    if (updatePartRes.error) throw updatePartRes.error;
                    
                    window.RAD.showToast(t('toast_member_updated'), 'success');
                    
                    if (window.RAD.notifyDiscordEvent) {
                        window.RAD.notifyDiscordEvent(s.activeEventName, startAt, 'edit');
                    }

                    await loadEvent(tabKey);
                } catch (err) {
                    console.error('editEventSchedule update', err);
                    window.RAD.showToast(t('toast_err_generic') + ' ' + err.message, 'error');
                }
            });
        } catch (err) {
            console.error('editEventSchedule fetch', err);
            window.RAD.showToast(t('toast_err_generic') + ' ' + err.message, 'error');
        }
    }

    function deleteEventSession(tabKey) {
        if (!db) return;
        var s = state[tabKey];
        if (!s.activeEventName || !s.sessionId) return;
        
        window.showConfirm(
            t('confirm_delete_session_title'),
            '<strong>' + esc(s.activeEventName) + '</strong><br>' + t('confirm_delete_session_body'),
            async function () {
                try {
                    var delPartRes = await db.from('event_participants')
                        .delete()
                        .eq('event_name', s.activeEventName)
                        .eq('session_id', s.sessionId);
                    if (delPartRes.error) throw delPartRes.error;
                    
                    var delStatusRes = await db.from('event_status')
                        .delete()
                        .eq('event_name', s.activeEventName);
                    if (delStatusRes.error) throw delStatusRes.error;
                    
                    window.RAD.showToast(t('toast_session_deleted'), 'success');
                    
                    s.activeEventName = null;
                    s.sessionId       = null;
                    s.stage           = null;
                    s.isActive        = false;
                    renderStatus(tabKey);
                    renderInactive(tabKey);
                } catch (err) {
                    console.error('deleteEventSession', err);
                    window.RAD.showToast(t('toast_err_generic') + ' ' + err.message, 'error');
                }
            }
        );
    }

    function renderStatus(tabKey) {
        var panel = getPanel(tabKey);
        if (!panel) return;
        var s = state[tabKey];
        var badge    = panel.querySelector('.event-status-badge');
        var actionsDiv = panel.querySelector('.gm-event-actions');
        var stageBadge = panel.querySelector('.arms-stage-badge');

        if (badge) {
            badge.className = 'event-status-badge gm-chip' + (s.isActive ? ' gm-chip-success active' : '');
            badge.innerHTML = '<span class="gm-dot"></span> ' +
                (s.isActive ? t('event_active') : t('event_inactive'));
        }

        if (actionsDiv) {
            if (s.isActive) {
                var eventNameAttr = tabKey;
                actionsDiv.innerHTML = 
                    '<button class="gm-btn gm-btn-danger event-end-btn" data-event="' + esc(eventNameAttr) + '" style="margin-right: 0.25rem;"><i class="ph ph-stop-circle"></i> <span>' + t('event_end') + '</span></button>' +
                    '<button class="gm-btn event-edit-sched-btn" style="background: rgba(99,102,241,0.15); border: 1px solid rgba(99,102,241,0.3); color: #a5b4fc; margin-right: 0.25rem;" data-event="' + esc(eventNameAttr) + '" title="' + t('edit_title') + '"><i class="ph ph-calendar"></i> <span>' + t('edit_title') + '</span></button>' +
                    '<button class="gm-btn event-delete-session-btn" style="background: rgba(239,68,68,0.12); border: 1px solid rgba(239,68,68,0.25); color: var(--error);" data-event="' + esc(eventNameAttr) + '" title="' + t('delete_title') + '"><i class="ph ph-trash"></i></button>';
                
                var endBtnDyn = actionsDiv.querySelector('.event-end-btn');
                if (endBtnDyn) endBtnDyn.addEventListener('click', function () { endEvent(tabKey); });
                
                var editBtnDyn = actionsDiv.querySelector('.event-edit-sched-btn');
                if (editBtnDyn) editBtnDyn.addEventListener('click', function () { editEventSchedule(tabKey); });
                
                var deleteBtnDyn = actionsDiv.querySelector('.event-delete-session-btn');
                if (deleteBtnDyn) deleteBtnDyn.addEventListener('click', function () { deleteEventSession(tabKey); });
            } else {
                var eventNameAttr = tabKey;
                actionsDiv.innerHTML = 
                    '<button class="gm-btn gm-btn-success event-start-btn" data-event="' + esc(eventNameAttr) + '" style="margin-right: 0.25rem;"><i class="ph ph-play"></i> <span>' + t('event_start') + '</span></button>' +
                    '<button class="gm-btn gm-btn-danger event-end-btn" data-event="' + esc(eventNameAttr) + '" disabled><i class="ph ph-stop-circle"></i> <span>' + t('event_end') + '</span></button>';
                
                var startBtnDyn = actionsDiv.querySelector('.event-start-btn');
                if (startBtnDyn) {
                    startBtnDyn.addEventListener('click', function () {
                        if (SCHEDULED_TABS.indexOf(tabKey) !== -1) {
                            window.RAD.pickEventStart({ eventLabel: tabKey }, function (startAt) {
                                if (!startAt) return;
                                startEvent(tabKey, tabKey, null, startAt);
                            });
                        } else {
                            startEvent(tabKey, tabKey, null);
                        }
                    });
                }
            }
        }

        if (stageBadge) {
            stageBadge.classList.add('hidden');
            stageBadge.textContent = '';
        }
    }

    function renderInactive(tabKey) {
        var el = getContentEl(tabKey);
        if (!el) return;
        el.innerHTML =
            '<div class="gm-empty">' +
                '<i class="ph-duotone ph-rocket-launch gm-icon"></i>' +
                '<div class="gm-empty-title">' + t('event_not_active') + '</div>' +
                '<div class="gm-empty-hint">' + t('event_not_active_hint') + '</div>' +
            '</div>';
    }

    function renderParticipants(tabKey) {
        var el = getContentEl(tabKey);
        if (!el) return;
        var s = state[tabKey];
        var participants = s.participants;
        var dbEventName  = s.activeEventName;

        if (!participants.length) {
            el.innerHTML = '<div class="gm-empty"><i class="ph-duotone ph-ghost gm-icon"></i><div class="gm-empty-title">' + t('empty_members') + '</div></div>';
            return;
        }

        var isSvsOrGvg = dbEventName === 'SvS' || dbEventName === 'GvG';
        var isDtr      = dbEventName === 'Defend Trade Route';
        var hasScore = EVENTS_WITHOUT_SCORE.indexOf(dbEventName) === -1;
        var done = participants.reduce(function (a, p) { return a + (p.participated || 0); }, 0);
        var appointedCount = participants.reduce(function (a, p) { return a + (p.appointed ? 1 : 0); }, 0);
        var totalScore = isSvsOrGvg
            ? participants.reduce(function (a, p) { return a + (p.score_prep || 0) + (p.score_pvp || 0) + (p.score || 0); }, 0)
            : participants.reduce(function (a, p) { return a + (p.score || 0); }, 0);

        var pendingCount = participants.reduce(function (a, p) { return a + (p.is_pending ? 1 : 0); }, 0);
        var approveAllBtn = pendingCount > 0
            ? '<button type="button" class="gm-btn gm-btn-sm gm-btn-success approve-all-btn" style="margin-left: auto; font-size: 0.8rem; padding: 0.25rem 0.5rem;"><i class="ph ph-check-square"></i> Approve All (' + pendingCount + ')</button>'
            : '';

        var html =
            '<div class="gm-row" style="gap:.5rem; margin-bottom:1rem; flex-wrap:wrap; justify-content:space-between; align-items: center;">' +
                '<div class="gm-row event-stats" style="gap:.5rem; flex-wrap:wrap; align-items: center; flex: 1;">' +
                    '<span class="gm-chip"><i class="ph-fill ph-users"></i> ' + participants.length + ' ' + t('event_total') + '</span>' +
                    '<span class="gm-chip gm-chip-success"><i class="ph-fill ph-check-circle"></i> ' + done + ' ' + t('event_participated') + '</span>' +
                    '<span class="gm-chip"><i class="ph-fill ph-x-circle"></i> ' + (participants.length - done) + ' ' + t('event_absent') + '</span>' +
                    (isDtr ? '<span class="gm-chip gm-chip-accent"><i class="ph-fill ph-check-square"></i> ' + appointedCount + ' Appointed</span>' : '') +
                    (hasScore ? '<span class="gm-chip gm-chip-accent"><i class="ph-fill ph-trophy"></i> ' + t('event_total_score') + ' ' + fmt(totalScore) + '</span>' : '') +
                    approveAllBtn +
                '</div>' +
                '<div class="gm-input-with-icon" style="min-width: 220px; max-width: 320px;">' +
                    '<i class="ph ph-magnifying-glass gm-icon"></i>' +
                    '<input type="text" class="gm-input event-search-input" placeholder="' + t('search_placeholder') + '">' +
                '</div>' +
                '</div>' +
            '<div class="gm-table-wrap"><div class="gm-table-scroll">' +
            '<table class="gm-table gm-resp-table">' +
                '<thead><tr>' +
                    '<th>' + t('col_member') + '</th>' +
                    '<th class="gm-center">' + t('col_participated') + '</th>' +
                    (isDtr ? '<th class="gm-center">Appointed</th>' : '') +
                    (isSvsOrGvg
                        ? '<th class="gm-right">' + t('col_score_prep') + '</th><th class="gm-right">' + t('col_score_pvp') + '</th>'
                        : (hasScore ? '<th class="gm-right">' + t('col_score') + '</th>' : '')) +
                    '<th class="gm-center">Actions</th>' +
                '</tr></thead><tbody>';

        participants.forEach(function (p) {
            var isChecked = p.participated > 0;
            var isAppointedChecked = !!p.appointed;
            var initial = window.RAD.avatarInit(p.pseudo);
            
            var rowClass = 'participant-row' + (isChecked ? ' participated' : '') + (p.is_pending ? ' pending-approval-row' : '');
            var rowStyle = p.is_pending ? 'background: rgba(245, 158, 11, 0.05); border-left: 3px solid var(--warning);' : '';

            var actionBtn = p.is_pending
                ? '<button type="button" class="gm-btn gm-btn-success approve-single-btn" data-pseudo="' + esc(p.pseudo) + '" style="font-size:0.75rem; padding:0.2rem 0.4rem; display:inline-flex; align-items:center; gap:0.25rem;"><i class="ph ph-check"></i> Approve</button>'
                : '';

            html +=
                '<tr class="' + rowClass + '" style="' + rowStyle + '" data-pseudo="' + esc(p.pseudo) + '">' +
                    '<td data-label="' + t('col_member') + '">' +
                        '<div class="gm-row" style="gap:.6rem;">' +
                            '<div class="gm-avatar">' + esc(initial) + '</div>' +
                            '<strong style="display:inline-flex; align-items:center; gap:0.4rem;">' + 
                                esc(p.pseudo) + 
                                (p.is_pending ? '<span class="gm-chip" style="font-size:0.65rem; padding:0.05rem 0.25rem; background:rgba(245,158,11,0.1); color:var(--warning); border:1px solid rgba(245,158,11,0.25);">Pending</span>' : '') +
                            '</strong>' +
                        '</div>' +
                    '</td>' +
                    '<td class="gm-center" data-label="' + t('col_participated') + '">' +
                        '<label class="participation-check">' +
                            '<input type="checkbox" class="participation-checkbox" data-pseudo="' + esc(p.pseudo) + '"' + (isChecked ? ' checked' : '') + '>' +
                            '<span class="check-mark"><i class="ph ph-check"></i></span>' +
                        '</label>' +
                    '</td>' +
                    (isDtr
                        ? '<td class="gm-center" data-label="Appointed">' +
                              '<label class="participation-check">' +
                                  '<input type="checkbox" class="participation-checkbox appointed-checkbox" data-pseudo="' + esc(p.pseudo) + '"' + (isAppointedChecked ? ' checked' : '') + '>' +
                                  '<span class="check-mark"><i class="ph ph-check"></i></span>' +
                              '</label>' +
                          '</td>'
                        : '') +
                    (isSvsOrGvg
                        ? '<td class="gm-right" data-label="' + t('col_score_prep') + '">' +
                              '<input type="text" inputmode="numeric" class="gm-score-input score-input-prep" value="' + (p.score_prep != null ? fmt(p.score_prep) : '') + '" placeholder="—" data-pseudo="' + esc(p.pseudo) + '">' +
                          '</td>' +
                          '<td class="gm-right" data-label="' + t('col_score_pvp') + '">' +
                              '<input type="text" inputmode="numeric" class="gm-score-input score-input-pvp" value="' + (p.score_pvp != null ? fmt(p.score_pvp) : '') + '" placeholder="—" data-pseudo="' + esc(p.pseudo) + '">' +
                          '</td>'
                        : (hasScore ? '<td class="gm-right" data-label="' + t('col_score') + '">' +
                              '<input type="text" inputmode="numeric" class="gm-score-input score-input" value="' + (p.score != null ? fmt(p.score) : '') + '" placeholder="—" data-pseudo="' + esc(p.pseudo) + '">' +
                          '</td>' : '')) +
                    '<td class="gm-center" data-label="Actions">' + actionBtn + '</td>' +
                '</tr>';
        });

        html += '</tbody></table></div></div>';
        el.innerHTML = html;

        el.querySelectorAll('.participation-checkbox:not(.appointed-checkbox)').forEach(function (cb) {
            cb.addEventListener('change', function () {
                var next = cb.checked ? 1 : 0;
                var row  = cb.closest('.participant-row');
                if (row) row.classList.toggle('participated', cb.checked);

                var pseudo = cb.getAttribute('data-pseudo');
                saveParticipation(tabKey, pseudo, next).then(function () {
                    var pp = state[tabKey].participants.find(function (x) { return x.pseudo === pseudo; });
                    if (pp) pp.participated = next;
                    refreshStats(el, tabKey);
                });
            });
        });

        el.querySelectorAll('.appointed-checkbox').forEach(function (cb) {
            cb.addEventListener('change', function () {
                var pseudo = cb.getAttribute('data-pseudo');
                var row  = cb.closest('.participant-row');
                var partCb = row ? row.querySelector('.participation-checkbox:not(.appointed-checkbox)') : null;

                var pp = state[tabKey].participants.find(function (x) { return x.pseudo === pseudo; });
                var promises = [];

                if (cb.checked && partCb && !partCb.checked) {
                    partCb.checked = true;
                    row.classList.add('participated');
                    promises.push(saveParticipation(tabKey, pseudo, 1).then(function () {
                        if (pp) pp.participated = 1;
                    }));
                }

                promises.push(saveAppointed(tabKey, pseudo, cb.checked).then(function () {
                    if (pp) pp.appointed = cb.checked;
                }));

                Promise.all(promises).then(function () {
                    refreshStats(el, tabKey);
                });
            });
        });

        function wireScoreInputs(selector, field, stateKey) {
            el.querySelectorAll(selector).forEach(function (inp) {
                window.RAD.attachNumberFormatter(inp);
                var timer;
                inp.addEventListener('input', function () {
                    clearTimeout(timer);
                    timer = setTimeout(function () {
                        var pseudo = inp.getAttribute('data-pseudo');
                        saveScoreField(tabKey, pseudo, field, inp.value).then(function () {
                            var pp = state[tabKey].participants.find(function (x) { return x.pseudo === pseudo; });
                            if (pp) pp[stateKey] = window.RAD.parseNumber(inp.value);
                            refreshStats(el, tabKey);
                        });
                    }, 700);
                });
            });
        }

        wireScoreInputs('.score-input',      'score',      'score');
        wireScoreInputs('.score-input-prep', 'score_prep', 'score_prep');
        wireScoreInputs('.score-input-pvp',  'score_pvp',  'score_pvp');

        var searchInput = el.querySelector('.event-search-input');
        if (searchInput) {
            searchInput.addEventListener('input', function (e) {
                var q = e.target.value.toLowerCase();
                el.querySelectorAll('.participant-row').forEach(function (row) {
                    var pseudo = row.getAttribute('data-pseudo').toLowerCase();
                    var uid = (uidMap[row.getAttribute('data-pseudo')] || '').toLowerCase();
                    row.style.display = (pseudo + ' ' + uid).indexOf(q) !== -1 ? '' : 'none';
                });
            });
        }

        el.querySelectorAll('.approve-single-btn').forEach(function (btn) {
            btn.addEventListener('click', async function () {
                var pseudo = btn.getAttribute('data-pseudo');
                btn.disabled = true;
                btn.textContent = '...';
                try {
                    await db.from('event_participants').update({ is_pending: false })
                        .eq('event_name', s.activeEventName)
                        .eq('session_id', s.sessionId)
                        .eq('pseudo', pseudo);
                    
                    var pp = state[tabKey].participants.find(function (x) { return x.pseudo === pseudo; });
                    if (pp) pp.is_pending = false;
                    renderParticipants(tabKey);
                } catch (err) {
                    showToast('Failed to approve submission.', 'error');
                    btn.disabled = false;
                    btn.textContent = 'Approve';
                }
            });
        });

        var approveAllBtnEl = el.querySelector('.approve-all-btn');
        if (approveAllBtnEl) {
            approveAllBtnEl.addEventListener('click', async function () {
                approveAllBtnEl.disabled = true;
                approveAllBtnEl.textContent = 'Approving...';
                try {
                    await db.from('event_participants').update({ is_pending: false })
                        .eq('event_name', s.activeEventName)
                        .eq('session_id', s.sessionId)
                        .eq('is_pending', true);
                    
                    state[tabKey].participants.forEach(function (p) {
                        if (p.is_pending) p.is_pending = false;
                    });
                    renderParticipants(tabKey);
                } catch (err) {
                    showToast('Failed to approve all submissions.', 'error');
                    approveAllBtnEl.disabled = false;
                    approveAllBtnEl.textContent = 'Approve All (' + pendingCount + ')';
                }
            });
        }
    }

    function refreshStats(el, tabKey) {
        var participants = state[tabKey].participants;
        var isSvsOrGvg = state[tabKey].activeEventName === 'SvS' || state[tabKey].activeEventName === 'GvG';
        var done = participants.reduce(function (a, p) { return a + (p.participated || 0); }, 0);
        var totalScore = isSvsOrGvg
            ? participants.reduce(function (a, p) { return a + (p.score_prep || 0) + (p.score_pvp || 0) + (p.score || 0); }, 0)
            : participants.reduce(function (a, p) { return a + (p.score || 0); }, 0);
        var chips = el.querySelectorAll('.event-stats .gm-chip');
        if (chips[1]) chips[1].innerHTML = '<i class="ph-fill ph-check-circle"></i> ' + done + ' ' + t('event_participated');
        if (chips[2]) chips[2].innerHTML = '<i class="ph-fill ph-x-circle"></i> ' + (participants.length - done) + ' ' + t('event_absent');

        var isDtr = state[tabKey].activeEventName === 'Defend Trade Route';
        if (isDtr) {
            var appointedCount = participants.reduce(function (a, p) { return a + (p.appointed ? 1 : 0); }, 0);
            if (chips[3]) chips[3].innerHTML = '<i class="ph-fill ph-check-square"></i> ' + appointedCount + ' Appointed';
        } else {
            var hasScore = EVENTS_WITHOUT_SCORE.indexOf(state[tabKey].activeEventName) === -1;
            if (hasScore && chips[3]) {
                chips[3].innerHTML = '<i class="ph-fill ph-trophy"></i> ' + t('event_total_score') + ' ' + fmt(totalScore);
            }
        }
    }



    // ── Wire START / END buttons ──────────────────────────────────────────
    // Ces événements demandent un jour + heure de début (UTC) au lancement :
    // alimente l'agenda Overview et les futurs rappels.
    var SCHEDULED_TABS = ['Defend Trade Route'];

    document.querySelectorAll('.event-start-btn[data-event]').forEach(function (btn) {
        var ev = btn.getAttribute('data-event');
        if (!TAB_TO_DB_EVENTS[ev]) return;

        btn.addEventListener('click', function () {
            if (SCHEDULED_TABS.indexOf(ev) !== -1) {
                window.RAD.pickEventStart({ eventLabel: ev }, function (startAt) {
                    if (!startAt) return; // annulé ⇒ on ne démarre pas
                    startEvent(ev, ev, null, startAt);
                });
            } else {
                startEvent(ev, ev, null);
            }
        });
    });

    document.querySelectorAll('.event-end-btn[data-event]').forEach(function (btn) {
        var ev = btn.getAttribute('data-event');
        if (!TAB_TO_DB_EVENTS[ev]) return;
        btn.addEventListener('click', function () { endEvent(ev); });
    });

})();
