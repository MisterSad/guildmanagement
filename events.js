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
    var STANDARD_EVENTS = ['SvS', 'GvG', 'Defend Trade Route', 'ARMS RACE STAGE A', 'ARMS RACE STAGE B'];

    // Onglet UI → liste d'event_names DB qu'il pilote
    var TAB_TO_DB_EVENTS = {
        'SvS':                ['SvS'],
        'GvG':                ['GvG'],
        'Defend Trade Route': ['Defend Trade Route'],
        'ARMS RACE':          ['ARMS RACE STAGE A', 'ARMS RACE STAGE B']
    };

    var PANEL_MAP = {
        'SvS':                'event-svs',
        'GvG':                'event-gvg',
        'Defend Trade Route': 'event-dtr',
        'ARMS RACE':          'event-arms-race'
    };

    var EVENTS_WITHOUT_SCORE = ['ARMS RACE STAGE A', 'ARMS RACE STAGE B', 'Defend Trade Route'];

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
            var res = await db.from('event_status').select('event_name, is_active, session_id, stage')
                .in('event_name', dbEvents);

            var active = (res.data || []).find(function (r) { return r.is_active; });
            var s = state[tabKey];
            if (active) {
                s.activeEventName = active.event_name;
                s.sessionId       = active.session_id;
                s.stage           = active.stage;
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
                s.isActive        = false;
                renderStatus(tabKey);
                renderInactive(tabKey);
            }
        } catch (err) { console.error('loadEvent', err); }
    }

    // ── Démarrage d'une nouvelle session ──────────────────────────────────
    async function startEvent(tabKey, dbEventName, stage) {
        if (!db) return;
        var sessionId = window.RAD.newSessionId();
        try {
            var statusRes = await db.from('event_status').upsert(
                {
                    event_name: dbEventName,
                    is_active:  true,
                    session_id: sessionId,
                    stage:      stage || null,
                    updated_at: new Date().toISOString()
                },
                { onConflict: 'event_name' }
            );
            if (statusRes.error) throw statusRes.error;

            state[tabKey].activeEventName = dbEventName;
            state[tabKey].sessionId       = sessionId;
            state[tabKey].stage           = stage || null;
            state[tabKey].isActive        = true;
            renderStatus(tabKey);
            await populateParticipants(tabKey);
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
                { onConflict: 'event_name' }
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

        var week = window.RAD.getWeekStart();
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
                .select('event_name, session_id')
                .eq('is_active', true)
                .in('event_name', dbEventNames);
            if (statusRes.error) throw statusRes.error;

            var active = (statusRes.data || []).filter(function (r) { return r.session_id; });
            if (active.length === 0) return 0;

            var rows = active.map(function (r) {
                return {
                    event_name:   r.event_name,
                    session_id:   r.session_id,
                    week_start:   window.RAD.getWeekStart(new Date(r.session_id)),
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
                var matched = active.some(function (a) {
                    return a.event_name === s.activeEventName && a.session_id === s.sessionId;
                });
                if (!matched) return;
                if (s.participants.some(function (p) { return p.pseudo === pseudo; })) return;
                s.participants.push({
                    event_name:   s.activeEventName,
                    session_id:   s.sessionId,
                    week_start:   window.RAD.getWeekStart(new Date(s.sessionId)),
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

    function renderStatus(tabKey) {
        var panel = getPanel(tabKey);
        if (!panel) return;
        var s = state[tabKey];
        var badge    = panel.querySelector('.event-status-badge');
        var startBtn = panel.querySelector('.event-start-btn');
        var endBtn   = panel.querySelector('.event-end-btn');
        var stageBadge = panel.querySelector('.arms-stage-badge');

        if (badge) {
            badge.className = 'event-status-badge gm-chip' + (s.isActive ? ' gm-chip-success active' : '');
            badge.innerHTML = '<span class="gm-dot"></span> ' +
                (s.isActive ? t('event_active') : t('event_inactive'));
        }
        if (startBtn) startBtn.disabled = s.isActive;
        if (endBtn)   endBtn.disabled   = !s.isActive;

        if (stageBadge) {
            if (tabKey === 'ARMS RACE' && s.isActive && s.stage) {
                stageBadge.textContent = 'Stage ' + s.stage;
                stageBadge.classList.remove('hidden');
            } else {
                stageBadge.classList.add('hidden');
                stageBadge.textContent = '';
            }
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

        var isSvs    = dbEventName === 'SvS';
        var hasScore = EVENTS_WITHOUT_SCORE.indexOf(dbEventName) === -1;
        var done = participants.reduce(function (a, p) { return a + (p.participated || 0); }, 0);
        var totalScore = isSvs
            ? participants.reduce(function (a, p) { return a + (p.score_prep || 0) + (p.score_pvp || 0) + (p.score || 0); }, 0)
            : participants.reduce(function (a, p) { return a + (p.score || 0); }, 0);

        var html =
            '<div class="gm-row" style="gap:.5rem; margin-bottom:1rem; flex-wrap:wrap; justify-content:space-between;">' +
                '<div class="gm-row event-stats" style="gap:.5rem; flex-wrap:wrap;">' +
                    '<span class="gm-chip"><i class="ph-fill ph-users"></i> ' + participants.length + ' ' + t('event_total') + '</span>' +
                    '<span class="gm-chip gm-chip-success"><i class="ph-fill ph-check-circle"></i> ' + done + ' ' + t('event_participated') + '</span>' +
                    '<span class="gm-chip"><i class="ph-fill ph-x-circle"></i> ' + (participants.length - done) + ' ' + t('event_absent') + '</span>' +
                    (hasScore ? '<span class="gm-chip gm-chip-accent"><i class="ph-fill ph-trophy"></i> ' + t('event_total_score') + ' ' + fmt(totalScore) + '</span>' : '') +
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
                    (isSvs
                        ? '<th class="gm-right">' + t('col_score_prep') + '</th><th class="gm-right">' + t('col_score_pvp') + '</th>'
                        : (hasScore ? '<th class="gm-right">' + t('col_score') + '</th>' : '')) +
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
                    (isSvs
                        ? '<td class="gm-right" data-label="' + t('col_score_prep') + '">' +
                              '<input type="text" inputmode="numeric" class="gm-score-input score-input-prep" value="' + (p.score_prep != null ? fmt(p.score_prep) : '') + '" placeholder="—" data-pseudo="' + esc(p.pseudo) + '">' +
                          '</td>' +
                          '<td class="gm-right" data-label="' + t('col_score_pvp') + '">' +
                              '<input type="text" inputmode="numeric" class="gm-score-input score-input-pvp" value="' + (p.score_pvp != null ? fmt(p.score_pvp) : '') + '" placeholder="—" data-pseudo="' + esc(p.pseudo) + '">' +
                          '</td>'
                        : (hasScore ? '<td class="gm-right" data-label="' + t('col_score') + '">' +
                              '<input type="text" inputmode="numeric" class="gm-score-input score-input" value="' + (p.score != null ? fmt(p.score) : '') + '" placeholder="—" data-pseudo="' + esc(p.pseudo) + '">' +
                          '</td>' : '')) +
                '</tr>';
        });

        html += '</tbody></table></div></div>';
        el.innerHTML = html;

        el.querySelectorAll('.participation-checkbox').forEach(function (cb) {
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
    }

    function refreshStats(el, tabKey) {
        var participants = state[tabKey].participants;
        var isSvs = state[tabKey].activeEventName === 'SvS';
        var done = participants.reduce(function (a, p) { return a + (p.participated || 0); }, 0);
        var totalScore = isSvs
            ? participants.reduce(function (a, p) { return a + (p.score_prep || 0) + (p.score_pvp || 0) + (p.score || 0); }, 0)
            : participants.reduce(function (a, p) { return a + (p.score || 0); }, 0);
        var chips = el.querySelectorAll('.event-stats .gm-chip');
        if (chips[1]) chips[1].innerHTML = '<i class="ph-fill ph-check-circle"></i> ' + done + ' ' + t('event_participated');
        if (chips[2]) chips[2].innerHTML = '<i class="ph-fill ph-x-circle"></i> ' + (participants.length - done) + ' ' + t('event_absent');
        if (chips[3]) chips[3].innerHTML = '<i class="ph-fill ph-trophy"></i> ' + t('event_total_score') + ' ' + fmt(totalScore);
    }

    // ── Stage selector modal pour Arms Race ───────────────────────────────
    function pickArmsRaceStage(callback) {
        var existing = document.getElementById('stage-overlay');
        if (existing) existing.remove();

        var overlay = document.createElement('div');
        overlay.id = 'stage-overlay';
        overlay.className = 'confirm-overlay';
        overlay.innerHTML =
            '<div class="confirm-card glass-card">' +
                '<div class="confirm-icon"><i class="ph-fill ph-target text-accent"></i></div>' +
                '<h3>' + t('arms_pick_stage_title') + '</h3>' +
                '<p>' + t('arms_pick_stage_body') + '</p>' +
                '<div class="confirm-actions" style="gap: 1rem;">' +
                    '<button id="stage-cancel" class="btn-ghost">' + t('confirm_cancel') + '</button>' +
                    '<button id="stage-a" class="primary-btn">Stage A</button>' +
                    '<button id="stage-b" class="primary-btn">Stage B</button>' +
                '</div>' +
            '</div>';
        document.body.appendChild(overlay);
        requestAnimationFrame(function () { overlay.classList.add('visible'); });

        function close() {
            overlay.classList.remove('visible');
            setTimeout(function () { overlay.remove(); }, 300);
        }
        document.getElementById('stage-cancel').addEventListener('click', close);
        document.getElementById('stage-a').addEventListener('click', function () { close(); callback('A'); });
        document.getElementById('stage-b').addEventListener('click', function () { close(); callback('B'); });
        overlay.addEventListener('click', function (ev) { if (ev.target === overlay) close(); });
    }

    // ── Wire START / END buttons ──────────────────────────────────────────
    document.querySelectorAll('.event-start-btn[data-event]').forEach(function (btn) {
        var ev = btn.getAttribute('data-event');
        if (!TAB_TO_DB_EVENTS[ev]) return;

        btn.addEventListener('click', function () {
            if (ev === 'ARMS RACE') {
                pickArmsRaceStage(function (stage) {
                    var dbEventName = stage === 'A' ? 'ARMS RACE STAGE A' : 'ARMS RACE STAGE B';
                    startEvent('ARMS RACE', dbEventName, stage);
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
