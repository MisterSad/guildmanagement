/**
 * history.js — Historique complet des sessions d'événements.
 * Liste agrégée via RPC list_event_sessions, détail par session via SELECT.
 */
(function () {

    function getDb() { return (window.GM && window.GM.db) ? window.GM.db : null; }
    var t   = window.GM ? window.GM.t  : function (k) { return k; };
    var esc = window.GM ? window.GM.escapeHTML : function (s) { return s; };
    var fmt = window.GM ? window.GM.formatNumber : function (n) { return String(n); };

    var EVENT_META = {
        'SvS':                { icon: 'ph-swords',      label: 'SvS',         filterKey: 'SvS',         hasScore: true,  border: 'var(--accent)' },
        'GvG':                { icon: 'ph-flag-banner', label: 'GvG',         filterKey: 'GvG',         hasScore: true,  border: 'var(--accent)' },
        'Shadowfront':        { icon: 'ph-ghost',       label: 'Shadowfront', filterKey: 'Shadowfront', hasScore: false, border: 'var(--info)'   },
        'Defend Trade Route': { icon: 'ph-truck',       label: 'DTR',         filterKey: 'DTR',         hasScore: false, border: 'var(--info)'   },
        'ARMS RACE STAGE A':  { icon: 'ph-crosshair',   label: 'Arms Race A', filterKey: 'Arms Race',   hasScore: false, border: 'var(--warning)'},
        'ARMS RACE STAGE B':  { icon: 'ph-target',      label: 'Arms Race B', filterKey: 'Arms Race',   hasScore: false, border: 'var(--warning)'},
        'Glory':              { icon: 'ph-trophy',      label: 'Glory',       filterKey: 'Glory',       hasScore: true,  border: 'var(--success)'}
    };

    var FILTERS = ['All', 'SvS', 'GvG', 'Shadowfront', 'DTR', 'Arms Race', 'Glory'];

    var sessions = [];
    var activeFilter = 'All';

    // ── Session date helpers ────────────────────────────────────────────────
    // session_id is a human-readable key (ARA-20260809, SF1-20260802,
    // SVS-2026-W32, ...). A trailing YYYYMMDD segment (or a week key) is the
    // best stand-in for a battle date when start_at was never chosen.
    function hasSessionDate(sessionId) {
        if (!sessionId) return false;
        return /-\d{8}(-\d+)?$/.test(sessionId) || /-\d{4}-W\d{2}$/.test(sessionId);
    }
    function parseSessionDate(s) {
        var d = null;
        if (s.start_at) {
            var raw = String(s.start_at);
            // Postgres can serialize timestamptz as "2026-08-12T19:30:00+00"
            // (offset without minutes), which JS Date rejects. Normalize it.
            d = new Date(raw.replace(/\+00$/, '+00:00'));
            if (isNaN(d.getTime())) d = new Date(raw);
            if (isNaN(d.getTime())) d = null;
        }
        if (!d || isNaN(d.getTime())) {
            var sid = s.session_id || '';
            var m = sid.match(/-(\d{4})(\d{2})(\d{2})(-\d+)?$/);
            if (m) d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
            else if (s.week_start) d = new Date(s.week_start + 'T12:00:00Z');
        }
        return d && !isNaN(d.getTime()) ? d : null;
    }
    function sessionTime(s) {
        var d = parseSessionDate(s);
        return d && !isNaN(d.getTime()) ? d.getTime() : 0;
    }
    function formatSessionDate(sessionId) {
        var m = sessionId.match(/-(\d{4})(\d{2})(\d{2})(-\d+)?$/);
        if (m) {
            var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
            return d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
        }
        return sessionId;
    }

    window.GM_HISTORY = { load: loadHistory };

    async function loadHistory() {
        var db = getDb();
        if (!db) return;
        try {
            var currentG = window.GM ? window.GM.getActiveGuild() : 'ALPHA';
            var res = await db.rpc('gm_list_event_sessions', { p_guild: currentG });
            if (res.error) {
                console.error('gm_list_event_sessions', res.error);
                renderHistory();
                return;
            }
            sessions = res.data || [];

            // Manual fetch for Glory since it has no session_id and might not be returned by the RPC
            var hasGlory = sessions.some(function(s) { return s.event_name === 'Glory'; });
            if (!hasGlory) {
                var gloryRes = await db.from('event_participants')
                    .select('week_start, participated, score')
                    .eq('guild', currentG)
                    .eq('event_name', 'Glory');
                
                if (!gloryRes.error && gloryRes.data && gloryRes.data.length > 0) {
                    var gloryMap = {};
                    gloryRes.data.forEach(function(row) {
                        var ws = row.week_start;
                        if (!gloryMap[ws]) {
                            gloryMap[ws] = {
                                event_name: 'Glory',
                                session_id: null,
                                week_start: ws,
                                participants: 0,
                                participated_count: 0,
                                total_score: 0
                            };
                        }
                        gloryMap[ws].participants++;
                        if (row.participated > 0) {
                            gloryMap[ws].participated_count++;
                        }
                        if (row.score > 0) {
                            gloryMap[ws].total_score += row.score;
                        }
                    });
                    var glorySessions = Object.values(gloryMap);
                    sessions = sessions.concat(glorySessions);
                }
            }

            // Always sort sessions by date descending: most recent first.
            sessions.sort(function(a, b) {
                var timeA = sessionTime(a);
                var timeB = sessionTime(b);
                return timeB - timeA;
            });

            renderHistory();
        } catch (err) {
            console.error('loadHistory', err);
            renderHistory();
        }
    }

    function pad2(n) { return (n < 10 ? '0' : '') + n; }

    function getWeekNumber(ws) {
        if (!ws) return '';
        var d = new Date(ws.length === 10 ? ws + 'T12:00:00Z' : ws);
        if (isNaN(d.getTime())) return '';
        var target = new Date(d.valueOf());
        var dayNr = (d.getUTCDay() + 6) % 7;
        target.setUTCDate(target.getUTCDate() - dayNr + 3);
        var firstThursday = target.valueOf();
        target.setUTCMonth(0, 1);
        if (target.getUTCDay() !== 4) {
            target.setUTCMonth(0, 1 + ((4 - target.getUTCDay() + 7) % 7));
        }
        return 1 + Math.ceil((firstThursday - target) / 604800000);
    }

    function getCategoryEventNames(filterKey) {
        if (filterKey === 'SvS') return ['SvS'];
        if (filterKey === 'GvG') return ['GvG'];
        if (filterKey === 'Shadowfront') return ['Shadowfront', 'Shadowfront Squad 1', 'Shadowfront Squad 2'];
        if (filterKey === 'DTR') return ['Defend Trade Route'];
        if (filterKey === 'Arms Race') return ['ARMS RACE STAGE A', 'ARMS RACE STAGE B'];
        if (filterKey === 'Glory') return ['Glory'];
        return [filterKey];
    }

    async function deleteCategoryHistory(filterKey, count) {
        var eventNames = getCategoryEventNames(filterKey);
        var currentG = window.GM ? window.GM.getActiveGuild() : 'ALPHA';

        window.showConfirm(
            'Delete all ' + filterKey + ' history',
            'Are you sure you want to delete all <strong>' + count + '</strong> session(s) in category <strong>' + esc(filterKey) + '</strong>? This action cannot be undone.',
            async function () {
                try {
                    var db = getDb();
                    if (!db) return;

                    // 1. Delete from event_participants
                    var delPartRes = await db.from('event_participants')
                        .delete()
                        .eq('guild', currentG)
                        .in('event_name', eventNames);
                    if (delPartRes.error) throw delPartRes.error;

                    // 2. If Shadowfront, also delete shadowfront_squads for this guild
                    if (filterKey === 'Shadowfront') {
                        var delSquadRes = await db.from('shadowfront_squads')
                            .delete()
                            .eq('guild', currentG);
                        if (delSquadRes.error) throw delSquadRes.error;
                    }

                    // 3. Delete from event_status
                    var delStatusRes = await db.from('event_status')
                        .delete()
                        .eq('guild', currentG)
                        .in('event_name', eventNames);
                    if (delStatusRes.error) throw delStatusRes.error;

                    window.GM.showToast(t('toast_session_deleted'), 'success');
                    await loadHistory();
                } catch (err) {
                    console.error('deleteCategoryHistory error', err);
                    window.GM.showToast(t('toast_err_generic') + ' ' + err.message, 'error');
                }
            }
        );
    }

    function renderHistory() {
        var area = document.querySelector('#event-history .history-area');
        if (!area) return;

        var filtered = sessions.filter(function (s) {
            if (activeFilter === 'All') return true;
            var meta = EVENT_META[s.event_name];
            return meta && meta.filterKey === activeFilter;
        });

        var pillsHtml = '<div class="gm-tabs-pill-row" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:1rem; margin-bottom:1.5rem;">' +
            '<div class="gm-tabs-pill" style="margin:0;">' +
                FILTERS.map(function (f) {
                    var isActive = (f === activeFilter);
                    var label = (f === 'All') ? t('history_filter_all') : f;
                    var iconClass = (f === 'All') ? 'ph-circles-four' : ((window.GM && window.GM.getEventIcon) ? window.GM.getEventIcon(f) : 'ph-calendar-dot');
                    return '<button class="gm-tab-pill history-filter' + (isActive ? ' gm-active' : '') + '" data-filter="' + esc(f) + '">' +
                        '<i class="ph ' + iconClass + '"></i> ' + esc(label) +
                    '</button>';
                }).join('') +
            '</div>' +
            (activeFilter !== 'All' && filtered.length > 0 ?
                '<button class="gm-btn gm-btn-danger history-clear-category-btn" style="font-size:0.82rem; padding:0.4rem 0.85rem; display:inline-flex; align-items:center; gap:0.4rem;" data-filter="' + esc(activeFilter) + '" data-count="' + filtered.length + '">' +
                    '<i class="ph ph-trash"></i> <span>Delete ' + esc(activeFilter) + ' history (' + filtered.length + ')</span>' +
                '</button>' : ''
            ) +
        '</div>';

        if (filtered.length === 0) {
            area.innerHTML = pillsHtml +
                '<div class="gm-empty"><i class="ph-duotone ph-clock-counter-clockwise gm-icon"></i><div class="gm-empty-title">' + t('history_empty') + '</div></div>';
            wirePills();
            return;
        }

        var cardsHtml = '<div class="gm-timeline-container">';
        filtered.forEach(function (s, i) {
            // Le nom affiché : le squad (Shadowfront Squad One/Two) quand la
            // RPC le fournit, sinon le nom générique de l'événement.
            var displayName = s.display_name || s.event_name;
            if (displayName === 'Shadowfront Squad 1') displayName = 'Shadowfront Squad One';
            else if (displayName === 'Shadowfront Squad 2') displayName = 'Shadowfront Squad Two';
            var meta        = EVENT_META[s.event_name] || { icon: 'ph-calendar-dot', label: displayName, hasScore: false, border: 'var(--border-soft)' };
            // La tuile doit afficher le nom du squad (pas seulement le modal).
            meta.label = displayName;
            var iconClass   = (window.GM && window.GM.getEventIcon) ? window.GM.getEventIcon(s.event_name) : (meta.icon || 'ph-calendar-dot');
            var isWeekly    = (s.event_name === 'SvS' || s.event_name === 'GvG');
            var weekNum     = getWeekNumber(s.week_start);
            var weekDisplay = 'Week ' + weekNum;
            var ratio       = s.participants > 0 ? Math.round((s.participated_count / s.participants) * 100) : 0;
            var themeClass  = (window.GM && window.GM.getEventTheme) ? window.GM.getEventTheme(s.event_name) : 'gm-task-card-dark';

            var leftTopStr   = '';
            var leftSubStr   = '';
            var subtitleText = '';

            if (isWeekly) {
                leftTopStr   = weekDisplay;
                leftSubStr   = window.GM.formatWeek(s.week_start);
                subtitleText = weekDisplay + ' (' + window.GM.formatWeek(s.week_start) + ')';
            } else {
                // Priorité à la date du combat (start_at choisi à la création) ;
                // repli sur la date encodée dans l'ID de session (ARA-20260809,
                // SF1-20260802, ...), sinon sur la semaine.
                var dateObj = parseSessionDate(s);
                if (dateObj && !isNaN(dateObj.getTime())) {
                    leftTopStr = pad2(dateObj.getUTCDate()) + '/' + pad2(dateObj.getUTCMonth() + 1) + '/' + dateObj.getUTCFullYear();
                    if (s.start_at || hasSessionDate(s.session_id)) {
                        leftSubStr = pad2(dateObj.getUTCHours()) + ':' + pad2(dateObj.getUTCMinutes()) + ' UTC';
                        subtitleText = dateObj.toLocaleDateString('en-GB', {
                            day: '2-digit', month: '2-digit', year: 'numeric',
                            hour: '2-digit', minute: '2-digit', timeZone: 'UTC'
                        }) + ' UTC';
                    } else {
                        leftSubStr = weekDisplay;
                        subtitleText = dateObj.toLocaleDateString('en-GB', {
                            day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC'
                        }) + ' · ' + weekDisplay;
                    }
                } else {
                    leftTopStr   = weekDisplay;
                    leftSubStr   = s.week_start || '';
                    subtitleText = weekDisplay;
                }
            }

            cardsHtml +=
                '<div class="gm-timeline-item">' +
                    '<div class="gm-timeline-time-col">' +
                        '<div style="font-size:0.85rem; font-weight:700;">' + esc(leftTopStr) + '</div>' +
                        '<div style="font-size:0.7rem; font-weight:500; opacity:0.7; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' + esc(leftSubStr) + '</div>' +
                    '</div>' +
                    '<div class="gm-timeline-line-col">' +
                        '<div class="gm-timeline-dot"></div>' +
                    '</div>' +
                    '<div>' +
                        '<div class="gm-task-card gm-history-card ' + themeClass + '" data-event="' + esc(s.event_name) + '" data-display="' + esc(displayName) + '" data-session="' + esc(s.session_id || '') + '" data-week="' + esc(s.week_start) + '">' +
                            '<div class="gm-task-card-top">' +
                                '<div class="gm-task-status-tag">' +
                                    '<i class="ph ' + esc(iconClass) + '"></i>' +
                                    '<span>' + esc(meta.label) + '</span>' +
                                '</div>' +
                                '<div style="display:flex; gap:0.4rem; align-items:center;">' +
                                    (s.total_score > 0 ? '<span class="gm-task-countdown-badge"><i class="ph-fill ph-trophy"></i> ' + fmt(s.total_score) + '</span>' : '') +
                                    '<span class="gm-task-countdown-badge">' + s.participated_count + '/' + s.participants + ' (' + ratio + '%)</span>' +
                                '</div>' +
                            '</div>' +
                            '<div class="gm-task-card-body">' +
                                '<div class="gm-task-icon-squircle">' +
                                    '<i class="ph ' + esc(iconClass) + '"></i>' +
                                '</div>' +
                                '<div class="gm-task-info">' +
                                    '<div class="gm-task-title">' + esc(meta.label) + '</div>' +
                                    '<div class="gm-task-sub">' + esc(subtitleText) + '</div>' +
                                '</div>' +
                                '<button class="gm-task-action-btn" title="View Session Details" aria-label="View session details">' +
                                    '<i class="ph ph-caret-right" style="font-size:1.3rem;"></i>' +
                                '</button>' +
                            '</div>' +
                        '</div>' +
                    '</div>' +
                '</div>';
        });
        cardsHtml += '</div>';

        area.innerHTML = pillsHtml + cardsHtml;
        wirePills();
        wireCards();
    }

    function formatWhen(sessionId, weekStart) {
        if (sessionId) {
            return new Date(sessionId).toLocaleDateString('en-GB', {
                day: '2-digit', month: '2-digit', year: 'numeric',
                hour: '2-digit', minute: '2-digit'
            });
        }
        return t('history_week_only');
    }

    function wirePills() {
        document.querySelectorAll('#event-history .history-filter').forEach(function (btn) {
            btn.addEventListener('click', function () {
                activeFilter = btn.getAttribute('data-filter');
                renderHistory();
            });
        });
        var clearCategoryBtn = document.querySelector('#event-history .history-clear-category-btn');
        if (clearCategoryBtn) {
            clearCategoryBtn.addEventListener('click', function () {
                var filterKey = clearCategoryBtn.getAttribute('data-filter');
                var count = clearCategoryBtn.getAttribute('data-count');
                deleteCategoryHistory(filterKey, count);
            });
        }
    }

    function wireCards() {
        document.querySelectorAll('#event-history .gm-history-card').forEach(function (card) {
            card.addEventListener('click', function () {
                var ev   = card.getAttribute('data-event');
                var disp = card.getAttribute('data-display') || null;
                var sid  = card.getAttribute('data-session') || null;
                var week = card.getAttribute('data-week');
                openSessionDetail(ev, disp, sid, week);
            });
        });
    }

    async function openSessionDetail(eventName, displayName, sessionId, weekStart) {
        var db = getDb();
        if (!db) return;
        var meta = EVENT_META[eventName] || { label: displayName || eventName, icon: 'ph-circle', hasScore: false, border: 'var(--border-soft)' };
        if (displayName) meta.label = displayName;

        var query = db.from('event_participants')
            .select('pseudo, participated, score, score_prep, score_pvp, appointed, excused, late, sub_present')
            .eq('guild', window.GM ? window.GM.getActiveGuild() : 'ALPHA')
            .eq('event_name', eventName)
            .eq('week_start', weekStart)
            .limit(100000);

        if (sessionId) {
            query = query.eq('session_id', sessionId);
        } else {
            query = query.is('session_id', null);
        }

        var res = await query;
        if (res.error) {
            window.GM.showToast(t('toast_err_generic') + ' ' + res.error.message, 'error');
            return;
        }

        var rows = res.data || [];
        var isDualScore = (eventName === 'SvS' || eventName === 'GvG');
        renderSessionModal(eventName, sessionId, weekStart, rows, meta, isDualScore);
    }

    var ALLOWED_HISTORY_FIELDS = [
        'participated', 'score', 'score_prep', 'score_pvp',
        'late', 'excused', 'sub_present', 'appointed', 'is_pending'
    ];

    async function updateParticipantField(eventName, sessionId, weekStart, pseudo, field, value) {
        if (ALLOWED_HISTORY_FIELDS.indexOf(field) === -1) {
            console.error('[SECURITY] Unauthorized field update attempt in history:', field);
            window.GM.showToast('Invalid update field', 'error');
            return;
        }
        var db = getDb();
        if (!db) return;
        var currentG = window.GM ? window.GM.getActiveGuild() : 'ALPHA';
        var query = db.from('event_participants')
            .update({ [field]: value })
            .eq('guild', currentG)
            .eq('event_name', eventName)
            .eq('week_start', weekStart)
            .eq('pseudo', pseudo);
        if (sessionId) {
            query = query.eq('session_id', sessionId);
        } else {
            query = query.is('session_id', null);
        }
        var updateRes = await query;
        if (updateRes.error) {
            window.GM.showToast('Error: ' + updateRes.error.message, 'error');
        } else {
            window.GM.showToast('Updated successfully', 'success');
        }
    }

    function renderSessionModal(eventName, sessionId, weekStart, rows, meta, isDualScore) {
        var existing = document.getElementById('history-modal');
        if (existing) existing.remove();

        var when = sessionId && hasSessionDate(sessionId)
            ? formatSessionDate(sessionId)
            : t('history_week_only');

        var sorted = rows.slice().sort(function (a, b) {
            var ap = a.participated || 0, bp = b.participated || 0;
            if (bp !== ap) return bp - ap;
            var as = (a.score || 0) + (a.score_prep || 0) + (a.score_pvp || 0);
            var bs = (b.score || 0) + (b.score_prep || 0) + (b.score_pvp || 0);
            if (bs !== as) return bs - as;
            return String(a.pseudo).localeCompare(String(b.pseudo));
        });

        var isDtr = (eventName === 'Defend Trade Route');
        var isAdmin = (window.GM.roleFromStorage() !== 'member');

        var headerCols = '<th>' + t('col_member') + '</th>';
        var hasParticipated = (eventName !== 'Glory');
        if (hasParticipated) {
            headerCols += '<th class="gm-center">' + t('col_participated') + '</th>';
        }
        if (eventName === 'Shadowfront') {
            headerCols += '<th class="gm-center">Late</th>' +
                '<th class="gm-center">Excused</th>' +
                '<th class="gm-center">Sub Present</th>';
        }
        if (isDtr) {
            headerCols += '<th class="gm-center">Appointed</th>';
        }
        if (isDualScore) {
            headerCols += '<th class="gm-right">' + t('col_score_prep') + '</th><th class="gm-right">' + t('col_score_pvp') + '</th>';
        } else if (meta.hasScore) {
            headerCols += '<th class="gm-right">' + t('col_score') + '</th>';
        }

        var rowsHtml = sorted.map(function (r) {
            var initial = window.GM.avatarInit(r.pseudo);
            
            var participatedCell = '';
            var lateCell = '';
            var excusedCell = '';
            var subPresentCell = '';
            var appointedCell = '';
            var scoreCells = '';

            if (isAdmin) {
                if (hasParticipated) {
                    participatedCell = '<td class="gm-center"><label class="check-toggle" style="margin: auto;"><input type="checkbox" class="hist-edit-check" data-field="participated" data-pseudo="' + esc(r.pseudo) + '"' + (r.participated > 0 ? ' checked' : '') + '><span class="check-slider"></span></label></td>';
                }
                if (eventName === 'Shadowfront') {
                    lateCell = '<td class="gm-center"><label class="check-toggle" style="margin: auto;"><input type="checkbox" class="hist-edit-check" data-field="late" data-pseudo="' + esc(r.pseudo) + '"' + (r.late ? ' checked' : '') + '><span class="check-slider"></span></label></td>';
                    excusedCell = '<td class="gm-center"><label class="check-toggle" style="margin: auto;"><input type="checkbox" class="hist-edit-check" data-field="excused" data-pseudo="' + esc(r.pseudo) + '"' + (r.excused ? ' checked' : '') + '><span class="check-slider"></span></label></td>';
                    subPresentCell = '<td class="gm-center"><label class="check-toggle" style="margin: auto;"><input type="checkbox" class="hist-edit-check" data-field="sub_present" data-pseudo="' + esc(r.pseudo) + '"' + (r.sub_present ? ' checked' : '') + '><span class="check-slider"></span></label></td>';
                }
                if (isDtr) {
                    appointedCell = '<td class="gm-center"><label class="check-toggle" style="margin: auto;"><input type="checkbox" class="hist-edit-check" data-field="appointed" data-pseudo="' + esc(r.pseudo) + '"' + (r.appointed ? ' checked' : '') + '><span class="check-slider"></span></label></td>';
                }
                
                if (isDualScore) {
                    scoreCells = '<td class="gm-right"><input type="text" inputmode="numeric" class="hist-edit-num gm-score-input" data-field="score_prep" data-pseudo="' + esc(r.pseudo) + '" value="' + (r.score_prep != null ? fmt(r.score_prep) : '') + '"></td>' +
                        '<td class="gm-right"><input type="text" inputmode="numeric" class="hist-edit-num gm-score-input" data-field="score_pvp" data-pseudo="' + esc(r.pseudo) + '" value="' + (r.score_pvp != null ? fmt(r.score_pvp) : '') + '"></td>';
                } else if (meta.hasScore) {
                    scoreCells = '<td class="gm-right"><input type="text" inputmode="numeric" class="hist-edit-num gm-score-input" data-field="score" data-pseudo="' + esc(r.pseudo) + '" value="' + (r.score != null ? fmt(r.score) : '') + '"></td>';
                }
            } else {
                if (hasParticipated) {
                    participatedCell = '<td class="gm-center">' + (r.participated > 0 ? '<i class="ph-fill ph-check-circle text-success"></i>' : '<i class="ph ph-x-circle gm-dim"></i>') + '</td>';
                }
                
                if (eventName === 'Shadowfront') {
                    lateCell = '<td class="gm-center">' + (r.late ? '<i class="ph-fill ph-check-circle text-warning"></i>' : '<i class="ph ph-x-circle gm-dim"></i>') + '</td>';
                    excusedCell = '<td class="gm-center">' + (r.excused ? '<i class="ph-fill ph-check-circle text-info"></i>' : '<i class="ph ph-x-circle gm-dim"></i>') + '</td>';
                    subPresentCell = '<td class="gm-center">' + (r.sub_present ? '<i class="ph-fill ph-check-circle text-accent"></i>' : '<i class="ph ph-x-circle gm-dim"></i>') + '</td>';
                }
                
                if (isDtr) {
                    appointedCell = '<td class="gm-center">' + (r.appointed ? '<i class="ph-fill ph-check-circle text-success"></i>' : '<i class="ph ph-x-circle gm-dim"></i>') + '</td>';
                }
                
                if (isDualScore) {
                    scoreCells = '<td class="gm-right">' + (r.score_prep != null ? fmt(r.score_prep) : '—') + '</td>' +
                        '<td class="gm-right">' + (r.score_pvp  != null ? fmt(r.score_pvp)  : '—') + '</td>';
                } else if (meta.hasScore) {
                    scoreCells = '<td class="gm-right">' + (r.score != null ? fmt(r.score) : '—') + '</td>';
                }
            }

            return '<tr>' +
                '<td><div class="gm-row" style="gap:.5rem;"><div class="gm-avatar">' + esc(initial) + '</div><strong>' + esc(r.pseudo) + '</strong></div></td>' +
                participatedCell +
                lateCell + excusedCell + subPresentCell +
                appointedCell +
                scoreCells +
                '</tr>';
        }).join('');

        var totalScore = sorted.reduce(function (s, r) { return s + (r.score || 0) + (r.score_prep || 0) + (r.score_pvp || 0); }, 0);
        var doneCount  = sorted.reduce(function (s, r) { return s + (r.participated > 0 ? 1 : 0); }, 0);

        var deleteBtnHtml =
            '<button class="gm-btn gm-btn-danger" id="history-modal-delete" style="background: rgba(239,68,68,0.12); border: 1px solid rgba(239,68,68,0.25); color: var(--error);"><i class="ph ph-trash"></i> <span>' + t('delete_title') + '</span></button>';

        var existingModal = document.getElementById('history-modal');
        if (existingModal) existingModal.remove();

        var overlay = document.createElement('div');
        overlay.id = 'history-modal';
        overlay.className = 'confirm-overlay';
        overlay.innerHTML =
            '<div class="confirm-card glass-card" style="max-width: 860px; width: 95vw;">' +
                '<div class="gm-row" style="justify-content:space-between; align-items:flex-start; margin-bottom:1rem;">' +
                    '<div>' +
                        '<h3 style="margin:0;"><i class="ph-fill ' + meta.icon + '" style="color:' + meta.border + ';"></i> ' + esc(meta.label) + '</h3>' +
                        '<div class="gm-dim" style="margin-top:.25rem; font-size:.85rem;">' + esc(when) + ' · ' + esc(window.GM.formatWeek(weekStart)) + '</div>' +
                    '</div>' +
                    '<div class="gm-row" style="gap:.5rem; margin-left:auto;">' +
                        deleteBtnHtml +
                        '<button class="gm-btn gm-btn-ghost gm-btn-icon" id="history-modal-close" title="' + t('close_title') + '"><i class="ph ph-x"></i></button>' +
                    '</div>' +
                '</div>' +
                '<div class="gm-row" style="gap:.5rem; flex-wrap:wrap; margin-bottom:1rem;">' +
                    '<span class="gm-chip"><i class="ph-fill ph-users"></i> ' + sorted.length + '</span>' +
                    '<span class="gm-chip gm-chip-success"><i class="ph-fill ph-check-circle"></i> ' + doneCount + ' ' + t('event_participated') + '</span>' +
                    (totalScore > 0 ? '<span class="gm-chip gm-chip-accent"><i class="ph-fill ph-trophy"></i> ' + fmt(totalScore) + '</span>' : '') +
                '</div>' +
                (sorted.length === 0
                    ? '<div class="gm-empty"><i class="ph-duotone ph-ghost gm-icon"></i><div class="gm-empty-title">' + t('history_empty_session') + '</div></div>'
                    : '<div class="gm-table-wrap"><div class="gm-table-scroll" style="max-height: 60vh;">' +
                        '<table class="gm-table gm-resp-table">' +
                            '<thead><tr>' + headerCols + '</tr></thead>' +
                            '<tbody>' + rowsHtml + '</tbody>' +
                            '</table>' +
                      '</div></div>') +
            '</div>';
        document.body.appendChild(overlay);
        requestAnimationFrame(function () { overlay.classList.add('visible'); });

        if (isAdmin) {
            overlay.querySelectorAll('.hist-edit-check').forEach(function (cb) {
                cb.addEventListener('change', async function () {
                    var pseudo = cb.getAttribute('data-pseudo');
                    var field = cb.getAttribute('data-field');
                    var val = cb.checked;
                    if (field === 'participated') {
                        val = cb.checked ? 1 : 0;
                    }
                    await updateParticipantField(eventName, sessionId, weekStart, pseudo, field, val);
                });
            });
            overlay.querySelectorAll('.hist-edit-num').forEach(function (input) {
                window.GM.attachNumberFormatter(input);
                input.addEventListener('change', async function () {
                    var pseudo = input.getAttribute('data-pseudo');
                    var field = input.getAttribute('data-field');
                    var val = window.GM.parseNumber(input.value);
                    await updateParticipantField(eventName, sessionId, weekStart, pseudo, field, val);
                });
            });
        }

        function close() {
            overlay.classList.remove('visible');
            setTimeout(function () { overlay.remove(); }, 300);
        }
        document.getElementById('history-modal-close').addEventListener('click', close);

        var deleteBtn = document.getElementById('history-modal-delete');
        if (deleteBtn) {
            deleteBtn.addEventListener('click', function () {
                window.showConfirm(
                    t('confirm_delete_session_title'),
                    '<strong>' + esc(meta.label) + '</strong><br>' + t('confirm_delete_session_body'),
                    async function () {
                        try {
                            var db = getDb();
                            if (!db) return;
                            // 1. Delete matching participants in event_participants
                            var currentG = window.GM ? window.GM.getActiveGuild() : 'ALPHA';
                            var query = db.from('event_participants').delete()
                                .eq('guild', currentG)
                                .eq('event_name', eventName)
                                .eq('week_start', weekStart);
                            
                            if (sessionId) {
                                query = query.eq('session_id', sessionId);
                            } else {
                                query = query.is('session_id', null);
                            }
                            
                            var delPartRes = await query;
                            if (delPartRes.error) throw delPartRes.error;

                            // 2. If Shadowfront and we have a sessionId, also delete matching assignments in shadowfront_squads
                            if (eventName === 'Shadowfront' && sessionId) {
                                var delSquadRes = await db.from('shadowfront_squads')
                                    .delete()
                                    .eq('guild', currentG)
                                    .eq('session_id', sessionId);
                                if (delSquadRes.error) throw delSquadRes.error;
                            }

                            // 3. Delete matching event_status if any (only if sessionId exists)
                            if (sessionId) {
                                var delStatusRes = await db.from('event_status')
                                    .delete()
                                    .eq('guild', currentG)
                                    .eq('session_id', sessionId);
                                if (delStatusRes.error) throw delStatusRes.error;
                            }

                            window.GM.showToast(t('toast_session_deleted'), 'success');
                            close();
                            await loadHistory();
                        } catch (err) {
                            console.error('Delete history session error', err);
                            window.GM.showToast(t('toast_err_generic') + ' ' + err.message, 'error');
                        }
                    }
                );
            });
        }

        overlay.addEventListener('click', function (ev) { if (ev.target === overlay) close(); });
    }

})();
