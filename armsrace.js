/**
 * armsrace.js — Arms Race: Stage A & Stage B launched independently.
 */
(function () {

    var db  = window.RAD ? window.RAD.db : null;
    var t   = window.RAD ? window.RAD.t  : function (k) { return k; };
    var esc = window.RAD ? window.RAD.escapeHTML : function (s) { return s; };

    var STAGE_EVENTS = { stageA: 'ARMS RACE STAGE A', stageB: 'ARMS RACE STAGE B' };

    var arState = {
        stages: {
            stageA: { active: false, sessionId: null, startAt: null, participants: [] },
            stageB: { active: false, sessionId: null, startAt: null, participants: [] }
        },
        uidMap: {}
    };

    var arActiveStage = 'stageA'; // 'stageA' | 'stageB'

    window.RAD_ARMSRACE = { 
        load: loadArmsRace,
        addMemberToActiveEvents: addMemberToActiveEvents
    };

    function stageLabel(stageKey) { return stageKey === 'stageA' ? 'Stage A' : 'Stage B'; }

    async function loadArmsRace() {
        if (!db) return;
        try {
            var [statusRes, membersRes] = await Promise.all([
                db.from('event_status').select('event_name, is_active, session_id, start_at')
                    .in('event_name', [STAGE_EVENTS.stageA, STAGE_EVENTS.stageB]),
                db.from('guild_members').select('pseudo, uid')
            ]);

            ['stageA', 'stageB'].forEach(function (k) {
                var row = (statusRes.data || []).find(function (r) { return r.event_name === STAGE_EVENTS[k]; });
                arState.stages[k].active = row ? !!row.is_active : false;
                arState.stages[k].sessionId = row ? row.session_id : null;
                arState.stages[k].startAt = row ? row.start_at : null;
            });

            arState.uidMap = {};
            (membersRes.data || []).forEach(function (m) { arState.uidMap[m.pseudo] = m.uid; });

            // fetch participants for active stages
            var sids = ['stageA', 'stageB']
                .map(function(k) { return arState.stages[k].sessionId; })
                .filter(Boolean);

            if (sids.length) {
                var partRes = await db.from('event_participants').select('*')
                    .in('event_name', [STAGE_EVENTS.stageA, STAGE_EVENTS.stageB])
                    .in('session_id', sids)
                    .order('pseudo', { ascending: true });
                var parts = partRes.data || [];
                
                ['stageA', 'stageB'].forEach(function(k) {
                    var evName = STAGE_EVENTS[k];
                    var sid = arState.stages[k].sessionId;
                    arState.stages[k].participants = parts.filter(function(p) {
                        return p.event_name === evName && p.session_id === sid;
                    });
                });
            } else {
                arState.stages.stageA.participants = [];
                arState.stages.stageB.participants = [];
            }

            renderArmsRace();
        } catch (err) { console.error('loadArmsRace', err); }
    }

    async function startStage(stageKey, startAt) {
        if (!db) return;
        var sessionId = window.RAD.newSessionId();
        var evName = STAGE_EVENTS[stageKey];
        var stageLetter = stageKey === 'stageA' ? 'A' : 'B';
        
        try {
            var res = await db.from('event_status').upsert(
                {
                    event_name: evName,
                    is_active:  true,
                    session_id: sessionId,
                    start_at:   startAt || null,
                    stage:      stageLetter,
                    updated_at: new Date().toISOString()
                },
                { onConflict: 'guild,event_name' }
            );
            if (res.error) throw res.error;

            // populate participants
            var week = window.RAD.getWeekStart(startAt);
            var rpcRes = await db.rpc('populate_event_participants', {
                p_event_name: evName,
                p_session_id: sessionId,
                p_week_start: week
            });

            if (rpcRes.error) throw rpcRes.error;

            window.RAD.showToast('Arms Race ' + stageLabel(stageKey) + ' — ' + (t('event_started') || 'Démarré'), 'success');

            if (window.RAD.notifyDiscordEvent) {
                window.RAD.notifyDiscordEvent(evName, startAt || sessionId, 'start');
            }
        } catch (err) {
            console.error('startStage', err);
            window.RAD.showToast(t('toast_err_generic') + ' ' + err.message, 'error');
        }
        await loadArmsRace();
    }

    async function endStage(stageKey) {
        if (!db) return;
        var stg = arState.stages[stageKey];
        if (!stg.active) return;
        
        try {
            await db.from('event_status').upsert(
                {
                    event_name: STAGE_EVENTS[stageKey],
                    is_active:  false,
                    session_id: stg.sessionId,
                    start_at:   null,
                    stage:      stageKey === 'stageA' ? 'A' : 'B',
                    updated_at: new Date().toISOString()
                },
                { onConflict: 'guild,event_name' }
            );
        } catch (err) { console.error('endStage', err); }
        
        window.RAD.showToast(t('event_session_ended'), 'success');
        await loadArmsRace();
    }

    async function editStageSchedule(stageKey) {
        if (!db) return;
        var stg = arState.stages[stageKey];
        if (!stg || !stg.active || !stg.sessionId) return;

        try {
            var res = await db.from('event_status').select('start_at')
                .eq('event_name', STAGE_EVENTS[stageKey]).single();
            if (res.error) throw res.error;

            var currentStartAt = res.data ? res.data.start_at : null;

            window.RAD.pickEventStart({
                eventLabel: 'Arms Race ' + stageLabel(stageKey) + ' — ' + t('edit_title'),
                defaultVal: currentStartAt
            }, async function (startAt) {
                if (!startAt) return;

                try {
                    var updateRes = await db.from('event_status').update({
                        start_at: startAt,
                        updated_at: new Date().toISOString()
                    }).eq('event_name', STAGE_EVENTS[stageKey]);
                    if (updateRes.error) throw updateRes.error;

                    var newWeek = window.RAD.getWeekStart(startAt);
                    var updatePartRes = await db.from('event_participants').update({
                        week_start: newWeek
                    }).eq('event_name', STAGE_EVENTS[stageKey])
                      .eq('session_id', stg.sessionId);
                    if (updatePartRes.error) throw updatePartRes.error;

                    window.RAD.showToast(t('toast_member_updated'), 'success');

                    if (window.RAD.notifyDiscordEvent) {
                        window.RAD.notifyDiscordEvent(STAGE_EVENTS[stageKey], startAt, 'edit');
                    }

                    await loadArmsRace();
                } catch (err) {
                    console.error('editStageSchedule update', err);
                    window.RAD.showToast(t('toast_err_generic') + ' ' + err.message, 'error');
                }
            });
        } catch (err) {
            console.error('editStageSchedule fetch', err);
            window.RAD.showToast(t('toast_err_generic') + ' ' + err.message, 'error');
        }
    }

    function deleteStageSession(stageKey) {
        if (!db) return;
        var stg = arState.stages[stageKey];
        if (!stg || !stg.sessionId) return;

        window.showConfirm(
            t('confirm_delete_session_title'),
            '<strong>Arms Race ' + esc(stageLabel(stageKey)) + '</strong><br>' + t('confirm_delete_session_body'),
            async function () {
                try {
                    var delPartRes = await db.from('event_participants')
                        .delete()
                        .eq('event_name', STAGE_EVENTS[stageKey])
                        .eq('session_id', stg.sessionId);
                    if (delPartRes.error) throw delPartRes.error;

                    var delStatusRes = await db.from('event_status')
                        .delete()
                        .eq('event_name', STAGE_EVENTS[stageKey]);
                    if (delStatusRes.error) throw delStatusRes.error;

                    window.RAD.showToast(t('toast_account_deleted'), 'success');
                    await loadArmsRace();
                } catch (err) {
                    console.error('deleteStageSession', err);
                    window.RAD.showToast(t('toast_err_generic') + ' ' + err.message, 'error');
                }
            }
        );
    }

    async function saveParticipation(pseudo, value) {
        if (!db) return;
        var stg = arState.stages[arActiveStage];
        await db.from('event_participants').update({ participated: value })
            .eq('event_name', STAGE_EVENTS[arActiveStage])
            .eq('session_id', stg.sessionId)
            .eq('pseudo', pseudo);
    }

    async function addMemberToActiveEvents(pseudo) {
        if (!db || !pseudo) return 0;
        try {
            var active = ['stageA', 'stageB'].filter(function(k) { return arState.stages[k].active && arState.stages[k].sessionId; });
            if (active.length === 0) return 0;
            
            var rows = active.map(function(k) {
                var stg = arState.stages[k];
                return {
                    event_name: STAGE_EVENTS[k],
                    session_id: stg.sessionId,
                    week_start: window.RAD.getWeekStart(stg.startAt || new Date(stg.sessionId)),
                    pseudo: pseudo,
                    participated: 0,
                    score: null
                };
            });
            var insRes = await db.from('event_participants').insert(rows);
            if (insRes.error) throw insRes.error;
            
            active.forEach(function(k) {
                var stg = arState.stages[k];
                if (stg.participants.some(function (p) { return p.pseudo === pseudo; })) return;
                stg.participants.push({
                    event_name: STAGE_EVENTS[k],
                    session_id: stg.sessionId,
                    week_start: window.RAD.getWeekStart(stg.startAt || new Date(stg.sessionId)),
                    pseudo: pseudo,
                    participated: 0,
                    score: null
                });
                stg.participants.sort(function(a,b) { return String(a.pseudo).localeCompare(String(b.pseudo)); });
            });
            if (arState.stages[arActiveStage].active) renderArmsRace();
            return active.length;
        } catch (err) {
            console.error('addMemberToActiveEvents AR', err);
            return 0;
        }
    }

    function renderArmsRace() {
        var area = document.querySelector('#event-arms-race .event-participants-area');
        if (!area) return;

        var stg = arState.stages[arActiveStage];
        var stgLabel = stageLabel(arActiveStage);
        var isActive = stg.active;
        
        var statusBadgeClass = isActive ? 'gm-chip-success active' : 'gm-chip-muted';
        var statusText = isActive ? t('event_active') : t('event_inactive');
        var dotColor = isActive ? 'var(--success)' : 'var(--fg-dim)';
        var subText = stg.startAt 
            ? window.RAD.formatDateTimeUTC(stg.startAt)
            : (isActive ? t('event_active') : t('event_not_active_hint'));

        var html =
            '<div class="sf-main-tabs">' +
                '<button class="sf-main-tab stageA' + (arActiveStage === 'stageA' ? ' active' : '') + '" data-stage="stageA"><i class="ph ph-target"></i> Stage A</button>' +
                '<button class="sf-main-tab stageB' + (arActiveStage === 'stageB' ? ' active' : '') + '" data-stage="stageB"><i class="ph ph-target"></i> Stage B</button>' +
            '</div>';

        html +=
            '<div class="gm-event-banner" style="display: flex; margin-bottom: 1.5rem; background: var(--card-bg); border: 1px solid var(--card-border); border-radius: var(--radius-lg); padding: 1rem 1.5rem; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 1rem;">' +
                '<div class="gm-event-meta" style="display: flex; align-items: center; gap: 1rem; flex: 1; min-width: 250px;">' +
                    '<div class="gm-event-icon" style="width: 48px; height: 48px; border-radius: 50%; background: ' + (isActive ? 'var(--primary-soft)' : 'rgba(255,255,255,0.05)') + '; color: ' + (isActive ? 'var(--primary)' : 'var(--text-muted)') + '; display: flex; align-items: center; justify-content: center; font-size: 1.5rem;"><i class="ph ph-target"></i></div>' +
                    '<div class="gm-grow" style="display: flex; flex-direction: column; gap: 0.25rem;">' +
                        '<div class="gm-event-name" style="font-size: 1.2rem; font-weight: 700; font-family: var(--font-family-title);">Arms Race ' + esc(stgLabel) + '</div>' +
                        '<div class="gm-event-status-line" style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">' +
                            '<span class="event-status-badge gm-chip ' + statusBadgeClass + '" style="display: inline-flex; align-items: center; gap: 0.35rem; font-size: 0.78rem;"><span class="gm-dot" style="background: ' + dotColor + '; width: 8px; height: 8px; border-radius: 50%;"></span> ' + statusText + '</span>' +
                            '<span class="gm-dim" style="font-size: 0.8rem; color: var(--text-muted);">' + esc(subText) + '</span>' +
                        '</div>' +
                    '</div>' +
                '</div>' +
                '<div class="gm-event-actions" style="display: flex; gap: 0.5rem;">' +
                    (isActive ? 
                        '<button class="gm-btn gm-btn-danger event-end-btn ar-stage-end-btn" data-stage="' + arActiveStage + '" style="margin-right: 0.25rem;"><i class="ph ph-stop-circle"></i> <span>' + t('event_end') + '</span></button>' +
                        '<button class="gm-btn ar-stage-edit-btn" style="background: rgba(99,102,241,0.15); border: 1px solid rgba(99,102,241,0.3); color: #a5b4fc; margin-right: 0.25rem;" data-stage="' + arActiveStage + '" title="' + t('edit_title') + '"><i class="ph ph-calendar"></i> <span>' + t('edit_title') + '</span></button>' +
                        '<button class="gm-btn ar-stage-delete-btn" style="background: rgba(239,68,68,0.12); border: 1px solid rgba(239,68,68,0.25); color: var(--error);" data-stage="' + arActiveStage + '" title="' + t('delete_title') + '"><i class="ph ph-trash"></i></button>'
                    :
                        '<button class="gm-btn gm-btn-success event-start-btn ar-stage-start-btn" data-stage="' + arActiveStage + '"><i class="ph ph-play"></i> <span>' + t('event_start') + '</span></button>' +
                        '<button class="gm-btn gm-btn-danger event-end-btn ar-stage-end-btn" data-stage="' + arActiveStage + '" disabled><i class="ph ph-stop-circle"></i> <span>' + t('event_end') + '</span></button>'
                    ) +
                '</div>' +
            '</div>';

        if (!isActive) {
            html +=
                '<div class="gm-empty" style="margin-top: 2rem;">' +
                    '<i class="ph-duotone ph-rocket-launch gm-icon"></i>' +
                    '<div class="gm-empty-title">' + t('event_not_active') + '</div>' +
                    '<div class="gm-empty-hint">' + t('event_not_active_hint') + '</div>' +
                '</div>';
            area.innerHTML = html;
            attachARListeners(area);
            return;
        }

        var participants = stg.participants;
        if (!participants.length) {
            html += '<div class="gm-empty"><i class="ph-duotone ph-ghost gm-icon"></i><div class="gm-empty-title">' + t('empty_members') + '</div></div>';
            area.innerHTML = html;
            attachARListeners(area);
            return;
        }

        var done = participants.reduce(function (a, p) { return a + (p.participated || 0); }, 0);

        html +=
            '<div class="gm-row" style="gap:.5rem; margin-bottom:1rem; flex-wrap:wrap; justify-content:space-between;">' +
                '<div class="gm-row event-stats" style="gap:.5rem; flex-wrap:wrap;">' +
                    '<span class="gm-chip"><i class="ph-fill ph-users"></i> ' + participants.length + ' ' + t('event_total') + '</span>' +
                    '<span class="gm-chip gm-chip-success"><i class="ph-fill ph-check-circle"></i> ' + done + ' ' + t('event_participated') + '</span>' +
                    '<span class="gm-chip"><i class="ph-fill ph-x-circle"></i> ' + (participants.length - done) + ' ' + t('event_absent') + '</span>' +
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
                '</tr></thead><tbody>';

        participants.forEach(function (p) {
            var isChecked = p.participated > 0;
            var initial = window.RAD.avatarInit(p.pseudo);
            html +=
                '<tr class="participant-row' + (isChecked ? ' participated' : '') + '" data-pseudo="' + esc(p.pseudo) + '">' +
                    '<td data-label="' + t('col_member') + '">' +
                        '<div class="gm-row" style="gap:.6rem;">' +
                            '<div class="gm-avatar">' + esc(initial) + '</div>' +
                            '<strong>' + esc(p.pseudo) + '</strong>' +
                        '</div>' +
                    '</td>' +
                    '<td class="gm-center" data-label="' + t('col_participated') + '">' +
                        '<label class="participation-check">' +
                            '<input type="checkbox" class="participation-checkbox" data-pseudo="' + esc(p.pseudo) + '"' + (isChecked ? ' checked' : '') + '>' +
                            '<span class="check-mark"><i class="ph ph-check"></i></span>' +
                        '</label>' +
                    '</td>' +
                '</tr>';
        });

        html += '</tbody></table></div></div>';
        area.innerHTML = html;
        attachARListeners(area);
    }

    function attachARListeners(area) {
        area.querySelectorAll('.sf-main-tab').forEach(function (btn) {
            btn.addEventListener('click', function () {
                arActiveStage = btn.getAttribute('data-stage');
                renderArmsRace();
            });
        });

        var startBtn = area.querySelector('.ar-stage-start-btn');
        if (startBtn) {
            startBtn.addEventListener('click', function () {
                var stageKey = startBtn.getAttribute('data-stage');
                window.RAD.pickEventStart({ eventLabel: 'Arms Race ' + stageLabel(stageKey) }, function (startAt) {
                    if (!startAt) return; // annulé
                    startStage(stageKey, startAt);
                });
            });
        }

        var endBtn = area.querySelector('.ar-stage-end-btn');
        if (endBtn) {
            endBtn.addEventListener('click', function () {
                var stageKey = endBtn.getAttribute('data-stage');
                window.showConfirm(
                    t('event_end'),
                    '<strong>Arms Race ' + stageLabel(stageKey) + '</strong><br>' + t('event_session_ended'),
                    function () {
                        endStage(stageKey);
                    }
                );
            });
        }

        var editBtn = area.querySelector('.ar-stage-edit-btn');
        if (editBtn) {
            editBtn.addEventListener('click', function () {
                var stageKey = editBtn.getAttribute('data-stage');
                editStageSchedule(stageKey);
            });
        }

        var deleteBtn = area.querySelector('.ar-stage-delete-btn');
        if (deleteBtn) {
            deleteBtn.addEventListener('click', function () {
                var stageKey = deleteBtn.getAttribute('data-stage');
                deleteStageSession(stageKey);
            });
        }

        area.querySelectorAll('.participation-checkbox').forEach(function (cb) {
            cb.addEventListener('change', function () {
                var next = cb.checked ? 1 : 0;
                var row  = cb.closest('.participant-row');
                if (row) row.classList.toggle('participated', cb.checked);

                var pseudo = cb.getAttribute('data-pseudo');
                saveParticipation(pseudo, next).then(function () {
                    var pp = arState.stages[arActiveStage].participants.find(function (p) { return p.pseudo === pseudo; });
                    if (pp) pp.participated = next;
                    refreshStats(area);
                });
            });
        });

        var searchInput = area.querySelector('.event-search-input');
        if (searchInput) {
            searchInput.addEventListener('input', function (e) {
                var q = e.target.value.toLowerCase();
                area.querySelectorAll('.participant-row').forEach(function (row) {
                    var pseudo = row.getAttribute('data-pseudo').toLowerCase();
                    var uid = (arState.uidMap[row.getAttribute('data-pseudo')] || '').toLowerCase();
                    row.style.display = (pseudo + ' ' + uid).indexOf(q) !== -1 ? '' : 'none';
                });
            });
        }
    }

    function refreshStats(el) {
        var participants = arState.stages[arActiveStage].participants;
        var done = participants.reduce(function (a, p) { return a + (p.participated || 0); }, 0);
        var chips = el.querySelectorAll('.event-stats .gm-chip');
        if (chips[1]) chips[1].innerHTML = '<i class="ph-fill ph-check-circle"></i> ' + done + ' ' + t('event_participated');
        if (chips[2]) chips[2].innerHTML = '<i class="ph-fill ph-x-circle"></i> ' + (participants.length - done) + ' ' + t('event_absent');
    }

})();
