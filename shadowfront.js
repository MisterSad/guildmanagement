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

    function getDb() { return (window.GM && window.GM.db) ? window.GM.db : null; }
    var t   = window.GM ? window.GM.t  : function (k) { return k; };
    var esc = window.GM ? window.GM.escapeHTML : function (s) { return s; };

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
    var sfActiveTab   = 'composition'; // 'composition' | 'tracking'
    var sfActiveSquad = 'squad1';   // 'squad1' | 'squad2'
    var sfSort        = 'rate';     // 'rate' | 'power'
    var sfSelected    = {};         // pseudo → true (multi-select in Availability step)

    // ── Public API ─────────────────────────────────────────────────────────────
    window.GM_SHADOWFRONT = { load: loadShadowfront };

    function squadLabel(squad) { return squad === 'squad1' ? t('sf_squad1') : t('sf_squad2'); }
    function getMemberPower(pseudo) {
        var m = sfState.membersData.find(function (x) { return x.pseudo === pseudo; });
        return m ? (parseInt(m.overall_power) || 0) : 0;
    }
    function getParticipationBadgeHtml(pseudo) {
        var h = sfState.history[pseudo] || { assigned: 0, participated: 0 };
        var rateText = h.assigned > 0 ? Math.round((h.participated / h.assigned) * 100) + '%' : 'N/A';
        var cat = categorise(pseudo);
        var meta = categoryMeta(cat);
        return '<span class="sf-rate-badge ' + meta.cls + '" style="font-size: 0.7rem; padding: 0.1rem 0.35rem; display: inline-flex; align-items: center; justify-content: center; min-width: 32px; border-radius: 4px; font-weight: 600;">' + rateText + '</span>';
    }
    function sortSquadList(list) {
        return list.slice().sort(function (a, b) {
            var isCmdA = !!a.is_commander;
            var isCmdB = !!b.is_commander;
            if (isCmdA && !isCmdB) return -1;
            if (!isCmdA && isCmdB) return 1;
            
            var powerA = getMemberPower(a.pseudo);
            var powerB = getMemberPower(b.pseudo);
            return powerB - powerA; // descending
        });
    }
    function activeSquadKeys() {
        return ['squad1', 'squad2'].filter(function (k) { return sfState.squads[k].active; });
    }
    function anySquadActive() { return activeSquadKeys().length > 0; }
    function currentSessionIds() {
        // Toutes les sessions portant un id (actives ET terminées récentes) :
        // les participants d'un squad terminé restent accessibles pour la
        // saisie des scores et le suivi.
        return ['squad1', 'squad2']
            .map(function (k) { return sfState.squads[k].sessionId; })
            .filter(Boolean);
    }

    function activeSessionIds() {
        return ['squad1', 'squad2']
            .filter(function (k) { return sfState.squads[k].active; })
            .map(function (k) { return sfState.squads[k].sessionId; })
            .filter(Boolean);
    }

    // ── Load ───────────────────────────────────────────────────────────────────
    async function loadShadowfront() {
        var db = getDb();
        if (!db) {
            renderShadowfront();
            return;
        }
        try {
            var currentWeek = window.GM.getWeekStart();
            var currentG = window.GM ? window.GM.getActiveGuild() : 'ALPHA';

            var statusQ   = db.from('event_status').select('event_name, is_active, session_id, start_at').in('event_name', [SQUAD_EVENT.squad1, SQUAD_EVENT.squad2]);
            var membersQ  = db.from('guild_members').select('pseudo, uid, overall_power').order('pseudo', { ascending: true });
            var squadsQ   = db.from('shadowfront_squads').select('pseudo, session_id').limit(100000);
            var partsQ    = db.from('event_participants').select('pseudo, participated, session_id, excused, late, sub_present').eq('event_name', EVENT_NAME).limit(100000);
            var signupsQ  = db.from('shadowfront_signups').select('*').eq('week_start', currentWeek);

            statusQ  = statusQ.eq('guild', currentG);
            membersQ = membersQ.eq('guild', currentG);
            squadsQ  = squadsQ.eq('guild', currentG);
            partsQ   = partsQ.eq('guild', currentG);
            signupsQ = signupsQ.eq('guild', currentG);

            var [statusRes, membersRes, histSquads, histParts, signupRes] = await Promise.all([
                statusQ, membersQ, squadsQ, partsQ, signupsQ
            ]);

            var startedSessions = {};
            (histParts.data || []).forEach(function (r) { if (r.session_id) startedSessions[r.session_id] = true; });

            ['squad1', 'squad2'].forEach(function (k) {
                var row = (statusRes.data || []).find(function (r) { return r.event_name === SQUAD_EVENT[k]; });
                sfState.squads[k] = {
                    active:    row ? !!row.is_active : false,
                    sessionId: row ? row.session_id : null,
                    startAt:   row ? row.start_at : null,
                    // Un squad est "terminé" quand il est inactif mais garde un
                    // session_id déjà pourvu de participants (il a été lancé puis
                    // clôturé). L'UI doit alors se réinitialiser, sans toucher à
                    // l'autre squad ni à l'historique.
                    ended: row ? (!row.is_active && row.session_id && !!startedSessions[row.session_id]) : false
                };
            });

            sfState.membersData = membersRes.data || [];
            sfState.allMembers = sfState.membersData.map(function (m) { return m.pseudo; });
            sfState.uidMap = {};
            sfState.membersData.forEach(function (m) { sfState.uidMap[m.pseudo] = m.uid; });
            sfState.signups = signupRes.data || [];

            var powers = sfState.membersData.map(function (m) { return parseInt(m.overall_power) || 0; });
            sfState.maxPower = powers.length ? Math.max.apply(null, powers) : 0;

            // Only currently active sessions are excluded from historical calculations.
            // Past ended sessions are included in player participation history.
            var activeSids = activeSessionIds();
            var currentSids = currentSessionIds();

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

            // Union of unique (pseudo, session_id) pairs from shadowfront_squads and event_participants
            var histKeys = {};
            (histSquads.data || []).forEach(function (r) {
                if (activeSids.indexOf(r.session_id) !== -1) return;
                histKeys[r.pseudo + '|' + r.session_id] = true;
            });
            (histParts.data || []).forEach(function (r) {
                if (activeSids.indexOf(r.session_id) !== -1) return;
                histKeys[r.pseudo + '|' + r.session_id] = true;
            });

            Object.keys(histKeys).forEach(function (key) {
                var idx = key.indexOf('|');
                var pseudo = key.substring(0, idx);

                if (!hist[pseudo]) hist[pseudo] = { assigned: 0, participated: 0, excused_count: 0, late_count: 0, sub_present_count: 0 };

                var partInfo = partMap[key];
                if (partInfo) {
                    if (partInfo.excused) {
                        hist[pseudo].excused_count++;
                    } else if (partInfo.sub_present) {
                        hist[pseudo].assigned++;
                        hist[pseudo].participated++; // Reserve present = valid participation
                        hist[pseudo].sub_present_count++;
                    } else {
                        hist[pseudo].assigned++;
                        if (partInfo.participated > 0) {
                            hist[pseudo].participated++;
                        }
                        if (partInfo.late) {
                            hist[pseudo].late_count++;
                        }
                    }
                } else {
                    hist[pseudo].assigned++;
                }
            });
            sfState.history = hist;

            if (currentSids.length) {
                var [assignRes, partRes] = await Promise.all([
                    db.from('shadowfront_squads').select('*')
                        .eq('guild', currentG).in('session_id', currentSids).order('pseudo', { ascending: true }),
                    db.from('event_participants').select('*')
                        .eq('guild', currentG).eq('event_name', EVENT_NAME).in('session_id', currentSids)
                        .order('pseudo', { ascending: true })
                ]);
                sfState.assignments  = assignRes.data || [];
                sfState.participants = partRes.data || [];
            } else {
                sfState.assignments  = [];
                sfState.participants = [];
            }

            renderShadowfront();
        } catch (err) {
            console.error('loadShadowfront', err);
            renderShadowfront(); // render with whatever state we have so panel is never blank
        }
    }

    // ── Start / End a squad ────────────────────────────────────────────────────
    async function startSquad(squad, startAt) {
        var db = getDb();
        if (!db) return;
        var sq = sfState.squads[squad];
        var currentG = window.GM ? window.GM.getActiveGuild() : 'ALPHA';
        var sessionId;
        if (sq && sq.sessionId && !sq.ended) {
            // Reuse existing active session (e.g. page reload mid-event)
            sessionId = sq.sessionId;
        } else {
            // Fetch existing session_ids for this guild+event to prevent same-day collision
            var existingRes = await db.from('event_participants')
                .select('session_id')
                .eq('guild', currentG)
                .eq('event_name', EVENT_NAME);
            var existingIds = (existingRes.data || []).map(function (r) { return r.session_id; });
            sessionId = window.GM.buildEventSessionId(SQUAD_EVENT[squad], startAt || new Date(), existingIds);
        }
        if (sq) sq.ended = false;
        try {
            var res = await db.from('event_status').upsert(
                {
                    guild:      currentG,
                    event_name: SQUAD_EVENT[squad],
                    is_active:  true,
                    session_id: sessionId,
                    start_at:   startAt || null,
                    updated_at: new Date().toISOString()
                },
                { onConflict: 'guild,event_name' }
            );
            if (res.error) throw res.error;

            // Sync all assigned members to event_participants
            await syncParticipantRows(sessionId);

            window.GM.showToast(squadLabel(squad) + ' - ' + t('sf_squad_started'), 'success');

            if (window.GM.notifyDiscordEvent) {
                window.GM.notifyDiscordEvent(SQUAD_EVENT[squad], startAt || sessionId, 'start');
            }
        } catch (err) {
            console.error('startSquad', err);
            window.GM.showToast(t('toast_err_generic') + ' ' + err.message, 'error');
        }
        await loadShadowfront();
    }

    async function endSquads(squads) {
        var db = getDb();
        if (!db) return;
        var currentG = window.GM ? window.GM.getActiveGuild() : 'ALPHA';
        for (var i = 0; i < squads.length; i++) {
            var squad = squads[i];
            var currentSession = sfState.squads[squad] ? sfState.squads[squad].sessionId : null;
            try {
                await db.from('event_status').upsert(
                    {
                        guild:      currentG,
                        event_name: SQUAD_EVENT[squad],
                        is_active:  false,
                        // Garde le session_id de la session terminée : les
                        // participants restent traçables et l'historique peut
                        // toujours retrouver l'événement. Un nouveau start
                        // créera une nouvelle session.
                        session_id: currentSession,
                        start_at:   null, // retire de l'agenda / rappels
                        updated_at: new Date().toISOString()
                    },
                    { onConflict: 'guild,event_name' }
                );
            } catch (err) { console.error('endSquad', err); }
        }
        window.GM.showToast(t('sf_squad_ended'), 'success');
        await loadShadowfront();
    }

    async function editSquadSchedule(squad) {
        var db = getDb();
        if (!db) return;
        var sq = sfState.squads[squad];
        if (!sq || !sq.active || !sq.sessionId) return;

        try {
            var currentG = window.GM ? window.GM.getActiveGuild() : 'ALPHA';
            var res = await db.from('event_status').select('start_at')
                .eq('guild', currentG)
                .eq('event_name', SQUAD_EVENT[squad]).maybeSingle();
            if (res.error) throw res.error;

            var currentStartAt = res.data ? res.data.start_at : null;

            window.GM.pickEventStart({
                eventLabel: squadLabel(squad) + ' - ' + t('edit_title'),
                defaultVal: currentStartAt
            }, async function (startAt) {
                if (!startAt) return;

                try {
                    var updateRes = await db.from('event_status').update({
                        start_at: startAt,
                        updated_at: new Date().toISOString()
                    }).eq('guild', currentG)
                      .eq('event_name', SQUAD_EVENT[squad]);
                    if (updateRes.error) throw updateRes.error;

                    var newWeek = window.GM.getWeekStart(startAt);
                    await db.from('shadowfront_squads').update({
                        week_start: newWeek
                    }).eq('guild', currentG)
                      .eq('session_id', sq.sessionId);

                    await db.from('event_participants').update({
                        week_start: newWeek
                    }).eq('guild', currentG)
                      .eq('event_name', EVENT_NAME)
                      .eq('session_id', sq.sessionId);

                    // Recalculate session_id: pass [] to avoid collision check (renaming, not creating)
                    var newSessionId = window.GM.buildEventSessionId(SQUAD_EVENT[squad], new Date(startAt), []);
                    if (newSessionId !== sq.sessionId) {
                        await db.from('event_participants').update({
                            session_id: newSessionId
                        }).eq('guild', currentG)
                          .eq('event_name', EVENT_NAME)
                          .eq('session_id', sq.sessionId);

                        await db.from('shadowfront_squads').update({
                            session_id: newSessionId
                        }).eq('guild', currentG)
                          .eq('session_id', sq.sessionId);

                        await db.from('event_status').update({
                            session_id: newSessionId
                        }).eq('guild', currentG)
                          .eq('event_name', SQUAD_EVENT[squad]);

                        sq.sessionId = newSessionId;
                    }

                    window.GM.showToast(t('toast_member_updated'), 'success');

                    if (window.GM.notifyDiscordEvent) {
                        window.GM.notifyDiscordEvent(SQUAD_EVENT[squad], startAt, 'edit');
                    }

                    await loadShadowfront();
                } catch (err) {
                    console.error('editSquadSchedule update', err);
                    window.GM.showToast(t('toast_err_generic') + ' ' + err.message, 'error');
                }
            });
        } catch (err) {
            console.error('editSquadSchedule fetch', err);
            window.GM.showToast(t('toast_err_generic') + ' ' + err.message, 'error');
        }
    }

    function deleteSquadSession(squad) {
        var db = getDb();
        if (!db) return;
        var sq = sfState.squads[squad];
        if (!sq || !sq.sessionId) return;

        window.showConfirm(
            t('confirm_delete_session_title'),
            '<strong>' + esc(squadLabel(squad)) + '</strong><br>' + t('confirm_delete_session_body'),
            async function () {
                try {
                    var currentG = window.GM ? window.GM.getActiveGuild() : 'ALPHA';
                    // 1. Delete matching participants in event_participants
                    var delPartRes = await db.from('event_participants')
                        .delete()
                        .eq('guild', currentG)
                        .eq('event_name', EVENT_NAME)
                        .eq('session_id', sq.sessionId);
                    if (delPartRes.error) throw delPartRes.error;

                    // 2. Delete matching assignments in shadowfront_squads
                    var delSquadsRes = await db.from('shadowfront_squads')
                        .delete()
                        .eq('guild', currentG)
                        .eq('session_id', sq.sessionId);
                    if (delSquadsRes.error) throw delSquadsRes.error;

                    // 3. Delete from event_status
                    var delStatusRes = await db.from('event_status')
                        .delete()
                        .eq('guild', currentG)
                        .eq('event_name', SQUAD_EVENT[squad]);
                    if (delStatusRes.error) throw delStatusRes.error;

                    window.GM.showToast(t('toast_session_deleted'), 'success');
                    await loadShadowfront();
                } catch (err) {
                    console.error('deleteSquadSession', err);
                    window.GM.showToast(t('toast_err_generic') + ' ' + err.message, 'error');
                }
            }
        );
    }

    // ── Share composition on Discord ───────────────────────────────────────────
    function discordEscape(s) {
        return String(s || '').replace(/([*_~`>])/g, '\\$1');
    }

    async function shareCompositionOnDiscord() {
        var db = getDb();
        if (!db) return;

        var squadField = function (squadKey) {
            var sq = sfState.squads[squadKey];
            var sid = sq ? sq.sessionId : null;
            var members = sfState.assignments.filter(function (a) {
                return a.squad === squadKey && (!sid || a.session_id === sid);
            });

            var fmtList = function (list) {
                if (list.length === 0) return { count: 0, text: 'None yet' };
                var seen = {};
                var uniqueList = [];
                list.forEach(function (a) {
                    if (!seen[a.pseudo]) {
                        seen[a.pseudo] = true;
                        uniqueList.push(a);
                    }
                });
                var str = uniqueList.map(function (a) {
                    return (a.is_commander ? '👑 ' : '') + discordEscape(a.pseudo);
                }).join('\n');
                var formattedText = str.length > 1024 ? str.substring(0, 1020) + '...' : str;
                return { count: uniqueList.length, text: formattedText };
            };

            var participantsRes = fmtList(members.filter(function (a) { return a.role === 'participant'; }));
            var reservesRes = fmtList(members.filter(function (a) { return a.role === 'reserve'; }));

            return {
                participantsCount: participantsRes.count,
                reservesCount: reservesRes.count,
                participantsText: participantsRes.text,
                reservesText: reservesRes.text
            };
        };

        // Share only the squad currently being composed (sfActiveSquad).
        var squadKey = sfActiveSquad === 'squad2' ? 'squad2' : 'squad1';
        var squad = squadField(squadKey);

        var roleId = await window.GM.config.get('discord_role_id_shadowfront') || await window.GM.config.get('discord_role_id');
        var roleMention = '';
        if (roleId) {
            if (typeof window.GM.formatDiscordRoleMention === 'function') {
                roleMention = window.GM.formatDiscordRoleMention(roleId);
            } else {
                var rStr = String(roleId).trim();
                var rMatch = rStr.match(/\d{15,22}/);
                roleMention = rMatch ? '<@&' + rMatch[0] + '>' : rStr;
            }
        }
        
        var content = '📋 **Shadowfront - ' + squadLabel(squadKey) + ' Composition**' + (roleMention ? ' ' + roleMention : '');

        var body = {
            content: content,
            embeds: [
                {
                    title: "Diagnostic Embed UI",
                    color: 9442302,
                    fields: [ { name: "Test", value: "This embed proves the app sends embeds properly.", inline: true } ]
                },
                {
                    title: squadLabel(squadKey),
                    color: 9442302, // Lilac (#8B5CF6)
                    fields: [
                        {
                            name: t('sf_participants') + ' (' + squad.participantsCount + '/20)',
                            value: squad.participantsText || 'None yet',
                            inline: true
                        },
                        {
                            name: t('sf_reserves') + ' (' + squad.reservesCount + '/10)',
                            value: squad.reservesText || 'None yet',
                            inline: true
                        }
                    ],
                    timestamp: new Date().toISOString(),
                    footer: { text: 'FGF Guild Management Tool' }
                }
            ]
        };

        var res = await window.GM.sendDiscordWebhookDetailed('shadowfront', body);
        if (res.ok) {
            window.GM.showToast(t('sf_share_discord_sent'), 'success');
        } else {
            var errMsg = typeof res.error === 'object' ? JSON.stringify(res.error) : res.error;
            window.GM.showToast("Discord Error: " + errMsg, 'error');
        }
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
        var db = getDb();
        if (!db) return;
        var sq = sfState.squads[squad];
        if (!sq) return;

        var currentG = window.GM ? window.GM.getActiveGuild() : 'ALPHA';

        // Si la session n'existe pas encore, la créer automatiquement (inactive) pour permettre la composition avant le lancement
        // Un squad terminé repart aussi sur une session neuve.
        if (!sq.sessionId || sq.ended) {
            sq.sessionId = window.GM.buildEventSessionId(SQUAD_EVENT[squad], sq.startAt || new Date());
            sq.ended = false;
            try {
                await db.from('event_status').upsert({
                    guild: currentG,
                    event_name: SQUAD_EVENT[squad],
                    is_active: false,
                    session_id: sq.sessionId,
                    start_at: null,
                    updated_at: new Date().toISOString()
                }, { onConflict: 'guild,event_name' });
            } catch (err) {
                console.error('auto create squad session error', err);
            }
        }

        var existing = sfState.assignments.filter(function (a) { return a.squad === squad && a.role === role; });
        var max = role === 'participant' ? PARTICIPANTS_MAX : RESERVES_MAX;
        if (existing.length >= max) { window.GM.showToast(t('sf_squad_full'), 'error'); return; }

        var week = window.GM.getWeekStart(sq.startAt || window.GM.sessionDateFromId(sq.sessionId) || new Date());

        // Supprimer une précédente affectation pour ce membre dans cette session pour éviter le conflit 409
        try {
            await db.from('shadowfront_squads').delete()
                .eq('guild', currentG).eq('session_id', sq.sessionId).eq('pseudo', pseudo);
        } catch (delErr) {
            console.warn('delete old assignment error', delErr);
        }

        var upsertRes = await db.from('shadowfront_squads').upsert({
            guild: currentG,
            week_start: week,
            session_id: sq.sessionId,
            pseudo: pseudo,
            squad: squad,
            role: role
        }, { onConflict: 'guild,session_id,pseudo' });

        if (upsertRes.error) {
            console.error('shadowfront_squads upsert error', upsertRes.error);
            window.GM.showToast(t('toast_err_generic') + ' ' + upsertRes.error.message, 'error');
            return;
        }

        await syncParticipantRows(sq.sessionId);
        await loadShadowfront();
    }

    async function unassign(pseudo) {
        var db = getDb();
        if (!db) return;
        var a = sfState.assignments.find(function (x) { return x.pseudo === pseudo; });
        if (!a) {
            var hasSignup = sfState.signups.some(function (s) { return s.pseudo === pseudo; });
            if (hasSignup) {
                await saveAvailability(pseudo, 'none');
            }
            return;
        }
        var g = (a && a.guild) || (window.GM ? window.GM.getActiveGuild() : 'ALPHA');
        try {
            await db.rpc('gm_unsync_shadowfront_participant', {
                p_guild: g,
                p_session_id: a.session_id,
                p_pseudo: pseudo
            });
        } catch (err) {
            console.warn('gm_unsync_shadowfront_participant RPC fallback:', err);
            await db.from('shadowfront_squads').delete()
                .eq('guild', g).eq('session_id', a.session_id).eq('pseudo', pseudo);
            await db.from('event_participants').delete()
                .eq('guild', g).eq('session_id', a.session_id).eq('pseudo', pseudo);
        }
        await loadShadowfront();
    }

    async function toggleCommander(pseudo) {
        var db = getDb();
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
                window.GM.showToast('You can only have up to 3 commanders per squad!', 'error');
                return;
            }
        }

        var currentG = window.GM ? window.GM.getActiveGuild() : 'ALPHA';
        await db.from('shadowfront_squads').update({ is_commander: isNewCommander })
            .eq('guild', currentG).eq('session_id', sq.sessionId).eq('pseudo', pseudo);

        await loadShadowfront();
    }

    // ── Sync participant rows ──────────────────────────────────────────────────
    async function syncParticipantRows(sessionId) {
        var db = getDb();
        if (!db || !sessionId) return;
        var currentG = window.GM ? window.GM.getActiveGuild() : 'ALPHA';
        // Database-side sync: the RPC resolves assignments straight from
        // shadowfront_squads (not the UI state) and inserts missing
        // participants with an index-safe ON CONFLICT. We check the error so
        // a composed squad can never silently end up with zero participants.
        try {
            var res = await db.rpc('gm_sync_shadowfront_participants', {
                p_guild: currentG,
                p_session_id: sessionId
            });
            if (res.error) {
                console.error('syncParticipantRows RPC failed', res.error);
            }
        } catch (err) {
            console.error('syncParticipantRows RPC threw', err);
        }
    }

    async function saveParticipation(pseudo, value) {
        var db = getDb();
        if (!db) return;
        var p = sfState.participants.find(function (x) { return x.pseudo === pseudo; });
        if (!p) return;
        var g = p.guild || (window.GM ? window.GM.getActiveGuild() : 'ALPHA');
        await db.from('event_participants').update({ participated: value })
            .eq('guild', g).eq('event_name', EVENT_NAME).eq('session_id', p.session_id).eq('pseudo', pseudo);
    }

    async function saveLate(pseudo, value) {
        var db = getDb();
        if (!db) return;
        var p = sfState.participants.find(function (x) { return x.pseudo === pseudo; });
        if (!p) return;
        var g = p.guild || (window.GM ? window.GM.getActiveGuild() : 'ALPHA');
        await db.from('event_participants').update({ late: value })
            .eq('guild', g).eq('event_name', EVENT_NAME).eq('session_id', p.session_id).eq('pseudo', pseudo);
    }

    async function saveExcused(pseudo, value) {
        var db = getDb();
        if (!db) return;
        var p = sfState.participants.find(function (x) { return x.pseudo === pseudo; });
        if (!p) return;
        var g = p.guild || (window.GM ? window.GM.getActiveGuild() : 'ALPHA');
        await db.from('event_participants').update({ excused: value })
            .eq('guild', g).eq('event_name', EVENT_NAME).eq('session_id', p.session_id).eq('pseudo', pseudo);
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
            ? window.GM.formatDateTimeUTC(sq.startAt)
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

        // Squad terminé : l'UI se réinitialise. On garde les données en base
        // (historique intact) mais on n'affiche plus les joueurs en disponibilité,
        // la composition passée ni le tracking. Un nouveau Start créera une
        // session neuve.
        if (sq.ended) {
            html +=
                '<div class="gm-empty" style="margin-top: 2rem;">' +
                    '<i class="ph-duotone ph-ghost gm-icon"></i>' +
                    '<div class="gm-empty-title">' + t('event_not_active') + '</div>' +
                    '<div class="gm-empty-hint">' + t('sf_squad_inactive_hint') + '</div>' +
                '</div>';
            area.innerHTML = html;
            attachSFListeners(area);
            return;
        }

        // 2. Stepper navigation (2 steps)
        var hasTrackableSession = currentSessionIds().length > 0;

        if (sfActiveTab === 'tracking' && !hasTrackableSession) {
            sfActiveTab = 'composition';
        }

        var stepBtn = function (key, icon, label, enabled) {
            return '<button class="sf-step' + (sfActiveTab === key ? ' active' : '') + (enabled ? '' : ' disabled') + '" data-tab="' + key + '"' + (enabled ? '' : ' disabled') + '>' +
                '<span class="sf-step-icon"><i class="ph ' + icon + '"></i></span>' +
                '<span class="sf-step-label">' + label + '</span>' +
                (enabled ? '' : '<span class="sf-step-lock"><i class="ph ph-lock-simple"></i></span>') +
            '</button>';
        };

        html +=
            '<div class="sf-stepper" style="margin-bottom: 1.5rem;">' +
                stepBtn('composition', 'ph-users-three', t('sf_step_composition'), true) +
                '<span class="sf-step-sep"></span>' +
                stepBtn('tracking', 'ph-chart-bar', t('sf_step_tracking'), hasTrackableSession) +
            '</div>';

        html +=
            '<div class="input-wrapper" style="margin-bottom: 1.5rem;">' +
                '<i class="ph ph-magnifying-glass"></i>' +
                '<input type="text" class="sf-search-input" placeholder="' + t('search_placeholder') + '">' +
            '</div>';

        // ── Panel: Composition ──────────────────────────────────────────────────
        if (sfActiveTab === 'composition') {
            var assignedPseudos = sfState.assignments.map(function (a) { return a.pseudo; });

            // Member pool: all guild members not currently assigned to any squad
            var poolPseudos = sfState.allMembers.filter(function (pseudo) {
                return assignedPseudos.indexOf(pseudo) === -1;
            });

            var confirmedParticipants = sfState.assignments.filter(function (a) {
                return a.squad === sfActiveSquad && a.role === 'participant';
            });
            var confirmedReserves = sfState.assignments.filter(function (a) {
                return a.squad === sfActiveSquad && a.role === 'reserve';
            });
            var squadParticipants = sortSquadList(confirmedParticipants);
            var squadReserves = sortSquadList(confirmedReserves);

            var rateOf = function (pseudo) {
                var h = sfState.history[pseudo];
                return (h && h.assigned > 0) ? (h.participated / h.assigned) : 0;
            };

            var rateSum = 0, rateCount = 0;
            confirmedParticipants.forEach(function (a) {
                if (sfState.history[a.pseudo] && sfState.history[a.pseudo].assigned > 0) {
                    rateSum += rateOf(a.pseudo);
                    rateCount++;
                }
            });
            var avgRate = rateCount > 0 ? Math.round((rateSum / rateCount) * 100) + '%' : 'N/A';

            html += '<div class="sf-sub-panel active">';
            html += '<div class="sf-compose-bar" style="display:flex; justify-content:space-between; align-items:center; gap:0.75rem; flex-wrap:wrap; margin-bottom:1rem;">' +
                '<div class="sf-compose-summary" style="display:flex; gap:0.5rem; flex-wrap:wrap;">' +
                    '<span class="stat-chip"><i class="ph-fill ph-users"></i> ' + t('sf_pool') + ': ' + poolPseudos.length + '</span>' +
                    '<span class="stat-chip"><i class="ph-fill ph-shield-check"></i> ' + t('sf_participants') + ': ' + confirmedParticipants.length + '/20</span>' +
                    '<span class="stat-chip"><i class="ph-fill ph-clock-countdown"></i> ' + t('sf_reserves') + ': ' + confirmedReserves.length + '/10</span>' +
                    '<span class="stat-chip"><i class="ph-fill ph-chart-line"></i> ' + t('sf_avg_rate') + ': ' + avgRate + '</span>' +
                '</div>' +
                '<div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap;">' +
                    '<div class="sf-sort-toggle" style="display:flex; gap:0.25rem;">' +
                        '<button class="gm-btn gm-btn-xs sf-sort-btn' + (sfSort === 'rate' ? ' sf-sort-active' : '') + '" data-sort="rate" title="' + t('sf_sort_rate') + '"><i class="ph ph-chart-pie"></i> ' + t('sf_sort_rate') + '</button>' +
                        '<button class="gm-btn gm-btn-xs sf-sort-btn' + (sfSort === 'power' ? ' sf-sort-active' : '') + '" data-sort="power" title="' + t('sf_sort_power') + '"><i class="ph ph-lightning"></i> ' + t('sf_sort_power') + '</button>' +
                    '</div>' +
                    '<button class="gm-btn sf-share-discord-btn" style="display: inline-flex; align-items: center; gap: 0.4rem;"><i class="ph ph-paper-plane-tilt"></i> ' + t('sf_share_discord') + '</button>' +
                '</div>' +
            '</div>';
            html += '<div class="sf-layout">';

            // Column 1: Declared pool (not confirmed yet)
            html +=
                '<div class="sf-column sf-unassigned">' +
                '<div class="sf-col-header"><i class="ph-fill ph-users-three"></i> ' + t('sf_pool') +
                    ' <span class="count-badge">' + poolPseudos.length + '</span></div>';

            html +=
                '<div class="sf-filter-tabs" style="padding: 0.5rem; justify-content: center; gap: 0.2rem;">' +
                    '<button class="sf-filter-btn' + (sfFilter === 'all'      ? ' active' : '') + '" data-filter="all">' + t('sf_filter_all') + '</button>' +
                    '<button class="sf-filter-btn' + (sfFilter === 'excellent'? ' active' : '') + '" data-filter="excellent">🟢 ' + t('sf_filter_excellent').split(' (')[0] + ' <span>' + countRate(poolPseudos, 'excellent') + '</span></button>' +
                    '<button class="sf-filter-btn' + (sfFilter === 'good'     ? ' active' : '') + '" data-filter="good">🔵 ' + t('sf_filter_good').split(' (')[0] + ' <span>' + countRate(poolPseudos, 'good') + '</span></button>' +
                    '<button class="sf-filter-btn' + (sfFilter === 'average'  ? ' active' : '') + '" data-filter="average">🟡 ' + t('sf_filter_average').split(' (')[0] + ' <span>' + countRate(poolPseudos, 'average') + '</span></button>' +
                    '<button class="sf-filter-btn' + (sfFilter === 'poor'     ? ' active' : '') + '" data-filter="poor">🔴 ' + t('sf_filter_poor').split(' (')[0] + ' <span>' + countRate(poolPseudos, 'poor') + '</span></button>' +
                    '<button class="sf-filter-btn' + (sfFilter === 'none'     ? ' active' : '') + '" data-filter="none">⚫ ' + t('sf_filter_none').split(' /')[0] + ' <span>' + countRate(poolPseudos, 'none') + '</span></button>' +
                '</div>';

            var sortedPool = poolPseudos.slice().sort(function (a, b) {
                if (sfSort === 'power') return getMemberPower(b) - getMemberPower(a);
                var ra = rateOf(a), rb = rateOf(b);
                if (rb !== ra) return rb - ra;
                return getMemberPower(b) - getMemberPower(a);
            });
            var filteredPool = sortedPool.filter(function (p) {
                return sfFilter === 'all' ? true : categorise(p) === sfFilter;
            });

            html += '<div class="sf-col-body" style="max-height: 480px; overflow-y: auto;">';
            if (filteredPool.length === 0) {
                html += '<div class="sf-empty">' + (poolPseudos.length === 0 ? t('sf_pool_empty') : t('sf_no_match_filter')) + '</div>';
            } else {
                filteredPool.forEach(function (pseudo) {
                    var cat   = categorise(pseudo);
                    var meta  = categoryMeta(cat);
                    var h     = sfState.history[pseudo] || { assigned: 0, participated: 0, excused_count: 0 };
                    var missed = h.assigned - h.participated;
                    var rateText = h.assigned > 0
                        ? Math.round((h.participated / h.assigned) * 100) + '%'
                        : 'N/A';
                    var stats = h.assigned > 0
                        ? '<span class="sf-hist-stat">' + h.participated + '/' + h.assigned + '</span>'
                        : '<span class="sf-hist-stat">-</span>';
                    var tooltipText = h.assigned > 0
                        ? h.participated + ' Play / ' + missed + ' Miss / ' + h.excused_count + ' Exc'
                        : 'No history';

                    var member = sfState.membersData.find(function (m) { return m.pseudo === pseudo; });
                    var powerVal = member ? parseInt(member.overall_power) || 0 : 0;
                    var pTier = window.GM.getPowerTier(powerVal, sfState.maxPower);
                    var pMeta = window.GM.getPowerTierMeta(pTier);
                    var formattedPower = powerVal > 0 ? window.GM.formatPower(powerVal) : '';

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
            html += '</div></div>'; // Column 1: Pool

            // Columns 2 & 3: Participants & Reserves
            html += renderSquadColumn(sfActiveSquad, squadParticipants, squadReserves);
            html += '</div>'; // sf-layout
            html += '</div>'; // active sub panel
        }

        // ── Panel: Tracking ────────────────────────────────────────────────────
        else if (sfActiveTab === 'tracking') {
            if (!sq || !sq.sessionId) {
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

    function renderAvailabilityPool(squadKey) {
        var declared = sfState.signups.filter(function (s) {
            return s.availability === squadKey || s.availability === 'both';
        }).map(function (s) { return s.pseudo; });

        var sorted = declared.slice().sort(function (a, b) {
            return getMemberPower(b) - getMemberPower(a);
        });

        var html =
            '<div class="sf-column sf-avail-pool">' +
            '<div class="sf-col-header squad-header ' + squadKey + '"><i class="ph-fill ph-users-three"></i> ' + squadLabel(squadKey) + ' - ' + t('sf_declared') +
                ' <span class="count-badge">' + declared.length + '</span></div>' +
            '<div class="sf-col-body" style="max-height: 520px; overflow-y: auto;">';

        if (sorted.length === 0) {
            html += '<div class="sf-empty">' + t('sf_pool_empty') + '</div>';
        } else {
            sorted.forEach(function (pseudo) {
                var member = sfState.membersData.find(function (m) { return m.pseudo === pseudo; });
                var powerVal = member ? parseInt(member.overall_power) || 0 : 0;
                var pTier = window.GM.getPowerTier(powerVal, sfState.maxPower);
                var pMeta = window.GM.getPowerTierMeta(pTier);
                var powerBadge = powerVal > 0
                    ? '<span class="gm-chip" style="font-size:0.68rem; padding:0.05rem 0.2rem; color:' + pMeta.color + '; border:1px solid ' + pMeta.color + '22; background:' + pMeta.color + '05; display:inline-flex; align-items:center; gap:0.15rem;"><span style="font-size:0.75rem;">' + pMeta.icon + '</span> ' + window.GM.formatPower(powerVal) + '</span>'
                    : '';

                html +=
                    '<div class="sf-member-row" style="display:flex; align-items:center; gap:0.4rem; padding:0.45rem 0.6rem; border-bottom:1px solid rgba(255,255,255,0.04);">' +
                        '<span style="flex:1; display:flex; align-items:center; gap:0.4rem; min-width:0; overflow:hidden;">' +
                            getParticipationBadgeHtml(pseudo) +
                            '<span class="sf-pseudo" style="font-size:0.83rem; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' + esc(pseudo) + '</span>' +
                            powerBadge +
                        '</span>' +
                        '<button class="sf-btn sf-avail-remove-btn" data-pseudo="' + esc(pseudo) + '" title="' + t('sf_remove_avail') + '" style="background:none; border:none; color:var(--fg-dim); cursor:pointer; padding:0.2rem;"><i class="ph ph-x"></i></button>' +
                    '</div>';
            });
        }

        html += '</div></div>';
        return html;
    }

    function countRate(pseudos, cat) {
        var n = 0;
        pseudos.forEach(function (p) { if (categorise(p) === cat) n++; });
        return n;
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
            reserves.forEach(function (a) { html += renderAssignedRow(a.pseudo, false, a.is_commander); });
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

        var member = sfState.membersData.find(function (m) { return m.pseudo === pseudo; });
        var powerVal = member ? parseInt(member.overall_power) || 0 : 0;
        var pTier = window.GM.getPowerTier(powerVal, sfState.maxPower);
        var pMeta = window.GM.getPowerTierMeta(pTier);
        var formattedPower = powerVal > 0 ? window.GM.formatPower(powerVal) : '';
        var powerBadge = powerVal > 0
            ? '<span class="gm-chip" style="font-size:0.68rem; padding:0.05rem 0.2rem; color:' + pMeta.color + '; border:1px solid ' + pMeta.color + '22; background:' + pMeta.color + '05; display:inline-flex; align-items:center; gap:0.15rem; margin-right: 0.25rem;"><span style="font-size:0.75rem;">' + pMeta.icon + '</span> ' + formattedPower + '</span>'
            : '';

        var rowStyle = 'display: flex; align-items: center; justify-content: space-between; padding: 0.5rem 0.6rem; border-radius: 6px; background: rgba(0,0,0,0.15); border: 1px solid transparent; gap: 0.4rem; font-size: 0.85rem;';

        return '<div class="sf-assigned-row" style="' + rowStyle + '">' +
            '<span class="sf-rate-badge ' + meta.cls + '" style="font-size: 0.7rem; padding: 0.1rem 0.35rem; margin-right: 0.25rem;">' + rateText + '</span>' +
            '<span class="sf-pseudo" title="' + esc(tooltipText) + '" style="font-weight: 500; font-size: 0.85rem; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 0.25rem;">' + 
                esc(pseudo) +
            '</span>' +
            powerBadge +
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
                '<div class="event-stats" style="margin-bottom: 1rem; display: flex; align-items: center; flex-wrap: wrap; gap: 0.5rem;">' +
                    '<span class="stat-chip"><i class="ph-fill ph-users"></i> ' + participants.length + ' ' + t('event_total') + '</span>' +
                    '<span class="stat-chip success"><i class="ph-fill ph-check-circle"></i> ' + done + ' ' + t('event_participated') + '</span>' +
                    '<button type="button" class="gm-btn gm-btn-sm sf-all-present-btn" style="font-size: 0.8rem; padding: 0.25rem 0.5rem;"><i class="ph ph-check-square"></i> ' + t('sf_all_present') + '</button>' +
                    '<button type="button" class="gm-btn gm-btn-sm sf-all-absent-btn" style="font-size: 0.8rem; padding: 0.25rem 0.5rem;"><i class="ph ph-square"></i> ' + t('sf_all_absent') + '</button>' +
                    '<span class="sf-saved-flash" style="opacity:0; transition: opacity 0.3s; font-size:0.78rem; color:var(--success);"></span>' +
                '</div>' +
                '<div class="participants-table-wrap"><table class="participants-table"><thead><tr>' +
                    '<th>' + t('col_member') + '</th>' +
                    '<th>' + t('sf_squad_col') + '</th>' +
                    '<th class="center">' + t('col_participated') + '</th>' +
                    '<th class="center">Late</th>' +
                    '<th class="center">Excused</th>' +
                    '<th class="center">Sub Present</th>' +
                    '<th style="width: 60px; text-align: right;">Actions</th>' +
                '</tr></thead><tbody>';

        participants.forEach(function (p) {
            var assignment = sfState.assignments.find(function (a) { return a.pseudo === p.pseudo; });
            var squadLbl = assignment
                ? squadLabel(assignment.squad) + ' - ' + (assignment.role === 'participant' ? t('sf_participant') : t('sf_reserve'))
                : '-';
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

            var rowClass = 'participant-row' + (isChecked ? ' participated' : '');

            html +=
                '<tr class="' + rowClass + '">' +
                    '<td class="pseudo-cell" style="display: flex; align-items: center; gap: 0.5rem;">' +
                        '<span class="sf-rate-badge ' + meta.cls + '" style="font-size: 0.7rem; padding: 0.1rem 0.35rem;">' + rateText + '</span>' +
                        '<strong style="font-size: 0.88rem;">' + esc(p.pseudo) + '</strong>' +
                    '</td>' +
                    '<td><span class="squad-chip ' + (assignment ? assignment.squad : '') + '">' + squadLbl + '</span></td>' +
                    '<td class="check-cell">' +
                        '<label class="check-toggle">' +
                            '<input type="checkbox" class="participation-checkbox sf-participation-checkbox" data-pseudo="' + esc(p.pseudo) + '"' + (isChecked ? ' checked' : '') + '>' +
                            '<span class="check-slider"></span>' +
                        '</label>' +
                    '</td>' +
                    '<td class="check-cell">' +
                        '<label class="check-toggle check-toggle-warning">' +
                            '<input type="checkbox" class="sf-late-checkbox" data-pseudo="' + esc(p.pseudo) + '"' + (isLateChecked ? ' checked' : '') + '>' +
                            '<span class="check-slider"></span>' +
                        '</label>' +
                    '</td>' +
                    '<td class="check-cell">' +
                        '<label class="check-toggle check-toggle-info">' +
                            '<input type="checkbox" class="sf-excused-checkbox" data-pseudo="' + esc(p.pseudo) + '"' + (isExcusedChecked ? ' checked' : '') + '>' +
                            '<span class="check-slider"></span>' +
                        '</label>' +
                    '</td>' +
                    '<td class="check-cell">' +
                        '<label class="check-toggle check-toggle-accent">' +
                            '<input type="checkbox" class="sf-sub-present-checkbox" data-pseudo="' + esc(p.pseudo) + '"' + (isSubPresentChecked ? ' checked' : '') + '>' +
                            '<span class="check-slider"></span>' +
                        '</label>' +
                    '</td>' +
                    '<td style="white-space: nowrap; text-align: right;"><button class="delete-btn sf-delete-participant-btn" data-pseudo="' + esc(p.pseudo) + '" title="' + t('delete_title') + '"><i class="ph ph-trash"></i></button></td>' +
                '</tr>';
        });

        html += '</tbody></table></div></div>';
        return html;
    }

    async function bulkAddAvailability(squad) {
        var db = getDb();
        if (!db) return;
        var week = window.GM.getWeekStart();
        var currentG = window.GM ? window.GM.getActiveGuild() : 'ALPHA';
        var pseudos = Object.keys(sfSelected).filter(function (p) { return sfSelected[p]; });
        if (pseudos.length === 0) return;

        try {
            await db.from('shadowfront_signups').upsert(
                pseudos.map(function (pseudo) {
                    return { guild: currentG, week_start: week, pseudo: pseudo, availability: squad };
                }),
                { onConflict: 'guild,week_start,pseudo' }
            );
            sfSelected = {};
            window.GM.showToast(t('sf_avail_bulk').replace('{n}', pseudos.length).replace('{squad}', squadLabel(squad)), 'success');
            await loadShadowfront();
        } catch (err) {
            console.error('bulkAddAvailability failed', err);
            window.GM.showToast(t('toast_err_generic') + ' ' + err.message, 'error');
        }
    }

    async function bulkSetParticipation(value) {
        var db = getDb();
        if (!db) return;
        var sq = sfState.squads[sfActiveSquad];
        if (!sq || !sq.sessionId) return;
        try {
            var currentG = window.GM ? window.GM.getActiveGuild() : 'ALPHA';
            await db.from('event_participants').update({ participated: value })
                .eq('guild', currentG).eq('event_name', EVENT_NAME).eq('session_id', sq.sessionId);
            sfState.participants.forEach(function (p) {
                if (p.session_id === sq.sessionId) p.participated = value;
            });
            renderShadowfront();
            flashSaved();
        } catch (err) {
            console.error('bulkSetParticipation failed', err);
            window.GM.showToast(t('toast_err_generic') + ' ' + err.message, 'error');
        }
    }

    function flashSaved() {
        var el = document.querySelector('#event-shadowfront .sf-saved-flash');
        if (!el) return;
        el.textContent = t('sf_saved');
        el.style.opacity = '1';
        setTimeout(function () { el.style.opacity = '0'; }, 1500);
    }

    async function saveAvailability(pseudo, availability) {
        var db = getDb();
        if (!db) return;
        var week = window.GM.getWeekStart();
        var currentG = window.GM ? window.GM.getActiveGuild() : 'ALPHA';
        try {
            if (availability === 'none') {
                await db.from('shadowfront_signups').delete().eq('guild', currentG).eq('week_start', week).eq('pseudo', pseudo);
            } else {
                await db.from('shadowfront_signups').upsert({
                    guild: currentG,
                    week_start: week,
                    pseudo: pseudo,
                    availability: availability
                }, { onConflict: 'guild,week_start,pseudo' });
            }
            window.GM.showToast(pseudo + '\'s availability updated', 'success');
            await loadShadowfront();
        } catch (err) {
            console.error('saveAvailability failed', err);
            window.GM.showToast('Failed to save availability', 'error');
        }
    }

    async function saveSubPresent(pseudo, value) {
        var db = getDb();
        if (!db) return;
        var p = sfState.participants.find(function (x) { return x.pseudo === pseudo; });
        if (!p) return;
        var g = p.guild || (window.GM ? window.GM.getActiveGuild() : 'ALPHA');
        await db.from('event_participants').update({ sub_present: value })
            .eq('guild', g).eq('event_name', EVENT_NAME).eq('session_id', p.session_id).eq('pseudo', pseudo);
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
                window.GM.pickEventStart({ eventLabel: 'Shadowfront - ' + squadLabel(squad) }, function (startAt) {
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

        area.querySelectorAll('.sf-select-cb').forEach(function (cb) {
            cb.addEventListener('change', function () {
                var pseudo = cb.getAttribute('data-pseudo');
                sfSelected[pseudo] = cb.checked;
                if (!cb.checked) delete sfSelected[pseudo];
                renderShadowfront();
            });
        });
        area.querySelectorAll('.sf-bulk-add-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                bulkAddAvailability(btn.getAttribute('data-squad'));
            });
        });
        area.querySelectorAll('.sf-avail-remove-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                saveAvailability(btn.getAttribute('data-pseudo'), 'none');
            });
        });
        area.querySelectorAll('.sf-sort-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                sfSort = btn.getAttribute('data-sort');
                renderShadowfront();
            });
        });

        var allPresentBtn = area.querySelector('.sf-all-present-btn');
        if (allPresentBtn) {
            allPresentBtn.addEventListener('click', function () { bulkSetParticipation(1); });
        }
        var allAbsentBtn = area.querySelector('.sf-all-absent-btn');
        if (allAbsentBtn) {
            allAbsentBtn.addEventListener('click', function () { bulkSetParticipation(0); });
        }

        function refreshStats() {
            var done = sfState.participants.filter(function (p) { return p.participated > 0; }).length;
            var chip = area.querySelector('.event-stats .stat-chip.success');
            if (chip) {
                chip.innerHTML = '<i class="ph-fill ph-check-circle"></i> ' + done + ' ' + t('event_participated');
            }
        }

        area.querySelectorAll('.sf-participation-checkbox').forEach(function (cb) {
            cb.addEventListener('change', function () {
                var next = cb.checked ? 1 : 0;
                var row  = cb.closest('.participant-row');
                if (row) row.classList.toggle('participated', cb.checked);

                var pseudo = cb.getAttribute('data-pseudo');
                var pp = sfState.participants.find(function (p) { return p.pseudo === pseudo; });
                if (pp) pp.participated = next;
                refreshStats();

                saveParticipation(pseudo, next).then(flashSaved);
            });
        });
        area.querySelectorAll('.sf-late-checkbox').forEach(function (cb) {
            cb.addEventListener('change', function () {
                var pseudo = cb.getAttribute('data-pseudo');
                saveLate(pseudo, cb.checked).then(function () {
                    var pp = sfState.participants.find(function (p) { return p.pseudo === pseudo; });
                    if (pp) pp.late = cb.checked;
                    flashSaved();
                });
            });
        });
        area.querySelectorAll('.sf-excused-checkbox').forEach(function (cb) {
            cb.addEventListener('change', function () {
                var pseudo = cb.getAttribute('data-pseudo');
                saveExcused(pseudo, cb.checked).then(function () {
                    var pp = sfState.participants.find(function (p) { return p.pseudo === pseudo; });
                    if (pp) pp.excused = cb.checked;
                    flashSaved();
                });
            });
        });
        area.querySelectorAll('.sf-sub-present-checkbox').forEach(function (cb) {
            cb.addEventListener('change', function () {
                var pseudo = cb.getAttribute('data-pseudo');
                saveSubPresent(pseudo, cb.checked).then(function () {
                    var pp = sfState.participants.find(function (p) { return p.pseudo === pseudo; });
                    if (pp) pp.sub_present = cb.checked;
                    flashSaved();
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
                        var g = p.guild || (window.GM ? window.GM.getActiveGuild() : 'ALPHA');
                        await db.from('event_participants').delete()
                            .eq('guild', g)
                            .eq('event_name', EVENT_NAME)
                            .eq('session_id', p.session_id)
                            .eq('pseudo', pseudo);
                        loadShadowfront();
                    }
                );
            });
        });

        var shareBtn = area.querySelector('.sf-share-discord-btn');
        if (shareBtn) {
            shareBtn.addEventListener('click', shareCompositionOnDiscord);
        }

        area.querySelectorAll('.sf-step').forEach(function (btn) {
            btn.addEventListener('click', function () {
                sfActiveTab = btn.getAttribute('data-tab');
                renderShadowfront();
            });
        });

        var searchInput = area.querySelector('.sf-search-input');
        if (searchInput) {
            searchInput.addEventListener('input', function (e) {
                var q = e.target.value.toLowerCase();
                area.querySelectorAll('.sf-member-row, .sf-assigned-row, .sf-entry-row').forEach(function (row) {
                    var btn = row.querySelector('.sf-btn, .sf-remove-btn, .sf-select-cb');
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
