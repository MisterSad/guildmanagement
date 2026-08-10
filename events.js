/**
 * events.js — SvS, GvG, DTR, Arms Race (A & B fusionnés).
 * Chaque START crée une nouvelle session (timestamp). END termine la session courante.
 * Le DTR n'a pas de score, seulement une participation.
 */
(function () {

    function getDb() { return (window.GM && window.GM.db) ? window.GM.db : null; }
    var t    = window.GM ? window.GM.t  : function (k) { return k; };
    var esc  = window.GM ? window.GM.escapeHTML : function (s) { return s; };
    var fmt  = window.GM ? window.GM.formatNumber : function (n) { return String(n); };

    // event_name "logique" → event_name côté DB (Arms Race a 2 stages)
    var STANDARD_EVENTS = ['SvS', 'GvG', 'Defend Trade Route'];

    // Onglet UI → liste d'event_names DB qu'il pilote
    var TAB_TO_DB_EVENTS = {
        'SvS':                ['SvS'],
        'GvG':                ['GvG'],
        // Un seul event_name pour DTR : 'Defend Trade Route'.
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
    window.GM_EVENTS = {
        loadEvent: loadEvent,
        addMemberToActiveEvents: addMemberToActiveEvents,
        removeMemberFromActiveEvents: removeMemberFromActiveEvents
    };

    // ── Load event (called when tab is clicked) ────────────────────────────
    async function loadEvent(tabKey) {
        var db = getDb();
        if (!db || !TAB_TO_DB_EVENTS[tabKey]) return;
        try {
            var dbEvents = TAB_TO_DB_EVENTS[tabKey];
            var currentG = window.GM ? window.GM.getActiveGuild() : 'ALPHA';
            var query = db.from('event_status').select('event_name, is_active, session_id, stage, start_at')
                .in('event_name', dbEvents);

            query = query.eq('guild', currentG);
            var res = await query;

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
        var db = getDb();
        if (!db) return;
        var currentG = window.GM ? window.GM.getActiveGuild() : 'ALPHA';
        var ref = startAt || new Date();
        // Fetch existing session_ids for this guild+event to resolve same-day collisions.
        // buildEventSessionId will return base-1, base-2, etc. as needed.
        var existingRes = await db.from('event_participants')
            .select('session_id')
            .eq('guild', currentG)
            .eq('event_name', dbEventName);
        var existingIds = (existingRes.data || []).map(function (r) { return r.session_id; });
        var sessionId = window.GM.buildEventSessionId(dbEventName, ref, existingIds);
        try {
            var statusRes = await db.from('event_status').upsert(
                {
                    guild:      currentG,
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
            window.GM.showToast(t('event_session_started'), 'success');

            if (window.GM.notifyDiscordEvent) {
                window.GM.notifyDiscordEvent(dbEventName, startAt || sessionId, 'start');
            }
        } catch (err) {
            console.error('startEvent', err);
            window.GM.showToast(t('toast_err_generic') + ' ' + err.message, 'error');
        }
        await loadEvent(tabKey);
    }

    // ── Arrêt de la session courante ──────────────────────────────────────
    async function endEvent(tabKey) {
        var db = getDb();
        if (!db) return;
        var s = state[tabKey];
        if (!s.activeEventName) return;
        var currentG = window.GM ? window.GM.getActiveGuild() : 'ALPHA';

        try {
            var statusRes = await db.from('event_status').upsert(
                {
                    guild:      currentG,
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
            window.GM.showToast(t('event_session_ended'), 'success');
        } catch (err) {
            console.error('endEvent', err);
            window.GM.showToast(t('toast_err_generic') + ' ' + err.message, 'error');
        }
    }

    // ── Auto-populate members pour une nouvelle session ──────────────────
    // Utilise la RPC gm_populate_event_participants pour contourner les problèmes
    // de schema cache PostgREST et garantir l'exécution atomique côté DB.
    async function populateParticipants(tabKey) {
        var db = getDb();
        if (!db) return;
        var s = state[tabKey];
        if (!s.activeEventName || !s.sessionId) return;

        var week = window.GM.getWeekStart(s.startAt);
        var currentG = window.GM ? window.GM.getActiveGuild() : 'ALPHA';
        var rpcRes = await db.rpc('gm_populate_event_participants', {
            p_event_name: s.activeEventName,
            p_session_id: s.sessionId,
            p_week_start: week,
            p_guild: currentG
        });

        if (rpcRes.error) {
            console.error('populateParticipants: rpc error', rpcRes.error);
            window.GM.showToast(t('toast_err_import_participants') + ' ' + rpcRes.error.message, 'error');
            return;
        }

        var inserted = (typeof rpcRes.data === 'number') ? rpcRes.data : 0;
        if (inserted > 0) {
            window.GM.showToast(inserted + ' ' + t('toast_members_imported'), 'success');
        }
        await fetchParticipants(tabKey);
    }

    // ── Ajout dynamique d'un membre aux événements actifs ─────────────────
    // La RPC gm_add_member_to_active_events fait l'écriture DB de façon
    // fiable (les upserts client échouaient sur l'index partiel
    // event_participants_session_unique -> le membre n'était jamais ajouté).
    // Ce helper ne sert plus qu'à synchroniser l'état mémoire des onglets
    // ouverts avec le membre nouvellement inséré.
    // Retourne le nombre d'events actifs concernés (pour information).
    async function addMemberToActiveEvents(pseudo) {
        var db = getDb();
        if (!db || !pseudo) return 0;

        var dbEventNames = [];
        Object.keys(TAB_TO_DB_EVENTS).forEach(function (k) {
            TAB_TO_DB_EVENTS[k].forEach(function (n) { dbEventNames.push(n); });
        });

        try {
            var currentG = window.GM ? window.GM.getActiveGuild() : 'ALPHA';
            var statusRes = await db.from('event_status')
                .select('event_name, session_id, start_at')
                .eq('guild', currentG)
                .eq('is_active', true)
                .in('event_name', dbEventNames);
            if (statusRes.error) throw statusRes.error;

            var active = (statusRes.data || []).filter(function (r) { return r.session_id; });
            if (active.length === 0) return 0;

            // Sync UI : pour chaque onglet ouvert dont la session courante est active,
            // ajoute le membre en mémoire et re-rendu (le DB est déjà à jour via la RPC).
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
                    week_start:   window.GM.getWeekStart(matched.start_at || new Date()),
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

    function removeMemberFromActiveEvents(pseudo) {
        Object.keys(state).forEach(function (tabKey) {
            var s = state[tabKey];
            if (s.participants) {
                s.participants = s.participants.filter(function (p) { return p.pseudo !== pseudo; });
                if (s.isActive) {
                    renderStatus(tabKey);
                    renderParticipants(tabKey);
                }
            }
        });
    }

    // ── Fetch participants de la session active ──────────────────────────
    async function fetchParticipants(tabKey) {
        var db = getDb();
        if (!db) return;
        var s = state[tabKey];
        if (!s.activeEventName || !s.sessionId) return;
        var currentG = window.GM ? window.GM.getActiveGuild() : 'ALPHA';
        var [partRes, memRes] = await Promise.all([
            db.from('event_participants').select('*')
                .eq('guild', currentG)
                .eq('event_name', s.activeEventName)
                .eq('session_id', s.sessionId)
                .order('pseudo', { ascending: true }),
            db.from('guild_members').select('pseudo, uid').eq('guild', currentG)
        ]);
        if (partRes.error) return;
        (memRes.data || []).forEach(function (m) { uidMap[m.pseudo] = m.uid; });
        s.participants = partRes.data || [];
        renderParticipants(tabKey);
    }

    // ── Save participation / score ────────────────────────────────────────
    async function saveParticipation(tabKey, pseudo, value) {
        var db = getDb();
        if (!db) return;
        var s = state[tabKey];
        var currentG = window.GM ? window.GM.getActiveGuild() : 'ALPHA';
        await db.from('event_participants').update({ participated: value })
            .eq('guild', currentG)
            .eq('event_name', s.activeEventName)
            .eq('session_id', s.sessionId)
            .eq('pseudo', pseudo);
    }

    async function saveAppointed(tabKey, pseudo, value) {
        var db = getDb();
        if (!db) return;
        var s = state[tabKey];
        var currentG = window.GM ? window.GM.getActiveGuild() : 'ALPHA';
        await db.from('event_participants').update({ appointed: value })
            .eq('guild', currentG)
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
        var db = getDb();
        if (!db) return;
        var s = state[tabKey];
        var currentG = window.GM ? window.GM.getActiveGuild() : 'ALPHA';
        var num = window.GM.parseNumber(value);
        var update = {};
        update[field] = num;
        await db.from('event_participants').update(update)
            .eq('guild', currentG)
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

    // These events require an admin-set UTC start date before launching.
    // SvS and GvG are included so the ISO week is always explicit and reliable.
    var SCHEDULED_TABS = ['SvS', 'GvG', 'Defend Trade Route'];

    async function editEventSchedule(tabKey) {
        var db = getDb();
        if (!db) return;
        var s = state[tabKey];
        if (!s.activeEventName || !s.sessionId) return;
        
        var currentG = window.GM ? window.GM.getActiveGuild() : 'ALPHA';
        try {
            var res = await db.from('event_status').select('start_at')
                .eq('guild', currentG)
                .eq('event_name', s.activeEventName).maybeSingle();
            if (res.error) throw res.error;
            
            var currentStartAt = res.data ? res.data.start_at : null;
            
            window.GM.pickEventStart({ 
                eventLabel: s.activeEventName + ' — ' + t('edit_title'), 
                defaultVal: currentStartAt 
            }, async function (startAt) {
                if (!startAt) return;
                
                try {
                    var updateRes = await db.from('event_status').update({
                        start_at: startAt,
                        updated_at: new Date().toISOString()
                    }).eq('guild', currentG)
                      .eq('event_name', s.activeEventName);
                    if (updateRes.error) throw updateRes.error;

                    var newWeek = window.GM.getWeekStart(startAt);
                    var updatePartRes = await db.from('event_participants').update({
                        week_start: newWeek
                    }).eq('guild', currentG)
                      .eq('event_name', s.activeEventName)
                      .eq('session_id', s.sessionId);
                    if (updatePartRes.error) throw updatePartRes.error;

                    // Recalculate session_id from the new date (weekly events: ISO week
                    // may change; daily events: YYYYMMDD base changes). Pass [] for
                    // existingIds because we are renaming an existing session, not
                    // creating a new one, so no collision check is needed.
                    var newSessionId = window.GM.buildEventSessionId(s.activeEventName, new Date(startAt), []);
                    if (newSessionId !== s.sessionId) {
                        var updateSidPartRes = await db.from('event_participants').update({
                            session_id: newSessionId
                        }).eq('guild', currentG)
                          .eq('event_name', s.activeEventName)
                          .eq('session_id', s.sessionId);
                        if (updateSidPartRes.error) throw updateSidPartRes.error;

                        var updateSidStatusRes = await db.from('event_status').update({
                            session_id: newSessionId
                        }).eq('guild', currentG)
                          .eq('event_name', s.activeEventName);
                        if (updateSidStatusRes.error) throw updateSidStatusRes.error;

                        s.sessionId = newSessionId;
                    }
                    
                    window.GM.showToast(t('toast_member_updated'), 'success');
                    
                    if (window.GM.notifyDiscordEvent) {
                        window.GM.notifyDiscordEvent(s.activeEventName, startAt, 'edit');
                    }

                    await loadEvent(tabKey);
                } catch (err) {
                    console.error('editEventSchedule update', err);
                    window.GM.showToast(t('toast_err_generic') + ' ' + err.message, 'error');
                }
            });
        } catch (err) {
            console.error('editEventSchedule fetch', err);
            window.GM.showToast(t('toast_err_generic') + ' ' + err.message, 'error');
        }
    }

    function deleteEventSession(tabKey) {
        var db = getDb();
        if (!db) return;
        var s = state[tabKey];
        if (!s.activeEventName || !s.sessionId) return;
        
        window.showConfirm(
            t('confirm_delete_session_title'),
            '<strong>' + esc(s.activeEventName) + '</strong><br>' + t('confirm_delete_session_body'),
            async function () {
                try {
                    var currentG = window.GM ? window.GM.getActiveGuild() : 'ALPHA';
                    var delPartRes = await db.from('event_participants')
                        .delete()
                        .eq('guild', currentG)
                        .eq('event_name', s.activeEventName)
                        .eq('session_id', s.sessionId);
                    if (delPartRes.error) throw delPartRes.error;
                    
                    var delStatusRes = await db.from('event_status')
                        .delete()
                        .eq('guild', currentG)
                        .eq('event_name', s.activeEventName);
                    if (delStatusRes.error) throw delStatusRes.error;
                    
                    window.GM.showToast(t('toast_session_deleted'), 'success');
                    
                    s.activeEventName = null;
                    s.sessionId       = null;
                    s.stage           = null;
                    s.isActive        = false;
                    renderStatus(tabKey);
                    renderInactive(tabKey);
                } catch (err) {
                    console.error('deleteEventSession', err);
                    window.GM.showToast(t('toast_err_generic') + ' ' + err.message, 'error');
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

        var statusLine = panel.querySelector('.gm-event-status-line');
        if (statusLine) {
            var dimSpan = statusLine.querySelector('.gm-dim-time');
            if (!dimSpan) {
                dimSpan = document.createElement('span');
                dimSpan.className = 'gm-dim gm-dim-time';
                dimSpan.style.fontSize = '0.8rem';
                dimSpan.style.color = 'var(--text-muted)';
                dimSpan.style.marginLeft = '0.5rem';
                statusLine.appendChild(dimSpan);
            }
            dimSpan.textContent = (s.isActive && s.startAt) ? ' · ' + window.GM.formatDateTimeUTC(s.startAt) : '';
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
                            window.GM.pickEventStart({ eventLabel: tabKey }, function (startAt) {
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
                    (pendingCount > 0 ? '<th class="gm-center">Actions</th>' : '') +
                '</tr></thead><tbody>';

        participants.forEach(function (p) {
            var isChecked = p.participated > 0;
            var isAppointedChecked = !!p.appointed;
            var initial = window.GM.avatarInit(p.pseudo);
            
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
                        '<label class="check-toggle">' +
                            '<input type="checkbox" class="participation-checkbox" data-pseudo="' + esc(p.pseudo) + '"' + (isChecked ? ' checked' : '') + '>' +
                            '<span class="check-slider"></span>' +
                        '</label>' +
                    '</td>' +
                    (isDtr
                        ? '<td class="gm-center" data-label="Appointed">' +
                              '<label class="check-toggle">' +
                                  '<input type="checkbox" class="participation-checkbox appointed-checkbox" data-pseudo="' + esc(p.pseudo) + '"' + (isAppointedChecked ? ' checked' : '') + '>' +
                                  '<span class="check-slider"></span>' +
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
                    (pendingCount > 0 ? '<td class="gm-center" data-label="Actions">' + actionBtn + '</td>' : '') +
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
                window.GM.attachNumberFormatter(inp);
                var timer;
                inp.addEventListener('input', function () {
                    clearTimeout(timer);
                    timer = setTimeout(function () {
                        var pseudo = inp.getAttribute('data-pseudo');
                        saveScoreField(tabKey, pseudo, field, inp.value).then(function () {
                            var pp = state[tabKey].participants.find(function (x) { return x.pseudo === pseudo; });
                            if (pp) pp[stateKey] = window.GM.parseNumber(inp.value);
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
                    // Approval via a SECURITY DEFINER RPC: the active session
                    // is resolved server-side, so a stale client state can no
                    // longer make the update silently match nothing.
                    var rpcRes = await db.rpc('gm_approve_participant_submission', {
                        p_guild: window.GM ? window.GM.getActiveGuild() : 'ALPHA',
                        p_event_name: s.activeEventName,
                        p_session_id: s.sessionId,
                        p_pseudo: pseudo
                    });
                    if (rpcRes.error) throw rpcRes.error;
                    var data = rpcRes.data;
                    var ok = data && (data.ok !== false);
                    if (!ok) throw new Error((data && data.error) || 'approve_failed');

                    var pp = state[tabKey].participants.find(function (x) { return x.pseudo === pseudo; });
                    if (pp) pp.is_pending = false;
                    renderParticipants(tabKey);
                    // Reload from the DB so the UI reflects the real pending state.
                    await fetchParticipants(tabKey);
                } catch (err) {
                    console.error('approve single', err);
                    (window.GM && window.GM.showToast ? window.GM.showToast : function () {})('Failed to approve submission.', 'error');
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
                var pendingPseudos = state[tabKey].participants.filter(function (p) { return p.is_pending; }).map(function (p) { return p.pseudo; });
                try {
                    // Approve every pending player via the SECURITY DEFINER RPC.
                    for (var pi = 0; pi < pendingPseudos.length; pi++) {
                        var rpcRes = await db.rpc('gm_approve_participant_submission', {
                            p_guild: window.GM ? window.GM.getActiveGuild() : 'ALPHA',
                            p_event_name: s.activeEventName,
                            p_session_id: s.sessionId,
                            p_pseudo: pendingPseudos[pi]
                        });
                        if (rpcRes.error) throw rpcRes.error;
                    }
                    state[tabKey].participants.forEach(function (p) {
                        if (p.is_pending) p.is_pending = false;
                    });
                    renderParticipants(tabKey);
                    // Reload from the DB so the UI reflects the real pending state.
                    await fetchParticipants(tabKey);
                } catch (err) {
                    console.error('approve all', err);
                    (window.GM && window.GM.showToast ? window.GM.showToast : function () {})('Failed to approve all submissions.', 'error');
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



})();
