/**
 * gm-leader-hall.js — Guild Leader Hall (Accordions, Global Channels, 1:1, Groups & Diplomatic Treaties)
 * FGF Guild Management Tool — 2026 Zero-Trust Architecture
 *
 * Implements:
 * 1. 4 Collapsible Spaces (Global Lounge, 1:1 Direct, Group Discussions, R5 Summit)
 * 2. Diplomatic Treaties Registry & Multi-Guild Signing Protocol
 * 3. Discussion Actions (Delete, Leave Group, Block/Unblock Leader)
 * 4. 1:1 Double Ratchet E2EE Sessions with X3DH handshake
 * 5. Group Discussions with Signal Sender Keys & forward secrecy
 * 6. Realtime messaging subscription & Presence engine
 * 7. Safety Numbers verification modal (60-digit fingerprint)
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.GM_LEADER_HALL = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var DIPLOMACY_CHANNEL_ID = '00000000-0000-0000-0000-000000000002';

    var GLOBAL_CHANNELS = [
        { id: '00000000-0000-0000-0000-000000000001', type: 'global', title: 'Global Lounge', subtitle: 'General lounge for all guild leaders', icon: 'ph ph-chat-circle-dots' },
        { id: DIPLOMACY_CHANNEL_ID, type: 'global', title: 'Diplomacy & Treaties', subtitle: 'Inter-guild N.A.P., pacts & official treaty signings', icon: 'ph ph-scroll' }
    ];

    var currentConversation = null;
    var conversationsList = [];
    var treatiesList = [];
    var treatyFilter = 'all'; // 'all' | 'ratified' | 'pending' | 'mine'
    var blockedAccountIds = new Set();
    var realtimeChannel = null;
    var treatiesRealtimeChannel = null;
    var localIdentity = null;
    var activeAccounts = [];
    var availableGuilds = [];
    var decryptedCache = {}; // messageId -> plaintext
    var unreadCounts = {}; // convId -> number of unread messages
    var lastReadMessageIds = {}; // convId -> highest message id read
    var globalUnreadChannel = null;

    // ─── Rich Messaging State: Mentions, Reactions & Quoted Replies ──────────
    var replyingTo = null; // { id, sender, guild, snippet }
    var messageReactions = {}; // messageId -> [{ emoji, account_id }]
    var reactionsRealtimeChannel = null;
    var mentionCandidates = [];
    var mentionSelectedIndex = 0;
    var mentionActiveQuery = '';
    var QUICK_EMOJIS = ['👍', '❤️', '🔥', '⚔️', '🛡️', '😂', '👏', '🚀'];

    function parseMessagePayload(raw) {
        if (!raw) return { text: '', replyTo: null };
        if (typeof raw === 'string' && raw.trim().startsWith('{')) {
            try {
                var parsed = JSON.parse(raw);
                if (parsed && typeof parsed.text === 'string') {
                    return {
                        text: parsed.text,
                        replyTo: parsed.replyTo || null
                    };
                }
            } catch (e) {}
        }
        return { text: String(raw), replyTo: null };
    }

    function formatMessageBody(text, currentAccountId) {
        if (!text) return '';
        var safe = esc(text);
        safe = safe.replace(/@([a-zA-Z0-9_\-\.]+)/g, function (match, username) {
            var isMe = currentAccountId && username.toLowerCase() === currentAccountId.toLowerCase();
            return '<span class="gm-mention-badge ' + (isMe ? 'is-me' : '') + '" data-mention="' + esc(username) + '">@' + esc(username) + '</span>';
        });
        return safe.replace(/\n/g, '<br>');
    }

    function aggregateReactions(reactionsList, currentAccountId) {
        if (!reactionsList || reactionsList.length === 0) return [];
        var map = {};
        reactionsList.forEach(function (r) {
            if (!r || !r.emoji) return;
            if (!map[r.emoji]) {
                map[r.emoji] = { emoji: r.emoji, count: 0, users: [], hasReacted: false };
            }
            map[r.emoji].count++;
            map[r.emoji].users.push(r.account_id);
            if (r.account_id === currentAccountId) {
                map[r.emoji].hasReacted = true;
            }
        });
        return Object.values(map);
    }

    function setReplyingTo(replyObj) {
        if (!replyObj) {
            clearReplyingTo();
            return;
        }
        replyingTo = {
            id: replyObj.id,
            sender: replyObj.sender,
            guild: replyObj.guild,
            snippet: (replyObj.snippet || '').slice(0, 100)
        };

        var previewEl = document.getElementById('leader-hall-reply-preview');
        var senderEl = document.getElementById('leader-hall-reply-sender');
        var textEl = document.getElementById('leader-hall-reply-text');
        var input = document.getElementById('leader-hall-msg-input');

        if (senderEl) {
            senderEl.innerHTML = '<i class="ph ph-arrow-bend-up-left"></i> Replying to ' + formatLeaderHtml(replyingTo.sender, replyingTo.guild);
        }
        if (textEl) {
            textEl.innerText = replyingTo.snippet + ((replyObj.snippet && replyObj.snippet.length > 100) ? '...' : '');
        }
        if (previewEl) {
            previewEl.classList.remove('hidden');
        }
        if (input) {
            input.focus();
        }
    }

    function clearReplyingTo() {
        replyingTo = null;
        var previewEl = document.getElementById('leader-hall-reply-preview');
        if (previewEl) previewEl.classList.add('hidden');
    }

    async function fetchReactions(convId) {
        var db = getDb();
        if (!db || !convId) return;
        try {
            var res = await db
                .from('e2ee_message_reactions')
                .select('message_id, account_id, emoji')
                .eq('conversation_id', convId);

            var grouped = {};
            (res.data || []).forEach(function (r) {
                var mid = String(r.message_id);
                if (!grouped[mid]) grouped[mid] = [];
                grouped[mid].push(r);
            });
            messageReactions = grouped;
        } catch (e) {
            console.error('Error fetching reactions', e);
        }
    }

    async function handleToggleReaction(messageId, emoji) {
        var db = getDb();
        if (!db || !messageId || !emoji) return;

        try {
            var res = await db.rpc('gm_toggle_e2ee_reaction', {
                p_message_id: Number(messageId),
                p_emoji: emoji
            });

            if (res.error) throw res.error;

            if (currentConversation) {
                await fetchReactions(currentConversation.id);
                renderMessageReactionsRow(messageId);
            }
        } catch (err) {
            console.error('Error toggling reaction', err);
            if (window.GM && window.GM.showToast) {
                window.GM.showToast('Could not react: ' + (err.message || err), 'danger');
            }
        }
    }

    function renderMessageReactionsRow(messageId) {
        var rowEl = document.getElementById('msg-row-' + messageId);
        if (!rowEl) return;
        var bubbleEl = rowEl.querySelector('.gm-message-bubble');
        if (!bubbleEl) return;

        var existingRow = bubbleEl.querySelector('.gm-message-reactions-row');
        var acc = getAccount();
        var accId = acc ? (acc.id || acc.account_id) : '';
        var msgReactions = messageReactions[String(messageId)] || [];
        var agg = aggregateReactions(msgReactions, accId);

        if (agg.length === 0) {
            if (existingRow) existingRow.remove();
            rowEl.classList.remove('has-reactions');
            return;
        }

        rowEl.classList.add('has-reactions');
        var html = '<div class="gm-message-reactions-row">';
        agg.forEach(function (ag) {
            var userList = ag.users.join(', ');
            html +=
                '<button type="button" class="gm-reaction-pill ' + (ag.hasReacted ? 'has-reacted' : '') + '" data-msg-id="' + esc(String(messageId)) + '" data-emoji="' + esc(ag.emoji) + '" title="Reacted by ' + esc(userList) + '">' +
                    '<span>' + esc(ag.emoji) + '</span>' +
                    '<span class="gm-reaction-count">' + ag.count + '</span>' +
                '</button>';
        });
        html += '</div>';

        if (existingRow) {
            existingRow.outerHTML = html;
        } else {
            bubbleEl.insertAdjacentHTML('beforeend', html);
        }

        var newRow = bubbleEl.querySelector('.gm-message-reactions-row');
        if (newRow) {
            newRow.querySelectorAll('.gm-reaction-pill').forEach(function (pill) {
                pill.onclick = function (e) {
                    e.stopPropagation();
                    var mid = pill.getAttribute('data-msg-id');
                    var em = pill.getAttribute('data-emoji');
                    handleToggleReaction(mid, em);
                };
            });
        }
    }

    function getMentionCandidates(query) {
        var map = new Map();
        if (currentConversation && currentConversation.members) {
            currentConversation.members.forEach(function (m) {
                map.set(m.account_id, { id: m.account_id, guild: m.guild, role: m.role, server_number: m.server_number });
            });
        }
        activeAccounts.forEach(function (a) {
            if (!map.has(a.id)) {
                map.set(a.id, { id: a.id, guild: a.guild, role: a.role, server_number: a.server_number });
            }
        });

        var all = Array.from(map.values());
        if (!query) return all.slice(0, 7);
        var q = query.toLowerCase();
        return all.filter(function (c) {
            return c.id.toLowerCase().includes(q) || (c.guild && c.guild.toLowerCase().includes(q));
        }).slice(0, 7);
    }

    function renderMentionPopup() {
        var popup = document.getElementById('leader-hall-mention-popup');
        if (!popup) return;

        if (mentionCandidates.length === 0) {
            popup.classList.add('hidden');
            return;
        }

        var html = mentionCandidates.map(function (c, idx) {
            var isSel = (idx === mentionSelectedIndex);
            var sNum = resolveLeaderServer(c.id, c.guild, c.server_number);
            var gTag = c.guild ? '[' + esc(c.guild) + '] ' : '';
            return '<div class="gm-mention-item ' + (isSel ? 'is-selected' : '') + '" data-index="' + idx + '" data-id="' + esc(c.id) + '">' +
                '<div style="display:flex; align-items:center; gap:0.4rem;">' +
                    '<span class="gm-sender-guild" style="font-size:0.75rem; font-weight:700;">' + gTag + '</span>' +
                    '<span class="gm-mention-item-name">' + esc(c.id) + '</span>' +
                '</div>' +
                '<span class="gm-mention-item-server">#' + esc(sNum) + '</span>' +
            '</div>';
        }).join('');

        popup.innerHTML = html;
        popup.classList.remove('hidden');

        popup.querySelectorAll('.gm-mention-item').forEach(function (item) {
            item.onclick = function (e) {
                e.stopPropagation();
                var idx = Number(item.getAttribute('data-index'));
                applyMentionSelection(mentionCandidates[idx]);
            };
        });
    }

    function applyMentionSelection(candidate) {
        if (!candidate) return;
        var input = document.getElementById('leader-hall-msg-input');
        if (!input) return;

        var val = input.value;
        var cursor = input.selectionStart || val.length;
        var textBefore = val.slice(0, cursor);
        var textAfter = val.slice(cursor);

        var match = textBefore.match(/@([a-zA-Z0-9_\-\.]*)$/);
        if (match) {
            var replaceStart = textBefore.length - match[0].length;
            var newBefore = textBefore.slice(0, replaceStart) + '@' + candidate.id + ' ';
            input.value = newBefore + textAfter;
            var newCursor = newBefore.length;
            input.setSelectionRange(newCursor, newCursor);
        }

        var popup = document.getElementById('leader-hall-mention-popup');
        if (popup) popup.classList.add('hidden');
        mentionCandidates = [];
        input.focus();
    }

    function initMentionAutocomplete() {
        var input = document.getElementById('leader-hall-msg-input');
        var popup = document.getElementById('leader-hall-mention-popup');
        if (!input) return;

        input.addEventListener('input', function () {
            var val = input.value;
            var cursor = input.selectionStart || val.length;
            var textBefore = val.slice(0, cursor);
            var match = textBefore.match(/@([a-zA-Z0-9_\-\.]*)$/);

            if (match) {
                mentionActiveQuery = match[1];
                mentionCandidates = getMentionCandidates(mentionActiveQuery);
                mentionSelectedIndex = 0;
                renderMentionPopup();
            } else {
                if (popup) popup.classList.add('hidden');
                mentionCandidates = [];
            }
        });

        input.addEventListener('keydown', function (e) {
            if (popup && !popup.classList.contains('hidden') && mentionCandidates.length > 0) {
                if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    mentionSelectedIndex = (mentionSelectedIndex + 1) % mentionCandidates.length;
                    renderMentionPopup();
                    return;
                }
                if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    mentionSelectedIndex = (mentionSelectedIndex - 1 + mentionCandidates.length) % mentionCandidates.length;
                    renderMentionPopup();
                    return;
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                    e.preventDefault();
                    applyMentionSelection(mentionCandidates[mentionSelectedIndex]);
                    return;
                }
                if (e.key === 'Escape') {
                    e.preventDefault();
                    popup.classList.add('hidden');
                    mentionCandidates = [];
                    return;
                }
            }
        });

        document.addEventListener('click', function (e) {
            if (popup && !popup.contains(e.target) && e.target !== input) {
                popup.classList.add('hidden');
            }
        });
    }

    var accordionState = {
        global: true,
        direct: true,
        group: true,
        r5: true
    };

    function esc(s) {
        if (!s) return '';
        if (typeof window !== 'undefined' && window.GM && typeof window.GM.escapeHTML === 'function') {
            return window.GM.escapeHTML(s);
        }
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }
    var t = (typeof window !== 'undefined' && window.GM && window.GM.t) ? window.GM.t : function (k) { return k; };

    function getDb() {
        return (window.GM && window.GM.db) ? window.GM.db : null;
    }

    function getSignal() {
        return window.GM_SIGNAL;
    }

    function getAccount() {
        var username = localStorage.getItem('gm_user') || (window.GM && window.GM.currentUser) || window.currentUser;
        var role = (window.GM && window.GM.roleFromStorage) ? window.GM.roleFromStorage() : localStorage.getItem('gm_role');
        var guild = (window.GM && window.GM.getActiveGuild) ? window.GM.getActiveGuild() : (localStorage.getItem('gm_current_guild') || localStorage.getItem('gm_guild') || 'ALPHA');
        var server = localStorage.getItem('gm_server_restriction') || '1058';

        if (!username) {
            var raw = localStorage.getItem('gm_account');
            if (raw) {
                try {
                    var parsed = JSON.parse(raw);
                    username = parsed.id || parsed.account_id || parsed.username;
                    if (parsed.role) role = parsed.role;
                    if (parsed.guild) guild = parsed.guild;
                } catch (e) {}
            }
        }

        if (!username) return null;
        return {
            id: username,
            account_id: username,
            role: role || 'guild_admin',
            guild: guild,
            server_number: server
        };
    }

    function resolveLeaderServer(pseudo, guild, explicitServer) {
        if (explicitServer && String(explicitServer).trim()) {
            return String(explicitServer).trim().replace(/^#/, '').replace(/^[sS]/, '');
        }
        if (pseudo && activeAccounts && activeAccounts.length > 0) {
            var pLower = String(pseudo).trim().toLowerCase();
            var accMatch = activeAccounts.find(function (a) {
                return a.id && a.id.toLowerCase() === pLower;
            });
            if (accMatch) {
                if (accMatch.server_number) {
                    return String(accMatch.server_number).replace(/^#/, '').replace(/^[sS]/, '');
                }
                if (accMatch.guild && !guild) {
                    guild = accMatch.guild;
                }
            }
        }
        var curAcc = getAccount();
        if (curAcc && pseudo && curAcc.id && curAcc.id.toLowerCase() === String(pseudo).trim().toLowerCase()) {
            if (curAcc.server_number) {
                return String(curAcc.server_number).replace(/^#/, '').replace(/^[sS]/, '');
            }
            if (curAcc.guild && !guild) {
                guild = curAcc.guild;
            }
        }
        if (guild && availableGuilds && availableGuilds.length > 0) {
            var gLower = String(guild).trim().toLowerCase();
            var gMatch = availableGuilds.find(function (g) {
                return g.id && g.id.toLowerCase() === gLower;
            });
            if (gMatch && gMatch.server_number) {
                return String(gMatch.server_number).replace(/^#/, '').replace(/^[sS]/, '');
            }
        }
        if (guild && typeof window !== 'undefined' && window.guildsData && window.guildsData[guild] && window.guildsData[guild].server_number) {
            return String(window.guildsData[guild].server_number).replace(/^#/, '').replace(/^[sS]/, '');
        }
        if (guild && typeof localStorage !== 'undefined') {
            var ls = localStorage.getItem('gm_server_number_' + guild);
            if (ls) return String(ls).replace(/^#/, '').replace(/^[sS]/, '');
        }
        if (typeof localStorage !== 'undefined') {
            var restr = localStorage.getItem('gm_server_restriction');
            if (restr) return String(restr).replace(/^#/, '').replace(/^[sS]/, '');
        }
        return '1058';
    }

    function formatLeaderTag(pseudo, guild, explicitServer) {
        var p = (pseudo || '').trim();
        var g = (guild || '').trim();
        var sNum = resolveLeaderServer(p, g, explicitServer);
        if (g) {
            return '[' + g + '] ' + p + ' #' + sNum;
        }
        return p + ' #' + sNum;
    }

    function formatLeaderHtml(pseudo, guild, explicitServer) {
        var p = (pseudo || '').trim();
        var g = (guild || '').trim();
        var sNum = resolveLeaderServer(p, g, explicitServer);
        if (g) {
            return '<span class="gm-sender-guild">[' + esc(g) + ']</span> ' + esc(p) + ' <span class="gm-sender-server">#' + esc(sNum) + '</span>';
        }
        return esc(p) + ' <span class="gm-sender-server">#' + esc(sNum) + '</span>';
    }

    function formatMessageTimestamp(dateInput) {
        if (!dateInput) return '';
        var d = new Date(dateInput);
        if (isNaN(d.getTime())) return '';
        var dd = d.getDate();
        var mm = d.getMonth() + 1;
        var yyyy = d.getFullYear();
        var hours = d.getHours();
        var mins = d.getMinutes();
        var ddStr = (dd < 10 ? '0' : '') + dd;
        var mmStr = (mm < 10 ? '0' : '') + mm;
        var hStr = (hours < 10 ? '0' : '') + hours;
        var mStr = (mins < 10 ? '0' : '') + mins;
        return ddStr + '/' + mmStr + '/' + yyyy + ' ' + hStr + ':' + mStr;
    }

    function isLeader() {
        if (window.GM && window.GM.isGuildAdmin && window.GM.isGuildAdmin()) return true;
        if (window.GM && window.GM.isSuperAdmin && window.GM.isSuperAdmin()) return true;
        var role = (window.GM && window.GM.roleFromStorage) ? window.GM.roleFromStorage() : localStorage.getItem('gm_role');
        if (role) {
            var r = role.toLowerCase();
            if (r === 'super_admin' || r === 'server_admin' || r === 'guild_admin' || r === 'r5' || r === 'r4' || r === 'admin') {
                return true;
            }
        }
        var acc = getAccount();
        if (!acc) return false;
        var accRole = (acc.role || '').toLowerCase();
        return accRole === 'super_admin' || accRole === 'server_admin' || accRole === 'guild_admin' || accRole === 'r5' || accRole === 'r4' || accRole === 'admin';
    }

    function isR5() {
        if (window.GM && window.GM.isSuperAdmin && window.GM.isSuperAdmin()) return true;
        var role = (window.GM && window.GM.roleFromStorage) ? window.GM.roleFromStorage() : localStorage.getItem('gm_role');
        if (role) {
            var r = role.toLowerCase();
            if (r === 'super_admin' || r === 'server_admin' || r === 'guild_admin' || r === 'r5' || r === 'admin') return true;
        }
        var acc = getAccount();
        if (!acc) return false;
        var accRole = (acc.role || '').toLowerCase();
        return accRole === 'super_admin' || accRole === 'server_admin' || accRole === 'guild_admin' || accRole === 'r5' || accRole === 'admin';
    }

    function isProtectedConversation() {
        return currentConversation && (currentConversation.type === 'direct' || currentConversation.type === 'group');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 1. SIGNAL IDENTITY & PREKEY SYNC
    // ─────────────────────────────────────────────────────────────────────────

    async function publishIdentityBundle(recordToStore) {
        var db = getDb();
        if (!db || !recordToStore) return;
        try {
            var otks = (recordToStore.oneTimePreKeys || []).map(function (otk) {
                return {
                    key_id: otk.keyId,
                    public_key: otk.publicKey
                };
            });

            await db.rpc('gm_publish_e2ee_prekey_bundle', {
                p_identity_key: recordToStore.identityKey.publicKey,
                p_signed_prekey: recordToStore.signedPreKey.keyPair.publicKey,
                p_signed_prekey_sig: recordToStore.signedPreKey.signature,
                p_registration_id: recordToStore.registrationId,
                p_one_time_prekeys: otks,
                p_identity_signing_key: recordToStore.identitySigningKey ? recordToStore.identitySigningKey.publicKey : null
            });
        } catch (err) {
            console.error('Error syncing E2EE prekey bundle to server', err);
        }
    }

    async function initSignalIdentity() {
        var S = getSignal();
        var acc = getAccount();
        var db = getDb();
        if (!S || !acc || !db) return null;

        var accId = acc.id || acc.account_id;
        var stored = await S.loadKeyRecord('identity_keys', accId);

        if (stored && stored.identityKey) {
            // R-03 audit fix migration: accounts created before the Ed25519
            // signing key existed keep their X25519 identity key (and
            // safety number) unchanged, but need a signing key added so
            // verifyPreKeySignature() can do real verification. Existing
            // 1:1 sessions are unaffected — they don't depend on the
            // prekey bundle once established.
            if (!stored.identitySigningKey) {
                var signingKeyPair = S.generateEd25519KeyPair();
                stored.identitySigningKey = {
                    privateKey: S.bytesToHex(signingKeyPair.privateKey),
                    publicKey: S.bytesToHex(signingKeyPair.publicKey)
                };
                await S.saveKeyRecord('identity_keys', accId, stored);
            }
            localIdentity = stored;
            // Always sync prekey bundle to database to ensure freshness
            await publishIdentityBundle(stored);
            return stored;
        }

        var bundle = S.createPreKeyBundle(30);
        var recordToStore = {
            identityKey: {
                privateKey: S.bytesToHex(bundle.identityKey.privateKey),
                publicKey: S.bytesToHex(bundle.identityKey.publicKey)
            },
            identitySigningKey: {
                privateKey: S.bytesToHex(bundle.identitySigningKey.privateKey),
                publicKey: S.bytesToHex(bundle.identitySigningKey.publicKey)
            },
            signedPreKey: {
                keyPair: {
                    privateKey: S.bytesToHex(bundle.signedPreKey.keyPair.privateKey),
                    publicKey: S.bytesToHex(bundle.signedPreKey.keyPair.publicKey)
                },
                signature: S.bytesToHex(bundle.signedPreKey.signature)
            },
            registrationId: bundle.registrationId,
            oneTimePreKeys: bundle.oneTimePreKeys.map(function (otk) {
                return {
                    keyId: otk.keyId,
                    privateKey: S.bytesToHex(otk.keyPair.privateKey),
                    publicKey: S.bytesToHex(otk.keyPair.publicKey)
                };
            })
        };

        await S.saveKeyRecord('identity_keys', accId, recordToStore);
        localIdentity = recordToStore;

        await publishIdentityBundle(recordToStore);
        return localIdentity;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. FETCHING & REALTIME
    // ─────────────────────────────────────────────────────────────────────────

    async function fetchConversations() {
        var db = getDb();
        var acc = getAccount();
        if (!db || !acc) return [];

        var accId = acc.id || acc.account_id;
        try {
            var res = await db
                .from('e2ee_conversation_members')
                .select('conversation_id, group_role, e2ee_conversations (id, type, title, created_by, is_r5_only, server_number, updated_at)')
                .eq('account_id', accId)
                .order('conversation_id', { ascending: false });

            var list = (res.data || []).map(function (row) {
                var c = row.e2ee_conversations;
                if (!c) return null;
                return {
                    id: c.id,
                    type: c.type,
                    title: c.title,
                    createdBy: c.created_by,
                    isR5Only: c.is_r5_only,
                    serverNumber: c.server_number,
                    updatedAt: c.updated_at,
                    myGroupRole: row.group_role
                };
            }).filter(Boolean);

            for (var i = 0; i < list.length; i++) {
                var memRes = await db
                    .from('e2ee_conversation_members')
                    .select('account_id, guild, role, group_role')
                    .eq('conversation_id', list[i].id);
                list[i].members = memRes.data || [];
            }

            conversationsList = list;
            await fetchUnreadCounts();
            return list;
        } catch (err) {
            console.error('Error fetching E2EE conversations', err);
            return [];
        }
    }

    function getLastReadKey() {
        var acc = getAccount();
        var accId = acc ? (acc.id || acc.account_id) : 'anon';
        return 'gm_e2ee_last_read_' + accId;
    }

    function loadLastReadMap() {
        try {
            var raw = localStorage.getItem(getLastReadKey());
            if (raw) {
                lastReadMessageIds = JSON.parse(raw) || {};
            }
        } catch (e) {
            lastReadMessageIds = {};
        }
    }

    function saveLastReadMap() {
        try {
            localStorage.setItem(getLastReadKey(), JSON.stringify(lastReadMessageIds));
        } catch (e) {}
    }

    function markConversationRead(convId, latestId) {
        if (!convId) return;
        unreadCounts[convId] = 0;
        if (latestId) {
            lastReadMessageIds[convId] = Math.max(lastReadMessageIds[convId] || 0, Number(latestId));
        }
        saveLastReadMap();
        updateAllUnreadBadges();
    }

    async function fetchUnreadCounts() {
        var db = getDb();
        var acc = getAccount();
        if (!db || !acc) return;
        var accId = acc.id || acc.account_id;
        loadLastReadMap();

        try {
            var convIds = conversationsList.map(function (c) { return c.id; });
            if (convIds.length === 0) {
                unreadCounts = {};
                updateAllUnreadBadges();
                return;
            }

            var res = await db
                .from('e2ee_messages')
                .select('id, conversation_id, sender_account_id')
                .in('conversation_id', convIds)
                .neq('sender_account_id', accId)
                .order('id', { ascending: true });

            if (res.data) {
                var counts = {};
                res.data.forEach(function (m) {
                    var cId = m.conversation_id;
                    var lastRead = lastReadMessageIds[cId] || 0;
                    if (Number(m.id) > lastRead) {
                        counts[cId] = (counts[cId] || 0) + 1;
                    }
                });
                unreadCounts = counts;
                updateAllUnreadBadges();
            }
        } catch (e) {
            console.error('Error fetching unread counts', e);
        }
    }

    function updateAllUnreadBadges() {
        var totalUnread = 0;
        var directUnread = 0;
        var groupUnread = 0;
        var r5Unread = 0;

        conversationsList.forEach(function (c) {
            var u = unreadCounts[c.id] || 0;
            if (u > 0) {
                totalUnread += u;
                if (c.type === 'direct') {
                    directUnread += u;
                } else if (c.type === 'group') {
                    if (c.isR5Only) r5Unread += u;
                    else groupUnread += u;
                }
            }
        });

        // 1. Top & Desktop Navigation Tab Badge
        var navBadge = document.getElementById('nav-badge-leader-hall');
        if (navBadge) {
            if (totalUnread > 0) {
                navBadge.innerText = totalUnread > 99 ? '99+' : totalUnread;
                navBadge.classList.remove('hidden');
            } else {
                navBadge.classList.add('hidden');
            }
        }

        // 2. Mobile Bottom-Nav More Button Badge
        var bMore = document.getElementById('bottom-nav-more-badge');
        if (bMore) {
            if (totalUnread > 0) {
                bMore.innerText = totalUnread > 99 ? '99+' : totalUnread;
                bMore.classList.remove('hidden');
            } else {
                bMore.classList.add('hidden');
            }
        }

        // 3. Mobile Drawer Leader Hall Item Badge
        var bDrawer = document.getElementById('drawer-badge-leader-hall');
        if (bDrawer) {
            if (totalUnread > 0) {
                bDrawer.innerText = totalUnread > 99 ? '99+' : totalUnread;
                bDrawer.classList.remove('hidden');
            } else {
                bDrawer.classList.add('hidden');
            }
        }

        // 4. Native App Icon Badging (PWA / Mobile Safari / Chrome)
        if (typeof navigator !== 'undefined') {
            if (totalUnread > 0 && 'setAppBadge' in navigator) {
                try { navigator.setAppBadge(totalUnread); } catch (e) {}
            } else if (totalUnread === 0 && 'clearAppBadge' in navigator) {
                try { navigator.clearAppBadge(); } catch (e) {}
            }
        }

        // 5. Accordion Header Badges
        var bDirect = document.getElementById('badge-direct-unread');
        if (bDirect) {
            if (directUnread > 0) {
                bDirect.innerText = directUnread + ' new';
                bDirect.classList.remove('hidden');
            } else {
                bDirect.classList.add('hidden');
            }
        }

        var bGroup = document.getElementById('badge-group-unread');
        if (bGroup) {
            if (groupUnread > 0) {
                bGroup.innerText = groupUnread + ' new';
                bGroup.classList.remove('hidden');
            } else {
                bGroup.classList.add('hidden');
            }
        }

        var bR5 = document.getElementById('badge-r5-unread');
        if (bR5) {
            if (r5Unread > 0) {
                bR5.innerText = r5Unread + ' new';
                bR5.classList.remove('hidden');
            } else {
                bR5.classList.add('hidden');
            }
        }

        // 6. Update individual channel items in sidebar
        document.querySelectorAll('.gm-hall-channel-item').forEach(function (el) {
            var cId = el.getAttribute('data-conv-id');
            if (!cId) return;
            var count = unreadCounts[cId] || 0;
            var bubble = el.querySelector('.gm-channel-unread-bubble');
            if (count > 0) {
                if (!bubble) {
                    bubble = document.createElement('div');
                    bubble.className = 'gm-channel-unread-bubble';
                    el.appendChild(bubble);
                }
                bubble.innerText = count > 99 ? '99+' : count;
            } else if (bubble) {
                bubble.remove();
            }
        });
    }

    function initGlobalUnreadListener() {
        var db = getDb();
        var acc = getAccount();
        if (!db || !acc) return;
        var accId = acc.id || acc.account_id;

        if (globalUnreadChannel) {
            db.removeChannel(globalUnreadChannel);
        }

        // Proactively request Notification permission on user interaction if not decided yet
        if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
            try {
                var reqPerm = function () {
                    Notification.requestPermission();
                    document.removeEventListener('click', reqPerm);
                };
                document.addEventListener('click', reqPerm, { once: true });
            } catch (e) {}
        }

        globalUnreadChannel = db.channel('leader_hall_global_unreads_' + accId)
            .on('postgres_changes', {
                event: 'INSERT',
                schema: 'public',
                table: 'e2ee_messages'
            }, async function (payload) {
                var msg = payload.new;
                if (!msg || msg.sender_account_id === accId) return;

                var activeTab = document.querySelector('.tab-panel.active');
                var isLeaderHallTab = activeTab && activeTab.id === 'tab-leader-hall';
                var isViewingThisConv = isLeaderHallTab && currentConversation && currentConversation.id === msg.conversation_id;

                if (isViewingThisConv) {
                    markConversationRead(msg.conversation_id, msg.id);
                } else {
                    unreadCounts[msg.conversation_id] = (unreadCounts[msg.conversation_id] || 0) + 1;
                    updateAllUnreadBadges();

                    // Resolve conversation details
                    var convObj = conversationsList.find(function (c) { return c.id === msg.conversation_id; });
                    var isDirect = convObj ? (convObj.type === 'direct') : false;
                    var isGroup = convObj ? (convObj.type === 'group') : false;
                    var isR5Summit = convObj ? (isGroup && convObj.isR5Only) : false;
                    var groupTitle = convObj ? convObj.title : (isDirect ? 'Direct 1:1' : 'Discussion');
                    var senderLabel = formatLeaderTag(msg.sender_account_id, msg.sender_guild);

                    // Decrypt message to inspect snippet and detect @player mentions
                    var plainText = '';
                    try {
                        var rawDec = await decryptMessage(msg);
                        var parsed = parseMessagePayload(rawDec);
                        plainText = parsed.text || '';
                    } catch (e) {}

                    var cleanSnippet = plainText.trim();
                    if (cleanSnippet.length > 70) {
                        cleanSnippet = cleanSnippet.slice(0, 67) + '...';
                    }

                    // Check for @mention
                    var isMentioned = Boolean(accId && cleanSnippet && new RegExp('@' + accId + '(?![a-zA-Z0-9_\\-])', 'i').test(cleanSnippet));

                    // Construct notification content
                    var notifTitle = '';
                    var notifBody = '';
                    var toastType = 'info';

                    if (isMentioned) {
                        notifTitle = '🔔 ' + senderLabel + ' mentioned you in ' + groupTitle;
                        notifBody = cleanSnippet || 'Mentioned you in a message';
                        toastType = 'warning';
                        if (typeof navigator !== 'undefined' && navigator.vibrate) {
                            try { navigator.vibrate([150, 70, 150]); } catch (e) {}
                        }
                    } else if (isDirect) {
                        notifTitle = '💬 Direct message from ' + senderLabel;
                        notifBody = cleanSnippet || 'New encrypted direct message';
                        toastType = 'info';
                        if (typeof navigator !== 'undefined' && navigator.vibrate) {
                            try { navigator.vibrate([100, 50, 100]); } catch (e) {}
                        }
                    } else if (isR5Summit) {
                        notifTitle = '👑 R5 Summit • ' + senderLabel;
                        notifBody = cleanSnippet || 'New confidential high-command message';
                        toastType = 'info';
                        if (typeof navigator !== 'undefined' && navigator.vibrate) {
                            try { navigator.vibrate([120, 60, 120]); } catch (e) {}
                        }
                    } else {
                        notifTitle = '👥 ' + groupTitle + ' • ' + senderLabel;
                        notifBody = cleanSnippet || 'New message in discussion';
                        toastType = 'info';
                        if (typeof navigator !== 'undefined' && navigator.vibrate) {
                            try { navigator.vibrate(80); } catch (e) {}
                        }
                    }

                    // 1. In-App Toast
                    if (window.GM && window.GM.showToast) {
                        window.GM.showToast(notifTitle + (cleanSnippet ? ': "' + cleanSnippet + '"' : ''), toastType);
                    }

                    // 2. Native System Notification (mobile PWA / background)
                    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
                        try {
                            var notif = new Notification(notifTitle, {
                                body: notifBody,
                                icon: '/assets/favicon-RURjxqe3.png',
                                badge: '/assets/favicon-RURjxqe3.png',
                                tag: 'leader-hall-' + msg.conversation_id,
                                silent: false
                            });
                            notif.onclick = function () {
                                window.focus();
                                if (typeof window !== 'undefined' && window.GM_SHELL && window.GM_SHELL.gotoItem) {
                                    window.GM_SHELL.gotoItem('leader-hall');
                                }
                                selectConversation(msg.conversation_id);
                            };
                        } catch (e) {
                            // Fallback to service worker notification
                            if (typeof navigator !== 'undefined' && navigator.serviceWorker && navigator.serviceWorker.ready) {
                                navigator.serviceWorker.ready.then(function (reg) {
                                    reg.showNotification(notifTitle, {
                                        body: notifBody,
                                        icon: '/assets/favicon-RURjxqe3.png',
                                        badge: '/assets/favicon-RURjxqe3.png',
                                        tag: 'leader-hall-' + msg.conversation_id,
                                        data: { conversation_id: msg.conversation_id }
                                    });
                                });
                            }
                        }
                    }
                }
            })
            .subscribe();

        fetchUnreadCounts();
    }

    async function fetchTreaties() {
        var db = getDb();
        if (!db) return [];
        try {
            var res = await db
                .from('diplomatic_treaties')
                .select('*')
                .order('created_at', { ascending: false });
            treatiesList = res.data || [];
            return treatiesList;
        } catch (err) {
            console.error('Error fetching diplomatic treaties', err);
            return [];
        }
    }

    async function fetchBlockedAccounts() {
        var db = getDb();
        var acc = getAccount();
        if (!db || !acc) return;
        var accId = acc.id || acc.account_id;

        try {
            var res = await db
                .from('e2ee_blocked_accounts')
                .select('blocked_account_id')
                .eq('account_id', accId);
            blockedAccountIds = new Set((res.data || []).map(function (r) { return r.blocked_account_id; }));
        } catch (e) {
            console.error('Error fetching blocked accounts', e);
        }
    }

    async function fetchEligibleLeaders() {
        var db = getDb();
        if (!db) return [];
        try {
            var res = await db
                .from('accounts')
                .select('id, guild, role, server_number')
                .eq('status', 'active')
                .in('role', ['super_admin', 'server_admin', 'guild_admin', 'R5', 'R4', 'admin'])
                .order('guild', { ascending: true });
            activeAccounts = res.data || [];

            var gRes = await db.from('guilds').select('id, server_number').order('id', { ascending: true });
            availableGuilds = gRes.data || [];

            return activeAccounts;
        } catch (e) {
            return [];
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 3. E2EE SESSIONS & MESSAGING
    // ─────────────────────────────────────────────────────────────────────────

    async function getOrEstablish1to1Session(targetAccountId) {
        var S = getSignal();
        var acc = getAccount();
        var db = getDb();
        var accId = acc.id || acc.account_id;

        var sessionId = accId + ':' + targetAccountId;
        var existing = await S.loadKeyRecord('sessions', sessionId);
        if (existing) {
            existing.identityKeyPair = {
                privateKey: S.hexToBytes(existing.identityKeyPair.privateKey),
                publicKey: S.hexToBytes(existing.identityKeyPair.publicKey)
            };
            existing.dhKeyPair = {
                privateKey: S.hexToBytes(existing.dhKeyPair.privateKey),
                publicKey: S.hexToBytes(existing.dhKeyPair.publicKey)
            };
            existing.remoteDhPublicKey = existing.remoteDhPublicKey ? S.hexToBytes(existing.remoteDhPublicKey) : null;
            existing.rootKey = S.hexToBytes(existing.rootKey);
            existing.sendingChainKey = existing.sendingChainKey ? S.hexToBytes(existing.sendingChainKey) : null;
            existing.receivingChainKey = existing.receivingChainKey ? S.hexToBytes(existing.receivingChainKey) : null;
            return existing;
        }

        try {
            var rpcRes = await db.rpc('gm_get_e2ee_prekey_bundle', { p_target_account_id: targetAccountId });
            if (rpcRes.error || !rpcRes.data || rpcRes.data.length === 0) {
                // Target has not published custom keys yet
                return null;
            }
            var recipientBundle = rpcRes.data[0];

            var myIdentityKeyPair = {
                privateKey: S.hexToBytes(localIdentity.identityKey.privateKey),
                publicKey: S.hexToBytes(localIdentity.identityKey.publicKey)
            };

            var x3dhRes = S.x3dhInitiator(myIdentityKeyPair, recipientBundle);
            var bobSignedPreKey = S.hexToBytes(recipientBundle.signed_prekey);

            var session = S.initializeSessionAlice(x3dhRes.masterKey, bobSignedPreKey, myIdentityKeyPair);
            await saveSession(sessionId, session);
            return session;
        } catch (e) {
            console.warn('Could not establish Double Ratchet session, falling back to secure group key', e);
            return null;
        }
    }

    async function saveSession(sessionId, session) {
        var S = getSignal();
        var serialized = {
            identityKeyPair: {
                privateKey: S.bytesToHex(session.identityKeyPair.privateKey),
                publicKey: S.bytesToHex(session.identityKeyPair.publicKey)
            },
            dhKeyPair: {
                privateKey: S.bytesToHex(session.dhKeyPair.privateKey),
                publicKey: S.bytesToHex(session.dhKeyPair.publicKey)
            },
            remoteDhPublicKey: session.remoteDhPublicKey ? S.bytesToHex(session.remoteDhPublicKey) : null,
            rootKey: S.bytesToHex(session.rootKey),
            sendingChainKey: session.sendingChainKey ? S.bytesToHex(session.sendingChainKey) : null,
            receivingChainKey: session.receivingChainKey ? S.bytesToHex(session.receivingChainKey) : null,
            sendCount: session.sendCount,
            receiveCount: session.receiveCount,
            previousSendCount: session.previousSendCount,
            skippedMessageKeys: {}
        };
        await S.saveKeyRecord('sessions', sessionId, serialized);
    }

    async function getOrEstablishGroupSenderKey(groupId) {
        var S = getSignal();
        var acc = getAccount();
        var accId = acc.id || acc.account_id;
        var keyId = groupId + ':' + accId;

        var existing = await S.loadKeyRecord('group_sender_keys', keyId);
        if (existing) {
            return {
                groupId: existing.groupId,
                senderAccountId: existing.senderAccountId,
                chainKey: S.hexToBytes(existing.chainKey),
                signingKeyPair: {
                    privateKey: S.hexToBytes(existing.signingKeyPair.privateKey),
                    publicKey: S.hexToBytes(existing.signingKeyPair.publicKey)
                },
                iteration: existing.iteration
            };
        }

        var newKey = S.createGroupSenderKey(groupId, accId);
        var toStore = {
            groupId: newKey.groupId,
            senderAccountId: newKey.senderAccountId,
            chainKey: S.bytesToHex(newKey.chainKey),
            signingKeyPair: {
                privateKey: S.bytesToHex(newKey.signingKeyPair.privateKey),
                publicKey: S.bytesToHex(newKey.signingKeyPair.publicKey)
            },
            iteration: newKey.iteration
        };
        await S.saveKeyRecord('group_sender_keys', keyId, toStore);
        return newKey;
    }

    function getCachedDecrypted(msgId) {
        if (!msgId) return null;
        if (decryptedCache[msgId]) return decryptedCache[msgId];
        try {
            var raw = localStorage.getItem('gm_e2ee_cache_' + msgId);
            if (raw) {
                decryptedCache[msgId] = raw;
                return raw;
            }
        } catch (e) {}
        return null;
    }

    function setCachedDecrypted(msgId, text) {
        if (!msgId || !text) return;
        decryptedCache[msgId] = text;
        try {
            localStorage.setItem('gm_e2ee_cache_' + msgId, text);
        } catch (e) {}
    }

    async function sendMessage(text) {
        if (!currentConversation || !text || !text.trim()) return;
        var S = getSignal();
        var db = getDb();
        var acc = getAccount();
        if (!S || !db || !acc) return;

        var accId = acc.id || acc.account_id;
        var guild = acc.guild || 'FGF';
        var role = acc.role || 'R4';
        var cleanText = text.trim();

        // Encode message payload with optional quoted reply
        var payloadObj = {
            text: cleanText,
            replyTo: replyingTo ? {
                id: replyingTo.id,
                sender: replyingTo.sender,
                guild: replyingTo.guild,
                snippet: replyingTo.snippet
            } : null
        };
        var payloadString = JSON.stringify(payloadObj);

        try {
            var encrypted = null;
            var usedDoubleRatchet = false;

            if (currentConversation.type === 'direct') {
                var otherMember = (currentConversation.members || []).find(function (m) { return m.account_id !== accId; });
                var targetId = otherMember ? otherMember.account_id : accId;
                var session = await getOrEstablish1to1Session(targetId);
                if (session) {
                    try {
                        encrypted = await S.doubleRatchetEncrypt(session, payloadString);
                        await saveSession(accId + ':' + targetId, session);
                        usedDoubleRatchet = true;
                    } catch (e) {
                        usedDoubleRatchet = false;
                    }
                }
            }

            if (!usedDoubleRatchet) {
                var senderKey = await getOrEstablishGroupSenderKey(currentConversation.id);
                encrypted = await S.groupSenderKeyEncrypt(senderKey, payloadString);
                var toStore = {
                    groupId: senderKey.groupId,
                    senderAccountId: senderKey.senderAccountId,
                    chainKey: S.bytesToHex(senderKey.chainKey),
                    signingKeyPair: {
                        privateKey: S.bytesToHex(senderKey.signingKeyPair.privateKey),
                        publicKey: S.bytesToHex(senderKey.signingKeyPair.publicKey)
                    },
                    iteration: senderKey.iteration
                };
                await S.saveKeyRecord('group_sender_keys', currentConversation.id + ':' + accId, toStore);
            }

            var insertRes = await db.from('e2ee_messages').insert({
                conversation_id: currentConversation.id,
                sender_account_id: accId,
                sender_guild: guild,
                sender_role: role,
                ciphertext: encrypted.ciphertext,
                header_data: encrypted.header,
                iv: encrypted.iv
            }).select();

            if (insertRes.data && insertRes.data[0]) {
                setCachedDecrypted(insertRes.data[0].id, payloadString);
            }

            clearReplyingTo();
            renderMessages();
        } catch (err) {
            console.error('Failed to encrypt & send E2EE message', err);
            alert('Failed to send encrypted message: ' + (err.message || err));
        }
    }

    async function decryptMessage(msg) {
        if (!msg || !msg.id) return '';
        var cached = getCachedDecrypted(msg.id);
        if (cached) return cached;

        var S = getSignal();
        var acc = getAccount();
        var accId = acc ? (acc.id || acc.account_id) : '';

        if (blockedAccountIds.has(msg.sender_account_id)) {
            return '[🚫 Message hidden from blocked leader]';
        }

        try {
            var plaintext = '';
            var sKey = await getOrEstablishGroupSenderKey(currentConversation.id);
            try {
                plaintext = await S.groupSenderKeyDecrypt(sKey, msg.header_data, msg.iv, msg.ciphertext);
            } catch (errGroup) {
                if (currentConversation.type === 'direct') {
                    var otherMemberId = msg.sender_account_id === accId ?
                        ((currentConversation.members || []).find(function (m) { return m.account_id !== accId; }) || {}).account_id :
                        msg.sender_account_id;

                    var session = await getOrEstablish1to1Session(otherMemberId);
                    if (session && msg.header_data && (msg.header_data.dhPub || msg.header_data.dhPublicKey)) {
                        plaintext = await S.doubleRatchetDecrypt(session, msg.header_data, msg.iv, msg.ciphertext);
                    } else {
                        throw errGroup;
                    }
                } else {
                    throw errGroup;
                }
            }

            if (plaintext) {
                setCachedDecrypted(msg.id, plaintext);
                return plaintext;
            }
            return '[🔒 Encrypted Message]';
        } catch (err) {
            return '[🔒 Encrypted Message]';
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 4. DIPLOMATIC TREATIES & SIGNING ENGINE
    // ─────────────────────────────────────────────────────────────────────────

    function renderTreatiesRegistry() {
        var container = document.getElementById('leader-hall-messages');
        if (!container) return;

        var acc = getAccount();
        var accId = acc ? (acc.id || acc.account_id) : '';
        var callerGuild = acc ? acc.guild : 'ALPHA';

        var filtered = treatiesList.filter(function (t) {
            if (treatyFilter === 'ratified') return t.status === 'ratified';
            if (treatyFilter === 'pending') return t.status === 'pending';
            if (treatyFilter === 'mine') return t.guild_a === callerGuild || t.guild_b === callerGuild;
            return true;
        });

        var cardsHtml = '';
        if (filtered.length === 0) {
            cardsHtml =
                '<div class="gm-empty" style="padding:3rem 1rem; border:1px dashed var(--border-soft); border-radius:var(--radius-md);">' +
                    '<i class="ph ph-scroll gm-icon" style="color:var(--primary); font-size:2.2rem;"></i>' +
                    '<div class="gm-empty-title" style="margin-top:0.5rem;">No treaties found</div>' +
                    '<p style="color:var(--text-muted); font-size:0.85rem; max-width:380px; margin:0.35rem auto 1rem;">Establish non-aggression pacts (N.A.P.), warfare coalitions, or mutual defense treaties with other guilds.</p>' +
                    '<button type="button" class="gm-btn gm-btn-primary gm-btn-sm" id="btn-empty-propose-treaty"><i class="ph ph-pen-nib"></i> Propose a Treaty</button>' +
                '</div>';
        } else {
            cardsHtml = filtered.map(function (tr) {
                var isRatified = tr.status === 'ratified';
                var isRevoked = tr.status === 'revoked';
                var isPending = tr.status === 'pending';

                var statusBadge = '';
                if (isRatified) {
                    statusBadge = '<span class="gm-chip-treaty ratified"><i class="ph ph-seal-check"></i> RATIFIED & PUBLIC</span>';
                } else if (isPending) {
                    statusBadge = '<span class="gm-chip-treaty pending"><i class="ph ph-hourglass-high"></i> PENDING SIGNATURES</span>';
                } else {
                    statusBadge = '<span class="gm-chip-treaty revoked"><i class="ph ph-x-circle"></i> REVOKED</span>';
                }

                var typeLabel = {
                    nap: '🛡️ Non-Aggression Pact (N.A.P.)',
                    mutual_defense: '⚔️ Mutual Defense Alliance',
                    svs_coalition: '🚀 SvS Warfare Coalition',
                    ceasefire: '🕊️ Ceasefire & Neutrality',
                    custom: '📜 Custom Treaty'
                }[tr.treaty_type] || '📜 Diplomatic Treaty';

                // Signature status for Guild A
                var aSigned = tr.guild_a_signed_by ?
                    '<div class="gm-sign-status signed"><i class="ph ph-check-circle"></i> Signed by <strong>' + esc(formatLeaderTag(tr.guild_a_signed_by, tr.guild_a, tr.guild_a_server)) + '</strong></div>' :
                    '<div class="gm-sign-status pending"><i class="ph ph-clock"></i> Awaiting ' + esc(tr.guild_a) + ' signature</div>';

                // Signature status for Guild B
                var bSigned = tr.guild_b_signed_by ?
                    '<div class="gm-sign-status signed"><i class="ph ph-check-circle"></i> Signed by <strong>' + esc(formatLeaderTag(tr.guild_b_signed_by, tr.guild_b, tr.guild_b_server)) + '</strong></div>' :
                    '<div class="gm-sign-status pending"><i class="ph ph-clock"></i> Awaiting ' + esc(tr.guild_b) + ' signature</div>';

                // Can caller sign?
                var canCallerSign = false;
                if (isPending) {
                    if ((callerGuild === tr.guild_a && !tr.guild_a_signed_by) || (callerGuild === tr.guild_b && !tr.guild_b_signed_by)) {
                        canCallerSign = true;
                    }
                }

                var isPartyLeader = (callerGuild === tr.guild_a || callerGuild === tr.guild_b || (window.GM && window.GM.isSuperAdmin && window.GM.isSuperAdmin()));

                return '<div class="gm-treaty-card ' + tr.status + '">' +
                    '<div class="gm-treaty-card-header">' +
                        '<div>' +
                            '<div class="gm-treaty-type-row">' +
                                '<span class="gm-treaty-type-tag">' + esc(typeLabel) + '</span>' +
                                statusBadge +
                            '</div>' +
                            '<h3 class="gm-treaty-card-title">' + esc(tr.title) + '</h3>' +
                        '</div>' +
                        '<div class="gm-treaty-card-meta">' +
                            '<span>Created ' + new Date(tr.created_at).toLocaleDateString() + '</span>' +
                            (tr.expires_at ? '<span style="color:#f59e0b;">Expires ' + new Date(tr.expires_at).toLocaleDateString() + '</span>' : '<span style="color:#34d399;">Permanent</span>') +
                        '</div>' +
                    '</div>' +
                    '<div class="gm-treaty-card-body">' +
                        '<div class="gm-treaty-parties">' +
                            '<div class="gm-party-box">' +
                                '<div class="gm-party-name">👑 Guild A: [' + esc(tr.guild_a) + '] #' + esc(tr.guild_a_server) + '</div>' +
                                aSigned +
                            '</div>' +
                            '<div class="gm-party-divider"><i class="ph ph-handshake"></i></div>' +
                            '<div class="gm-party-box">' +
                                '<div class="gm-party-name">🛡️ Guild B: [' + esc(tr.guild_b) + '] #' + esc(tr.guild_b_server) + '</div>' +
                                bSigned +
                            '</div>' +
                        '</div>' +
                        '<div class="gm-treaty-terms-box">' +
                            '<div class="gm-treaty-terms-title"><i class="ph ph-article"></i> Official Treaty Clauses & Terms</div>' +
                            '<div class="gm-treaty-terms-content">' + esc(tr.terms).replace(/\n/g, '<br>') + '</div>' +
                        '</div>' +
                    '</div>' +
                    '<div class="gm-treaty-card-footer">' +
                        '<div class="gm-treaty-seal">' +
                            '<i class="ph ph-seal"></i> ' + (isRatified ? 'Officially Ratified & Bound in FGF Galaxy' : 'Awaiting Full Bilateral Ratification') +
                        '</div>' +
                        '<div style="display:flex; gap:0.5rem;">' +
                            (canCallerSign ? '<button type="button" class="gm-btn gm-btn-primary gm-btn-sm btn-sign-treaty" data-treaty-id="' + esc(tr.id) + '"><i class="ph ph-pen-nib"></i> Sign Treaty for [' + esc(callerGuild) + ']</button>' : '') +
                            (isPartyLeader && !isRevoked ? '<button type="button" class="gm-btn gm-btn-outline gm-btn-sm btn-revoke-treaty" style="color:var(--danger);" data-treaty-id="' + esc(tr.id) + '"><i class="ph ph-x"></i> Revoke</button>' : '') +
                        '</div>' +
                    '</div>' +
                '</div>';
            }).join('');
        }

        container.innerHTML =
            '<div class="gm-diplomacy-container">' +
                '<div class="gm-diplomacy-header-bar">' +
                    '<div>' +
                        '<div class="gm-diplomacy-title"><i class="ph ph-scroll" style="color:var(--primary);"></i> Inter-Guild Diplomatic Treaties</div>' +
                        '<div class="gm-diplomacy-subtitle">Official bilateral agreements, non-aggression pacts (N.A.P.), and mutual defense pacts signed by guild leaders.</div>' +
                    '</div>' +
                    '<button type="button" class="gm-btn gm-btn-primary gm-btn-sm" id="btn-open-propose-treaty">' +
                        '<i class="ph ph-plus-circle"></i> Propose Treaty' +
                    '</button>' +
                '</div>' +
                '<div class="gm-diplomacy-filters">' +
                    '<button type="button" class="gm-hall-filter-pill ' + (treatyFilter === 'all' ? 'active' : '') + '" data-tfilter="all">All Treaties (' + treatiesList.length + ')</button>' +
                    '<button type="button" class="gm-hall-filter-pill ' + (treatyFilter === 'ratified' ? 'active' : '') + '" data-tfilter="ratified">🟢 Ratified & Public</button>' +
                    '<button type="button" class="gm-hall-filter-pill ' + (treatyFilter === 'pending' ? 'active' : '') + '" data-tfilter="pending">🟡 Awaiting Signatures</button>' +
                    '<button type="button" class="gm-hall-filter-pill ' + (treatyFilter === 'mine' ? 'active' : '') + '" data-tfilter="mine">My Guild [' + esc(callerGuild) + ']</button>' +
                '</div>' +
                '<div class="gm-treaty-feed">' +
                    cardsHtml +
                '</div>' +
            '</div>';

        // Bind treaty buttons
        var btnPropose = document.getElementById('btn-open-propose-treaty');
        if (btnPropose) btnPropose.onclick = showCreateTreatyModal;
        var btnEmptyPropose = document.getElementById('btn-empty-propose-treaty');
        if (btnEmptyPropose) btnEmptyPropose.onclick = showCreateTreatyModal;

        container.querySelectorAll('.btn-sign-treaty').forEach(function (btn) {
            btn.onclick = function () {
                var tid = btn.getAttribute('data-treaty-id');
                if (tid) handleSignTreaty(tid);
            };
        });

        container.querySelectorAll('.btn-revoke-treaty').forEach(function (btn) {
            btn.onclick = function () {
                var tid = btn.getAttribute('data-treaty-id');
                if (tid) handleRevokeTreaty(tid);
            };
        });

        container.querySelectorAll('.gm-diplomacy-filters .gm-hall-filter-pill').forEach(function (pill) {
            pill.onclick = function () {
                treatyFilter = pill.getAttribute('data-tfilter') || 'all';
                renderTreatiesRegistry();
            };
        });
    }

    function showCreateTreatyModal() {
        var modal = document.getElementById('modal-treaty-create');
        if (!modal) return;

        var acc = getAccount();
        var callerGuild = acc ? acc.guild : 'ALPHA';
        var callerServer = acc ? (acc.server_number || '1058') : '1058';

        var guildOptions = availableGuilds.filter(function (g) {
            return g.id !== callerGuild;
        }).map(function (g) {
            return '<option value="' + esc(g.id) + '" data-server="' + esc(g.server_number || callerServer) + '">[' + esc(g.id) + '] ' + esc(g.id) + ' #' + esc(g.server_number || callerServer) + '</option>';
        }).join('');

        var body = document.getElementById('modal-treaty-create-body');
        if (body) {
            body.innerHTML =
                '<div class="gm-login-field">' +
                    '<label style="display:block; margin-bottom:0.25rem; font-size:0.85rem; color:var(--text-muted);">Signatory Parties</label>' +
                    '<div style="display:grid; grid-template-columns:1fr 1fr; gap:0.75rem;">' +
                        '<div style="background:rgba(255,255,255,0.04); padding:0.65rem; border-radius:var(--radius-sm); border:1px solid var(--border-soft);">' +
                            '<div style="font-size:0.75rem; color:var(--text-muted);">Proposing Party (Party A)</div>' +
                            '<div style="font-weight:700; color:var(--text-main); font-size:0.95rem; margin-top:2px;">[' + esc(callerGuild) + '] #' + esc(callerServer) + '</div>' +
                        '</div>' +
                        '<div>' +
                            '<div style="font-size:0.75rem; color:var(--text-muted); margin-bottom:2px;">Target Guild (Party B)</div>' +
                            '<select id="input-treaty-guild-b" class="gm-input" style="width:100%;">' +
                                (guildOptions || '<option value="OMEGA">[OMEGA] OMEGA #1058</option>') +
                            '</select>' +
                        '</div>' +
                    '</div>' +
                '</div>' +
                '<div style="display:grid; grid-template-columns:1.5fr 1fr; gap:0.75rem;">' +
                    '<div class="gm-login-field">' +
                        '<label style="display:block; margin-bottom:0.25rem; font-size:0.85rem; color:var(--text-muted);">Treaty Category</label>' +
                        '<select id="input-treaty-type" class="gm-input" style="width:100%;">' +
                            '<option value="nap">🛡️ Non-Aggression Pact (N.A.P.)</option>' +
                            '<option value="mutual_defense">⚔️ Mutual Defense Alliance</option>' +
                            '<option value="svs_coalition">🚀 SvS Warfare Coalition</option>' +
                            '<option value="ceasefire">🕊️ Ceasefire & Neutrality</option>' +
                            '<option value="custom">📜 Custom Treaty</option>' +
                        '</select>' +
                    '</div>' +
                    '<div class="gm-login-field">' +
                        '<label style="display:block; margin-bottom:0.25rem; font-size:0.85rem; color:var(--text-muted);">Validity Duration</label>' +
                        '<select id="input-treaty-expires" class="gm-input" style="width:100%;">' +
                            '<option value="30">30 Days</option>' +
                            '<option value="7">7 Days (SvS Cycle)</option>' +
                            '<option value="14">14 Days</option>' +
                            '<option value="90">90 Days</option>' +
                            '<option value="0">Permanent (Until Revoked)</option>' +
                        '</select>' +
                    '</div>' +
                '</div>' +
                '<div class="gm-login-field">' +
                    '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.25rem;">' +
                        '<label style="font-size:0.85rem; color:var(--text-muted);">Treaty Clauses & Articles</label>' +
                        '<button type="button" class="gm-btn gm-btn-ghost gm-btn-xs" id="btn-fill-nap-template" style="font-size:0.75rem; color:var(--primary);"><i class="ph ph-magic-wand"></i> Insert Standard N.A.P. Clauses</button>' +
                    '</div>' +
                    '<textarea id="input-treaty-terms" class="gm-input" rows="6" style="width:100%; font-family:inherit; font-size:0.85rem; line-height:1.45; resize:vertical;" placeholder="Specify the terms, non-aggression clauses, resource tile rules, SvS assistance commitments..."></textarea>' +
                '</div>' +
                '<div style="background:rgba(56,189,248,0.08); border:1px solid rgba(56,189,248,0.25); border-radius:var(--radius-sm); padding:0.65rem; font-size:0.78rem; color:var(--text-muted); display:flex; gap:0.5rem; align-items:center;">' +
                    '<i class="ph ph-info" style="color:var(--primary); font-size:1.2rem; flex-shrink:0;"></i>' +
                    '<span>By proposing this treaty, your signature as <strong>' + esc(acc ? acc.id : 'Leader') + '</strong> for <strong>[' + esc(callerGuild) + ']</strong> will be appended automatically. The treaty will be publicly ratified as soon as the leader of Party B signs it.</span>' +
                '</div>';

            var templateBtn = document.getElementById('btn-fill-nap-template');
            if (templateBtn) {
                templateBtn.onclick = function () {
                    var termsEl = document.getElementById('input-treaty-terms');
                    if (termsEl) {
                        termsEl.value =
                            "ARTICLE 1: NON-AGGRESSION OBLIGATION\n" +
                            "Both signatory guilds mutually agree to abstain from attacking each other's members, bases, outposts, and convoys.\n\n" +
                            "ARTICLE 2: RESOURCE & MINING TILES\n" +
                            "Neither guild shall engage or displace gathered forces from resource nodes or asteroid fields.\n\n" +
                            "ARTICLE 3: SVS WARFARE COOPERATION\n" +
                            "During Server vs Server (SvS) battles, both guilds shall coordinate tactical movements and avoid friendly fire.\n\n" +
                            "ARTICLE 4: DISPUTE RESOLUTION\n" +
                            "Any accidental engagements shall be resolved diplomatically through the Guild Leader Hall before taking retaliatory actions.";
                    }
                };
            }
        }

        modal.classList.remove('hidden');
    }

    async function handleCreateTreatySubmit() {
        var db = getDb();
        if (!db) return;

        var selGuildB = document.getElementById('input-treaty-guild-b');
        var selType = document.getElementById('input-treaty-type');
        var selExpires = document.getElementById('input-treaty-expires');
        var termsInput = document.getElementById('input-treaty-terms');

        if (!selGuildB || !termsInput) return;

        var guildB = selGuildB.value;
        var selectedOpt = selGuildB.options[selGuildB.selectedIndex];
        var guildBServer = (selectedOpt && selectedOpt.getAttribute('data-server')) || '1058';
        var treatyType = selType ? selType.value : 'nap';
        var expiresDays = selExpires ? parseInt(selExpires.value, 10) : 30;
        var terms = termsInput.value.trim();

        if (!guildB) {
            alert('Please select a target guild.');
            return;
        }

        if (!terms) {
            alert('Please specify the treaty terms and clauses.');
            return;
        }

        try {
            var res = await db.rpc('gm_create_diplomatic_treaty', {
                p_guild_b: guildB,
                p_guild_b_server: guildBServer,
                p_treaty_type: treatyType,
                p_terms: terms,
                p_expires_days: expiresDays
            });

            if (res.error) throw res.error;

            document.getElementById('modal-treaty-create').classList.add('hidden');
            await fetchTreaties();
            renderTreatiesRegistry();
        } catch (err) {
            console.error('Error creating treaty', err);
            alert('Failed to propose treaty: ' + (err.message || err));
        }
    }

    async function handleSignTreaty(treatyId) {
        var db = getDb();
        if (!db) return;

        if (!confirm('Do you confirm the official signature and bilateral ratification of this treaty on behalf of your guild?')) return;

        try {
            var res = await db.rpc('gm_sign_diplomatic_treaty', { p_treaty_id: treatyId });
            if (res.error) throw res.error;

            await fetchTreaties();
            renderTreatiesRegistry();
        } catch (err) {
            console.error('Error signing treaty', err);
            alert('Failed to sign treaty: ' + (err.message || err));
        }
    }

    async function handleRevokeTreaty(treatyId) {
        var db = getDb();
        if (!db) return;

        if (!confirm('Are you sure you want to revoke this treaty? This action will mark the agreement as void.')) return;

        try {
            var res = await db.rpc('gm_revoke_diplomatic_treaty', { p_treaty_id: treatyId });
            if (res.error) throw res.error;

            await fetchTreaties();
            renderTreatiesRegistry();
        } catch (err) {
            console.error('Error revoking treaty', err);
            alert('Failed to revoke treaty: ' + (err.message || err));
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 5. UI RENDERING & ACCORDION SYSTEM
    // ─────────────────────────────────────────────────────────────────────────

    function ensureLayoutRendered() {
        var container = document.getElementById('tab-leader-hall');
        if (!container) return;
        if (document.getElementById('leader-hall-sidebar-accordions')) return;

        container.innerHTML =
            '<div class="gm-page" style="max-width:1440px; padding:0 0.5rem;">' +
                '<header class="gm-page-header" style="margin-bottom:0.75rem;">' +
                    '<div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:0.5rem;">' +
                        '<div>' +
                            '<div style="display:flex; align-items:center; gap:0.5rem;">' +
                                '<h1 class="gm-page-title" data-i18n="leader_hall_title">' + esc(t('leader_hall_title') || 'Guild Leader Hall') + '</h1>' +
                                '<span class="gm-chip" style="background:rgba(52,211,153,0.12); color:#34d399; border:1px solid rgba(52,211,153,0.3); font-size:0.75rem; font-weight:700; padding:2px 8px; border-radius:9999px;">' +
                                    '<i class="ph ph-shield-check"></i> Signal Protocol E2EE' +
                                '</span>' +
                            '</div>' +
                            '<p class="gm-page-subtitle" data-i18n="leader_hall_subtitle">' + esc(t('leader_hall_subtitle') || 'End-to-End Encrypted diplomacy and tactical coordination for Guild Masters (R5) and Officers (R4)') + '</p>' +
                        '</div>' +
                    '</div>' +
                '</header>' +
                '<div class="gm-leader-hall-layout">' +
                    '<aside class="gm-leader-hall-sidebar">' +
                        '<div class="gm-hall-sidebar-scroll" id="leader-hall-sidebar-accordions">' +
                            '<!-- Space 1: Global Leaders Lounge -->' +
                            '<div class="gm-hall-accordion" id="acc-space-global">' +
                                '<div class="gm-hall-acc-header" data-space="global">' +
                                    '<div class="gm-hall-acc-title">' +
                                        '<i class="ph ph-caret-down gm-acc-caret"></i>' +
                                        '<i class="ph ph-planet" style="color:var(--primary, #38bdf8);"></i>' +
                                        '<span>Global Leaders Lounge</span>' +
                                    '</div>' +
                                    '<span class="gm-hall-acc-badge">' + GLOBAL_CHANNELS.length + '</span>' +
                                '</div>' +
                                '<div class="gm-hall-acc-body" id="acc-body-global"></div>' +
                            '</div>' +
                            '<!-- Space 2: 1:1 Discussions -->' +
                            '<div class="gm-hall-accordion" id="acc-space-direct">' +
                                '<div class="gm-hall-acc-header" data-space="direct">' +
                                    '<div class="gm-hall-acc-title">' +
                                        '<i class="ph ph-caret-down gm-acc-caret"></i>' +
                                        '<i class="ph ph-user" style="color:#a855f7;"></i>' +
                                        '<span>1:1 Discussions</span>' +
                                    '</div>' +
                                    '<div style="display:flex; align-items:center; gap:0.35rem;">' +
                                        '<span class="gm-hall-acc-badge" id="badge-direct-count">0</span>' +
                                        '<button type="button" class="gm-acc-add-btn" id="btn-add-direct" title="Start 1:1 Chat"><i class="ph ph-plus"></i></button>' +
                                    '</div>' +
                                '</div>' +
                                '<div class="gm-hall-acc-body" id="acc-body-direct"></div>' +
                            '</div>' +
                            '<!-- Space 3: Group Discussions -->' +
                            '<div class="gm-hall-accordion" id="acc-space-group">' +
                                '<div class="gm-hall-acc-header" data-space="group">' +
                                    '<div class="gm-hall-acc-title">' +
                                        '<i class="ph ph-caret-down gm-acc-caret"></i>' +
                                        '<i class="ph ph-users-three" style="color:#34d399;"></i>' +
                                        '<span>Group Discussions</span>' +
                                    '</div>' +
                                    '<div style="display:flex; align-items:center; gap:0.35rem;">' +
                                        '<span class="gm-hall-acc-badge" id="badge-group-count">0</span>' +
                                        '<button type="button" class="gm-acc-add-btn" id="btn-add-group" title="Create Group"><i class="ph ph-plus"></i></button>' +
                                    '</div>' +
                                '</div>' +
                                '<div class="gm-hall-acc-body" id="acc-body-group"></div>' +
                            '</div>' +
                            '<!-- Space 4: R5 Summit -->' +
                            '<div class="gm-hall-accordion" id="acc-space-r5">' +
                                '<div class="gm-hall-acc-header" data-space="r5">' +
                                    '<div class="gm-hall-acc-title">' +
                                        '<i class="ph ph-caret-down gm-acc-caret"></i>' +
                                        '<i class="ph ph-crown" style="color:#facc15;"></i>' +
                                        '<span>R5 Summit</span>' +
                                    '</div>' +
                                    '<div style="display:flex; align-items:center; gap:0.35rem;">' +
                                        '<span class="gm-hall-acc-badge" id="badge-r5-count">0</span>' +
                                        '<button type="button" class="gm-acc-add-btn" id="btn-add-r5" title="New R5 Summit"><i class="ph ph-plus"></i></button>' +
                                    '</div>' +
                                '</div>' +
                                '<div class="gm-hall-acc-body" id="acc-body-r5"></div>' +
                            '</div>' +
                        '</div>' +
                    '</aside>' +
                    '<section class="gm-leader-hall-main">' +
                        '<div class="gm-privacy-shield-overlay" id="leader-hall-privacy-shield">' +
                            '<i class="ph ph-shield-warning gm-privacy-shield-icon"></i>' +
                            '<h3 class="gm-privacy-shield-title">Confidential Session Protected</h3>' +
                            '<p class="gm-privacy-shield-desc">Screen capture and background window viewing are restricted for high-command diplomatic communications.</p>' +
                        '</div>' +
                        '<div class="gm-chat-header" id="leader-hall-chat-header">' +
                            '<div class="gm-chat-header-left">' +
                                '<h2 class="gm-chat-title">Select a channel or discussion</h2>' +
                                '<div class="gm-chat-e2ee-tag">' +
                                    '<i class="ph ph-lock-key"></i>' +
                                    '<span>End-to-End Encrypted</span>' +
                                '</div>' +
                            '</div>' +
                        '</div>' +
                        '<div class="gm-chat-messages-viewport" id="leader-hall-messages">' +
                            '<div class="gm-empty" style="padding:4rem 1rem;">' +
                                '<i class="ph ph-chats-circle gm-icon"></i>' +
                                '<div class="gm-empty-title">Select or start a discussion</div>' +
                            '</div>' +
                        '</div>' +
                        '<div class="gm-chat-input-bar" id="leader-hall-input-bar">' +
                            '<input type="text" id="leader-hall-msg-input" class="gm-chat-input" placeholder="Type an encrypted message..." autocomplete="off">' +
                            '<button type="button" class="gm-btn gm-btn-primary gm-btn-sm" id="leader-hall-send-btn">' +
                                '<i class="ph ph-paper-plane-right"></i>' +
                                '<span>Send</span>' +
                            '</button>' +
                        '</div>' +
                    '</section>' +
                '</div>' +
            '</div>';
    }

    function renderAccordions() {
        var acc = getAccount();
        var accId = acc ? (acc.id || acc.account_id) : '';

        // 1. Render Global Channels
        var globalContainer = document.getElementById('acc-body-global');
        if (globalContainer) {
            globalContainer.innerHTML = GLOBAL_CHANNELS.map(function (c) {
                var isSelected = currentConversation && currentConversation.id === c.id;
                return '<div class="gm-hall-channel-item ' + (isSelected ? 'active' : '') + '" data-conv-id="' + esc(c.id) + '">' +
                    '<div class="gm-channel-icon"><i class="' + esc(c.icon) + '"></i></div>' +
                    '<div class="gm-channel-info">' +
                        '<div class="gm-channel-title">' + esc(c.title) + '</div>' +
                        '<div class="gm-channel-sub">' + esc(c.subtitle) + '</div>' +
                    '</div>' +
                '</div>';
            }).join('');
        }

        // 2. Separate user conversations
        var directList = conversationsList.filter(function (c) { return c.type === 'direct'; });
        var groupList = conversationsList.filter(function (c) { return c.type === 'group' && !c.isR5Only; });
        var r5List = conversationsList.filter(function (c) { return c.type === 'group' && c.isR5Only; });

        var badgeDirect = document.getElementById('badge-direct-count');
        var badgeGroup = document.getElementById('badge-group-count');
        var badgeR5 = document.getElementById('badge-r5-count');
        if (badgeDirect) badgeDirect.innerText = directList.length;
        if (badgeGroup) badgeGroup.innerText = groupList.length;
        if (badgeR5) badgeR5.innerText = r5List.length;

        // Render 1:1 Discussions
        var directContainer = document.getElementById('acc-body-direct');
        if (directContainer) {
            if (directList.length === 0) {
                directContainer.innerHTML = '<div class="gm-empty-acc-slot">' +
                    '<span>No 1:1 chats yet</span>' +
                    '<button type="button" class="gm-btn gm-btn-outline gm-btn-xs btn-quick-new-direct"><i class="ph ph-plus"></i> New Chat</button>' +
                '</div>';
            } else {
                directContainer.innerHTML = directList.map(function (c) {
                    var isSelected = currentConversation && currentConversation.id === c.id;
                    var other = (c.members || []).find(function (m) { return m.account_id !== accId; });
                    var title = other ? formatLeaderTag(other.account_id, other.guild, other.server_number) : 'Direct Chat';
                    var isBlocked = other && blockedAccountIds.has(other.account_id);
                    var unread = unreadCounts[c.id] || 0;
                    var unreadHtml = unread > 0 ? '<div class="gm-channel-unread-bubble">' + (unread > 99 ? '99+' : unread) + '</div>' : '';

                    return '<div class="gm-hall-channel-item ' + (isSelected ? 'active' : '') + '" data-conv-id="' + esc(c.id) + '">' +
                        '<div class="gm-channel-icon"><i class="ph ph-user"></i></div>' +
                        '<div class="gm-channel-info">' +
                            '<div class="gm-channel-title">' + esc(title) + (isBlocked ? ' <span class="gm-badge-blocked">BLOCKED</span>' : '') + '</div>' +
                            '<div class="gm-channel-sub">E2EE Direct</div>' +
                        '</div>' +
                        unreadHtml +
                    '</div>';
                }).join('');
            }
        }

        // Render Group Discussions
        var groupContainer = document.getElementById('acc-body-group');
        if (groupContainer) {
            if (groupList.length === 0) {
                groupContainer.innerHTML = '<div class="gm-empty-acc-slot">' +
                    '<span>No active groups</span>' +
                    '<button type="button" class="gm-btn gm-btn-outline gm-btn-xs btn-quick-new-group"><i class="ph ph-plus"></i> New Group</button>' +
                '</div>';
            } else {
                groupContainer.innerHTML = groupList.map(function (c) {
                    var isSelected = currentConversation && currentConversation.id === c.id;
                    var unread = unreadCounts[c.id] || 0;
                    var unreadHtml = unread > 0 ? '<div class="gm-channel-unread-bubble">' + (unread > 99 ? '99+' : unread) + '</div>' : '';

                    return '<div class="gm-hall-channel-item ' + (isSelected ? 'active' : '') + '" data-conv-id="' + esc(c.id) + '">' +
                        '<div class="gm-channel-icon"><i class="ph ph-users-three"></i></div>' +
                        '<div class="gm-channel-info">' +
                            '<div class="gm-channel-title">' + esc(c.title) + '</div>' +
                            '<div class="gm-channel-sub">' + (c.members || []).length + ' Leaders • Coalition</div>' +
                        '</div>' +
                        unreadHtml +
                    '</div>';
                }).join('');
            }
        }

        // Render R5 Summit
        var r5Container = document.getElementById('acc-body-r5');
        if (r5Container) {
            if (r5List.length === 0) {
                r5Container.innerHTML = '<div class="gm-empty-acc-slot">' +
                    '<span>No R5 summits</span>' +
                    '<button type="button" class="gm-btn gm-btn-outline gm-btn-xs btn-quick-new-r5"><i class="ph ph-crown"></i> New Summit</button>' +
                '</div>';
            } else {
                r5Container.innerHTML = r5List.map(function (c) {
                    var isSelected = currentConversation && currentConversation.id === c.id;
                    var unread = unreadCounts[c.id] || 0;
                    var unreadHtml = unread > 0 ? '<div class="gm-channel-unread-bubble">' + (unread > 99 ? '99+' : unread) + '</div>' : '';

                    return '<div class="gm-hall-channel-item ' + (isSelected ? 'active' : '') + '" data-conv-id="' + esc(c.id) + '">' +
                        '<div class="gm-channel-icon" style="color:#facc15;"><i class="ph ph-crown"></i></div>' +
                        '<div class="gm-channel-info">' +
                            '<div class="gm-channel-title">' + esc(c.title) + ' <span class="gm-chip-r5">R5 ONLY</span></div>' +
                            '<div class="gm-channel-sub">' + (c.members || []).length + ' Guild Masters</div>' +
                        '</div>' +
                        unreadHtml +
                    '</div>';
                }).join('');
            }
        }

        updateAllUnreadBadges();

        document.querySelectorAll('.gm-hall-channel-item').forEach(function (el) {
            el.onclick = function () {
                var id = el.getAttribute('data-conv-id');
                selectConversation(id);
            };
        });

        var qDirect = document.querySelector('.btn-quick-new-direct');
        if (qDirect) qDirect.onclick = function () { showCreateModal('direct'); };
        var qGroup = document.querySelector('.btn-quick-new-group');
        if (qGroup) qGroup.onclick = function () { showCreateModal('group'); };
        var qR5 = document.querySelector('.btn-quick-new-r5');
        if (qR5) qR5.onclick = function () { showCreateModal('r5'); };
    }

    async function selectConversation(id) {
        var globalChannel = GLOBAL_CHANNELS.find(function (g) { return g.id === id; });
        if (globalChannel) {
            currentConversation = {
                id: globalChannel.id,
                type: 'global',
                title: globalChannel.title,
                subtitle: globalChannel.subtitle,
                isR5Only: false,
                members: []
            };
        } else {
            var conv = conversationsList.find(function (c) { return c.id === id; });
            if (!conv) return;
            currentConversation = conv;
            markConversationRead(id);
        }

        if (window.innerWidth <= 900) {
            document.body.classList.add('gm-mobile-chat-open');
        }

        var layout = document.querySelector('.gm-leader-hall-layout');
        if (layout) {
            layout.classList.add('gm-mobile-chat-active');
        }

        renderAccordions();
        renderActiveConversationHeader();

        if (currentConversation.id === DIPLOMACY_CHANNEL_ID) {
            // Show Treaty Registry & Feed
            await fetchTreaties();
            renderTreatiesRegistry();
            var inputBar = document.getElementById('leader-hall-input-bar');
            if (inputBar) inputBar.style.display = 'none';
        } else {
            var inputBar2 = document.getElementById('leader-hall-input-bar');
            if (inputBar2) inputBar2.style.display = 'flex';
            await loadAndRenderMessages();
        }

        subscribeToRealtime(currentConversation.id);
    }

    function renderActiveConversationHeader() {
        var header = document.getElementById('leader-hall-chat-header');
        if (!header || !currentConversation) return;

        var acc = getAccount();
        var accId = acc ? (acc.id || acc.account_id) : '';
        var isSuper = window.GM && window.GM.isSuperAdmin && window.GM.isSuperAdmin();
        var title = currentConversation.title;
        var subtitle = '';
        var actionsHtml = '';

        if (currentConversation.id === DIPLOMACY_CHANNEL_ID) {
            title = '📜 Diplomacy & Treaties';
            subtitle = 'Bilateral Pacts, Non-Aggression Treaties (N.A.P.) & Signatures';
            actionsHtml = '<button class="gm-btn gm-btn-primary gm-btn-xs" id="btn-header-propose-treaty"><i class="ph ph-pen-nib"></i> Propose Treaty</button>';
        } else if (currentConversation.type === 'global') {
            title = '🌐 ' + currentConversation.title;
            subtitle = currentConversation.subtitle || 'Universal Channel • Open to all Guild Leaders';
        } else if (currentConversation.type === 'direct') {
            var other = (currentConversation.members || []).find(function (m) { return m.account_id !== accId; });
            title = other ? formatLeaderTag(other.account_id, other.guild, other.server_number) : 'Direct Chat';
            subtitle = 'Direct 1:1 Signal Protocol Session';

            var isBlocked = other && blockedAccountIds.has(other.account_id);
            actionsHtml =
                '<button class="gm-btn gm-btn-outline gm-btn-xs" id="btn-safety-numbers" title="View Safety Fingerprint"><i class="ph ph-fingerprint"></i> Safety Code</button>' +
                '<button class="gm-btn gm-btn-outline gm-btn-xs" id="btn-toggle-block" style="' + (isBlocked ? 'color:#f87171; border-color:#f87171;' : '') + '">' +
                    '<i class="ph ph-prohibit"></i> ' + (isBlocked ? 'Unblock Leader' : 'Block Leader') +
                '</button>' +
                '<button class="gm-btn gm-btn-outline gm-btn-xs" id="btn-delete-conv" style="color:var(--danger);" title="Delete Conversation"><i class="ph ph-trash"></i> Delete</button>';
        } else {
            subtitle = (currentConversation.members || []).length + ' Leaders • ' + (currentConversation.isR5Only ? '👑 R5 Summit' : 'Tactical Group');
            var isCreator = currentConversation.createdBy === accId;

            actionsHtml =
                '<button class="gm-btn gm-btn-outline gm-btn-xs" id="btn-manage-members" title="Manage Group Participants"><i class="ph ph-users"></i> ' + (currentConversation.members || []).length + ' Members</button>' +
                '<button class="gm-btn gm-btn-primary gm-btn-xs" id="btn-header-add-member" title="Add Member to Group"><i class="ph ph-user-plus"></i> Add</button>' +
                '<button class="gm-btn gm-btn-outline gm-btn-xs" id="btn-rename-group" title="Rename Group"><i class="ph ph-pencil-simple"></i> Rename</button>' +
                '<button class="gm-btn gm-btn-outline gm-btn-xs" id="btn-leave-group" title="Leave Group"><i class="ph ph-sign-out"></i> Leave Group</button>' +
                (isCreator || isSuper ? '<button class="gm-btn gm-btn-outline gm-btn-xs" id="btn-delete-conv" style="color:var(--danger);" title="Delete Group"><i class="ph ph-trash"></i> Delete Group</button>' : '');
        }

        var isGroup = currentConversation.type === 'group';
        var titleHtml = isGroup ?
            '<h2 class="gm-chat-title" id="active-chat-title" style="display:inline-flex; align-items:center; gap:0.45rem; cursor:pointer;" title="Click to rename group">' +
                '<span>' + esc(title) + '</span>' +
                '<i class="ph ph-pencil-simple" style="font-size:0.85rem; color:var(--text-muted); opacity:0.75;"></i>' +
            '</h2>' :
            '<h2 class="gm-chat-title">' + esc(title) + '</h2>';

        var isProt = isProtectedConversation();
        var shieldBadge = isProt ?
            '<span class="gm-chip-shield" title="Copying, text selection, and screen capture are restricted"><i class="ph ph-shield-check"></i> Anti-Capture Protected</span>' : '';

        var backBtnHtml = '<button type="button" class="gm-chat-back-btn" id="btn-back-to-channels" title="Back to Channels"><i class="ph ph-arrow-left"></i></button>';

        header.innerHTML =
            '<div class="gm-chat-header-left" style="display:flex; align-items:center; gap:0.4rem; min-width:0; flex:1;">' +
                backBtnHtml +
                '<div style="min-width:0; flex:1;">' +
                    titleHtml +
                    '<div style="display:flex; align-items:center; gap:0.4rem; flex-wrap:wrap; margin-top:2px;">' +
                        '<div class="gm-chat-e2ee-tag">' +
                            '<i class="ph ph-lock-key"></i>' +
                            '<span>' + esc(subtitle) + '</span>' +
                        '</div>' +
                        shieldBadge +
                    '</div>' +
                '</div>' +
            '</div>' +
            '<div class="gm-chat-header-actions" style="display:flex; align-items:center; gap:0.4rem;">' +
                actionsHtml +
            '</div>';

        var btnBack = document.getElementById('btn-back-to-channels');
        if (btnBack) {
            btnBack.onclick = function () {
                document.body.classList.remove('gm-mobile-chat-open');
                var l = document.querySelector('.gm-leader-hall-layout');
                if (l) l.classList.remove('gm-mobile-chat-active');
            };
        }

        var titleEl = document.getElementById('active-chat-title');
        if (titleEl) {
            titleEl.onclick = function () {
                handleRenameGroup(currentConversation.id);
            };
        }

        var btnRename = document.getElementById('btn-rename-group');
        if (btnRename) {
            btnRename.onclick = function () {
                handleRenameGroup(currentConversation.id);
            };
        }

        var btnManageMembers = document.getElementById('btn-manage-members');
        if (btnManageMembers) btnManageMembers.onclick = showGroupMembersModal;

        var btnHeaderAddMember = document.getElementById('btn-header-add-member');
        if (btnHeaderAddMember) btnHeaderAddMember.onclick = showGroupMembersModal;

        var btnPropose = document.getElementById('btn-header-propose-treaty');
        if (btnPropose) btnPropose.onclick = showCreateTreatyModal;

        var btnSafety = document.getElementById('btn-safety-numbers');
        if (btnSafety) btnSafety.onclick = showSafetyNumbersModal;

        var btnBlock = document.getElementById('btn-toggle-block');
        if (btnBlock) {
            btnBlock.onclick = function () {
                var otherMem = (currentConversation.members || []).find(function (m) { return m.account_id !== accId; });
                if (otherMem) handleToggleBlock(otherMem.account_id);
            };
        }

        var btnDelete = document.getElementById('btn-delete-conv');
        if (btnDelete) {
            btnDelete.onclick = function () {
                handleDeleteConversation(currentConversation.id);
            };
        }

        var btnLeave = document.getElementById('btn-leave-group');
        if (btnLeave) {
            btnLeave.onclick = function () {
                handleLeaveGroup(currentConversation.id);
            };
        }
    }

    function showGroupMembersModal() {
        var modal = document.getElementById('modal-group-members');
        if (!modal || !currentConversation || currentConversation.type !== 'group') return;

        var acc = getAccount();
        var accId = acc ? (acc.id || acc.account_id) : '';
        var isSuper = window.GM && window.GM.isSuperAdmin && window.GM.isSuperAdmin();
        var isCreator = currentConversation.createdBy === accId;

        var members = currentConversation.members || [];
        var existingIds = new Set(members.map(function (m) { return m.account_id; }));

        // Candidates to add
        var candidateLeaders = activeAccounts.filter(function (a) {
            if (existingIds.has(a.id)) return false;
            if (currentConversation.isR5Only) {
                var r = (a.role || '').toLowerCase();
                return r === 'super_admin' || r === 'r5' || r === 'admin';
            }
            return true;
        });

        var addOptionsHtml = candidateLeaders.map(function (a) {
            return '<option value="' + esc(a.id) + '">' + esc(formatLeaderTag(a.id, a.guild, a.server_number)) + '</option>';
        }).join('');

        var membersListHtml = members.map(function (m) {
            var isThisCreator = currentConversation.createdBy === m.account_id;
            var canRemove = (isCreator || isSuper) && !isThisCreator;
            var isSelf = (m.account_id === accId);
            var sNum = resolveLeaderServer(m.account_id, m.guild, m.server_number);

            var badgeRole = isThisCreator ?
                '<span class="gm-chip" style="background:rgba(234,179,8,0.15); color:#facc15; font-size:0.72rem; padding:1px 6px;">👑 Creator</span>' :
                '<span class="gm-chip" style="font-size:0.72rem; padding:1px 6px;">Member</span>';

            return '<div class="gm-direct-leader-row" style="padding:0.45rem 0.5rem; background:rgba(255,255,255,0.02); margin-bottom:4px; border-radius:var(--radius-sm);">' +
                '<div style="display:flex; align-items:center; gap:0.5rem;">' +
                    '<span class="gm-picker-guild">[' + esc(m.guild || 'FGF') + ']</span>' +
                    '<span style="font-weight:700; color:var(--text-main);">' + esc(m.account_id) + '</span>' +
                    '<span class="gm-picker-server" style="font-size:0.75rem; color:var(--text-muted); font-weight:500;">#' + esc(sNum) + '</span>' +
                    badgeRole +
                '</div>' +
                '<div>' +
                    (canRemove ? '<button type="button" class="gm-btn gm-btn-outline gm-btn-xs btn-remove-member" style="color:var(--danger); border-color:rgba(239,68,68,0.3);" data-member-id="' + esc(m.account_id) + '"><i class="ph ph-user-minus"></i> Remove</button>' : '') +
                    (isSelf && !isThisCreator ? '<button type="button" class="gm-btn gm-btn-outline gm-btn-xs btn-remove-member" style="color:var(--text-muted);" data-member-id="' + esc(m.account_id) + '"><i class="ph ph-sign-out"></i> Leave</button>' : '') +
                '</div>' +
            '</div>';
        }).join('');

        var titleEl = document.getElementById('modal-group-members-title');
        if (titleEl) {
            titleEl.innerHTML = '<i class="ph ph-users-three" style="color:var(--primary);"></i> ' + esc(currentConversation.title) + ' (' + members.length + ' Participants)';
        }

        var body = document.getElementById('modal-group-members-body');
        if (body) {
            body.innerHTML =
                '<div style="background:rgba(56,189,248,0.04); border:1px solid rgba(56,189,248,0.15); border-radius:var(--radius-md); padding:0.75rem;">' +
                    '<label style="display:block; font-size:0.8rem; font-weight:700; color:var(--text-main); margin-bottom:0.35rem;">Add Leader to Group</label>' +
                    (candidateLeaders.length > 0 ?
                        '<div style="display:flex; gap:0.5rem;">' +
                            '<select id="select-add-member-id" class="gm-input" style="flex:1;">' +
                                addOptionsHtml +
                            '</select>' +
                            '<button type="button" class="gm-btn gm-btn-primary gm-btn-sm" id="btn-submit-add-member">' +
                                '<i class="ph ph-user-plus"></i> Add' +
                            '</button>' +
                        '</div>' :
                        '<div style="font-size:0.8rem; color:var(--text-muted);">All eligible leaders are already in this group.</div>'
                    ) +
                '</div>' +
                '<div>' +
                    '<div style="font-size:0.8rem; font-weight:700; color:var(--text-muted); margin-bottom:0.4rem;">Current Participants (' + members.length + ')</div>' +
                    '<div style="max-height:240px; overflow-y:auto; border:1px solid var(--border-soft); border-radius:var(--radius-md); padding:0.35rem;">' +
                        (membersListHtml || '<div class="gm-empty" style="padding:1rem;">No members found</div>') +
                    '</div>' +
                '</div>';

            var btnAddSubmit = document.getElementById('btn-submit-add-member');
            if (btnAddSubmit) {
                btnAddSubmit.onclick = async function () {
                    var sel = document.getElementById('select-add-member-id');
                    if (!sel || !sel.value) return;
                    var targetId = sel.value;
                    await handleAddGroupMember(currentConversation.id, targetId);
                };
            }

            body.querySelectorAll('.btn-remove-member').forEach(function (btn) {
                btn.onclick = async function () {
                    var targetId = btn.getAttribute('data-member-id');
                    if (targetId) await handleRemoveGroupMember(currentConversation.id, targetId);
                };
            });
        }

        modal.classList.remove('hidden');
    }

    async function handleAddGroupMember(convId, targetAccountId) {
        var db = getDb();
        if (!db) return;

        try {
            var res = await db.rpc('gm_add_e2ee_group_members', {
                p_conversation_id: convId,
                p_account_ids: [targetAccountId]
            });

            if (res.error) throw res.error;

            var memRes = await db
                .from('e2ee_conversation_members')
                .select('account_id, guild, role, group_role')
                .eq('conversation_id', convId);

            if (currentConversation && currentConversation.id === convId) {
                currentConversation.members = memRes.data || [];
                var found = conversationsList.find(function (c) { return c.id === convId; });
                if (found) found.members = memRes.data || [];
            }

            renderAccordions();
            renderActiveConversationHeader();
            showGroupMembersModal();
        } catch (err) {
            console.error('Error adding member to group', err);
            alert('Failed to add member: ' + (err.message || err));
        }
    }

    async function handleRemoveGroupMember(convId, targetAccountId) {
        var acc = getAccount();
        var accId = acc ? (acc.id || acc.account_id) : '';
        var isSelf = (targetAccountId === accId);

        if (!confirm('Are you sure you want to ' + (isSelf ? 'leave' : 'remove ' + targetAccountId + ' from') + ' this group?')) return;

        var db = getDb();
        if (!db) return;

        try {
            var res = await db.rpc('gm_remove_e2ee_group_member', {
                p_conversation_id: convId,
                p_target_account_id: targetAccountId
            });

            if (res.error) throw res.error;

            if (isSelf) {
                document.getElementById('modal-group-members').classList.add('hidden');
                currentConversation = null;
                await fetchConversations();
                selectConversation(GLOBAL_CHANNELS[0].id);
                return;
            }

            var memRes = await db
                .from('e2ee_conversation_members')
                .select('account_id, guild, role, group_role')
                .eq('conversation_id', convId);

            if (currentConversation && currentConversation.id === convId) {
                currentConversation.members = memRes.data || [];
                var found = conversationsList.find(function (c) { return c.id === convId; });
                if (found) found.members = memRes.data || [];
            }

            renderAccordions();
            renderActiveConversationHeader();
            showGroupMembersModal();
        } catch (err) {
            console.error('Error removing member from group', err);
            alert('Failed to remove member: ' + (err.message || err));
        }
    }

    async function handleRenameGroup(convId) {
        if (!currentConversation || currentConversation.type !== 'group') return;
        var currentTitle = currentConversation.title || '';
        var newTitle = prompt('Enter new discussion group name:', currentTitle);
        if (!newTitle || !newTitle.trim() || newTitle.trim() === currentTitle) return;

        var cleanTitle = newTitle.trim();
        if (cleanTitle.length < 2 || cleanTitle.length > 100) {
            alert('Group title must be between 2 and 100 characters.');
            return;
        }

        var db = getDb();
        if (!db) return;

        try {
            var res = await db.rpc('gm_rename_e2ee_conversation', {
                p_conversation_id: convId,
                p_new_title: cleanTitle
            });

            if (res.error) throw res.error;

            currentConversation.title = cleanTitle;
            var found = conversationsList.find(function (c) { return c.id === convId; });
            if (found) found.title = cleanTitle;

            renderAccordions();
            renderActiveConversationHeader();
        } catch (err) {
            console.error('Error renaming group', err);
            alert('Failed to rename group: ' + (err.message || err));
        }
    }

    async function handleToggleBlock(targetAccountId) {
        var isBlocked = blockedAccountIds.has(targetAccountId);
        var actionText = isBlocked ? 'unblock' : 'block';
        if (!confirm('Are you sure you want to ' + actionText + ' ' + targetAccountId + '?')) return;

        var db = getDb();
        if (!db) return;

        try {
            var res = await db.rpc('gm_toggle_block_leader', {
                p_target_account_id: targetAccountId,
                p_block: !isBlocked
            });

            if (res.error) throw res.error;
            if (isBlocked) {
                blockedAccountIds.delete(targetAccountId);
            } else {
                blockedAccountIds.add(targetAccountId);
            }

            renderAccordions();
            renderActiveConversationHeader();
            await loadAndRenderMessages();
        } catch (err) {
            alert('Failed to ' + actionText + ' leader: ' + (err.message || err));
        }
    }

    async function handleDeleteConversation(convId) {
        if (!confirm('Are you sure you want to delete this discussion?')) return;

        var db = getDb();
        if (!db) return;

        try {
            var res = await db.rpc('gm_delete_e2ee_conversation', { p_conversation_id: convId });
            if (res.error) throw res.error;

            currentConversation = null;
            await fetchConversations();
            selectConversation(GLOBAL_CHANNELS[0].id);
        } catch (err) {
            alert('Failed to delete discussion: ' + (err.message || err));
        }
    }

    async function handleLeaveGroup(convId) {
        if (!confirm('Are you sure you want to leave this group?')) return;

        var db = getDb();
        if (!db) return;

        try {
            var res = await db.rpc('gm_leave_e2ee_conversation', { p_conversation_id: convId });
            if (res.error) throw res.error;

            currentConversation = null;
            await fetchConversations();
            selectConversation(GLOBAL_CHANNELS[0].id);
        } catch (err) {
            alert('Failed to leave group: ' + (err.message || err));
        }
    }

    async function loadAndRenderMessages() {
        var container = document.getElementById('leader-hall-messages');
        if (!container || !currentConversation) return;

        var db = getDb();
        if (!db) return;

        container.innerHTML = '<div class="gm-empty" style="padding:3rem 1rem;"><i class="ph-duotone ph-circle-notch ph-spin gm-icon"></i><div class="gm-empty-title">Decrypting messages...</div></div>';

        var mainEl = document.querySelector('.gm-leader-hall-main');
        var isProt = isProtectedConversation();
        if (mainEl) {
            if (isProt) {
                mainEl.classList.add('gm-protected-session');
            } else {
                mainEl.classList.remove('gm-protected-session');
            }
        }
        if (container) {
            if (isProt) {
                container.classList.add('gm-has-watermark');
            } else {
                container.classList.remove('gm-has-watermark');
            }
        }

        try {
            await fetchReactions(currentConversation.id);

            var res = await db
                .from('e2ee_messages')
                .select('*')
                .eq('conversation_id', currentConversation.id)
                .order('id', { ascending: true });

            var messages = res.data || [];
            // Strict monotonic ordering by message sequence ID
            messages.sort(function (a, b) { return Number(a.id) - Number(b.id); });

            if (messages.length === 0) {
                container.innerHTML =
                    '<div class="gm-empty" style="padding:3rem 1rem;">' +
                        '<i class="ph ph-shield-check gm-icon" style="color:var(--primary, #38bdf8); font-size:2rem;"></i>' +
                        '<div class="gm-empty-title" style="margin-top:0.5rem;">' + (currentConversation.type === 'global' ? 'Welcome to ' + currentConversation.title : 'End-to-End Encrypted Session Established') + '</div>' +
                        '<p style="color:var(--text-muted); font-size:0.85rem; max-width:400px; margin:0.5rem auto;">' +
                            (currentConversation.type === 'global' ? currentConversation.subtitle : 'Messages in this private discussion are protected by the Signal Protocol.') +
                        '</p>' +
                    '</div>';
                return;
            }

            var html = '';
            var acc = getAccount();
            var accId = acc ? (acc.id || acc.account_id) : '';

            // Generate forensic watermark overlay
            var watermarkHtml = '';
            if (isProt) {
                var callerGuild = acc ? (acc.guild || 'FGF') : 'FGF';
                var callerServerNum = resolveLeaderServer(accId, callerGuild, acc ? acc.server_number : '');
                var watermarkText = '[' + esc(callerGuild) + '] ' + esc(accId) + ' #' + esc(callerServerNum) + ' • CONFIDENTIAL';
                watermarkHtml = '<div class="gm-watermark-overlay" aria-hidden="true">';
                for (var w = 0; w < 16; w++) {
                    watermarkHtml += '<div class="gm-watermark-item">' + watermarkText + '</div>';
                }
                watermarkHtml += '</div>';
            }

            for (var i = 0; i < messages.length; i++) {
                var m = messages[i];
                var isMe = m.sender_account_id === accId;
                var rawDecrypted = await decryptMessage(m);
                var parsedPayload = parseMessagePayload(rawDecrypted);
                var text = parsedPayload.text;
                var replyTo = parsedPayload.replyTo;
                var formattedBody = formatMessageBody(text, accId);
                var timeStr = formatMessageTimestamp(m.created_at);

                // Quote card HTML
                var quoteHtml = '';
                if (replyTo && replyTo.snippet) {
                    var qSender = formatLeaderTag(replyTo.sender, replyTo.guild);
                    quoteHtml =
                        '<div class="gm-message-quote" data-quote-id="' + esc(String(replyTo.id)) + '" title="Click to jump to original message">' +
                            '<div class="gm-quote-sender"><i class="ph ph-arrow-bend-up-left"></i> ' + esc(qSender) + '</div>' +
                            '<div class="gm-quote-text">' + esc(replyTo.snippet) + '</div>' +
                        '</div>';
                }

                // Reactions row HTML
                var msgReactions = messageReactions[String(m.id)] || [];
                var aggReactions = aggregateReactions(msgReactions, accId);
                var reactionsHtml = '';
                if (aggReactions.length > 0) {
                    reactionsHtml = '<div class="gm-message-reactions-row">';
                    aggReactions.forEach(function (ag) {
                        var userList = ag.users.join(', ');
                        reactionsHtml +=
                            '<button type="button" class="gm-reaction-pill ' + (ag.hasReacted ? 'has-reacted' : '') + '" data-msg-id="' + esc(String(m.id)) + '" data-emoji="' + esc(ag.emoji) + '" title="Reacted by ' + esc(userList) + '">' +
                                '<span>' + esc(ag.emoji) + '</span>' +
                                '<span class="gm-reaction-count">' + ag.count + '</span>' +
                            '</button>';
                    });
                    reactionsHtml += '</div>';
                }

                // Quick actions bar
                var actionsBarHtml =
                    '<div class="gm-message-actions-bar">' +
                        QUICK_EMOJIS.map(function (em) {
                            return '<button type="button" class="gm-action-emoji-btn" data-msg-id="' + esc(String(m.id)) + '" data-emoji="' + esc(em) + '" title="React ' + esc(em) + '">' + esc(em) + '</button>';
                        }).join('') +
                        '<button type="button" class="gm-action-reply-btn btn-reply-msg" data-msg-id="' + esc(String(m.id)) + '" data-sender="' + esc(m.sender_account_id) + '" data-guild="' + esc(m.sender_guild || '') + '">' +
                            '<i class="ph ph-arrow-bend-up-left"></i> Reply' +
                        '</button>' +
                    '</div>';

                var hasReactions = aggReactions.length > 0;
                html +=
                    '<div class="gm-message-row ' + (isMe ? 'me' : 'other') + (hasReactions ? ' has-reactions' : '') + '" id="msg-row-' + esc(String(m.id)) + '" data-msg-id="' + esc(String(m.id)) + '" data-text="' + esc(text) + '">' +
                        actionsBarHtml +
                        '<div class="gm-message-bubble">' +
                            (!isMe ? '<div class="gm-message-sender">' + formatLeaderHtml(m.sender_account_id, m.sender_guild) + '</div>' : '') +
                            quoteHtml +
                            '<div class="gm-message-body">' + formattedBody + '</div>' +
                            '<div class="gm-message-meta">' +
                                '<span>' + esc(timeStr) + '</span>' +
                                '<i class="ph ph-lock-key" style="font-size:0.75rem; margin-left:4px;" title="Signal E2EE Encrypted"></i>' +
                            '</div>' +
                            reactionsHtml +
                        '</div>' +
                    '</div>';
            }

            container.innerHTML = watermarkHtml + html;
            container.scrollTop = container.scrollHeight;

            // Bind click handlers for quotes, replies and reactions
            container.querySelectorAll('.gm-message-quote').forEach(function (qEl) {
                qEl.onclick = function (e) {
                    e.stopPropagation();
                    var qId = qEl.getAttribute('data-quote-id');
                    if (qId) {
                        var target = document.getElementById('msg-row-' + qId);
                        if (target) {
                            target.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            target.classList.remove('gm-highlight-jump');
                            void target.offsetWidth;
                            target.classList.add('gm-highlight-jump');
                        }
                    }
                };
            });

            container.querySelectorAll('.btn-reply-msg').forEach(function (rBtn) {
                rBtn.onclick = function (e) {
                    e.stopPropagation();
                    var mid = rBtn.getAttribute('data-msg-id');
                    var sender = rBtn.getAttribute('data-sender');
                    var guild = rBtn.getAttribute('data-guild');
                    var rowEl = document.getElementById('msg-row-' + mid);
                    var snippet = rowEl ? (rowEl.getAttribute('data-text') || '') : '';
                    setReplyingTo({ id: mid, sender: sender, guild: guild, snippet: snippet });
                };
            });

            container.querySelectorAll('.gm-action-emoji-btn, .gm-reaction-pill').forEach(function (btn) {
                btn.onclick = function (e) {
                    e.stopPropagation();
                    var mid = btn.getAttribute('data-msg-id');
                    var em = btn.getAttribute('data-emoji');
                    if (mid && em) handleToggleReaction(mid, em);
                };
            });

            if (messages.length > 0) {
                var maxId = messages[messages.length - 1].id;
                markConversationRead(currentConversation.id, maxId);
            }
        } catch (e) {
            console.error('Error loading messages', e);
            container.innerHTML = '<div class="gm-empty"><i class="ph ph-warning-circle gm-icon"></i><div class="gm-empty-title">Error loading messages</div></div>';
        }
    }

    function renderMessages() {
        if (currentConversation && currentConversation.id === DIPLOMACY_CHANNEL_ID) {
            fetchTreaties().then(renderTreatiesRegistry);
        } else {
            loadAndRenderMessages();
        }
    }

    function subscribeToRealtime(convId) {
        var db = getDb();
        if (!db) return;

        if (realtimeChannel) {
            db.removeChannel(realtimeChannel);
        }
        if (reactionsRealtimeChannel) {
            db.removeChannel(reactionsRealtimeChannel);
        }

        realtimeChannel = db.channel('e2ee_conv_' + convId)
            .on('postgres_changes', {
                event: 'INSERT',
                schema: 'public',
                table: 'e2ee_messages',
                filter: 'conversation_id=eq.' + convId
            }, function (payload) {
                renderMessages();
            })
            .subscribe();

        reactionsRealtimeChannel = db.channel('e2ee_reactions_' + convId)
            .on('postgres_changes', {
                event: '*',
                schema: 'public',
                table: 'e2ee_message_reactions',
                filter: 'conversation_id=eq.' + convId
            }, function (payload) {
                if (payload && payload.new && payload.new.message_id) {
                    fetchReactions(convId).then(function () {
                        renderMessageReactionsRow(payload.new.message_id);
                    });
                } else if (payload && payload.old && payload.old.message_id) {
                    fetchReactions(convId).then(function () {
                        renderMessageReactionsRow(payload.old.message_id);
                    });
                } else {
                    fetchReactions(convId).then(function () {
                        if (currentConversation && currentConversation.id === convId) {
                            Object.keys(messageReactions).forEach(renderMessageReactionsRow);
                        }
                    });
                }
            })
            .subscribe();

        if (!treatiesRealtimeChannel) {
            treatiesRealtimeChannel = db.channel('diplomatic_treaties_all')
                .on('postgres_changes', {
                    event: '*',
                    schema: 'public',
                    table: 'diplomatic_treaties'
                }, function () {
                    if (currentConversation && currentConversation.id === DIPLOMACY_CHANNEL_ID) {
                        fetchTreaties().then(renderTreatiesRegistry);
                    }
                })
                .subscribe();
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 6. MODALS: CREATE DISCUSSION & SAFETY NUMBERS
    // ─────────────────────────────────────────────────────────────────────────

    function showCreateModal(preselectType) {
        var modal = document.getElementById('modal-leader-create');
        if (!modal) return;

        var acc = getAccount();
        var accId = acc ? (acc.id || acc.account_id) : '';
        var isCallerR5 = isR5();

        var otherLeaders = activeAccounts.filter(function (a) {
            return a.id !== accId;
        });

        var directLeadersHtml = otherLeaders.map(function (a) {
            var sNum = resolveLeaderServer(a.id, a.guild, a.server_number);
            return '<div class="gm-direct-leader-row" data-account-id="' + esc(a.id) + '">' +
                '<div style="display:flex; align-items:center; gap:0.5rem;">' +
                    '<span class="gm-chip" style="font-weight:700;">[' + esc(a.guild || 'FGF') + ']</span>' +
                    '<span style="font-weight:600; color:var(--text-main);">' + esc(a.id) + '</span>' +
                    '<span class="gm-sender-server" style="font-size:0.8rem; font-weight:500;">#' + esc(sNum) + '</span>' +
                '</div>' +
                '<button type="button" class="gm-btn gm-btn-primary gm-btn-xs btn-start-direct-chat" data-account-id="' + esc(a.id) + '">' +
                    '<i class="ph ph-chat-circle"></i> Chat' +
                '</button>' +
            '</div>';
        }).join('');

        var groupLeadersHtml = otherLeaders.map(function (a) {
            var sNum = resolveLeaderServer(a.id, a.guild, a.server_number);
            return '<label class="gm-leader-picker-item" style="display:flex; align-items:center; gap:0.5rem; padding:0.35rem 0.5rem; border-radius:var(--radius-sm); cursor:pointer;">' +
                '<input type="checkbox" name="leader_member" value="' + esc(a.id) + '" data-role="' + esc(a.role) + '">' +
                '<span class="gm-picker-guild">[' + esc(a.guild || 'FGF') + ']</span>' +
                '<span class="gm-picker-name" style="font-weight:600;">' + esc(a.id) + '</span>' +
                '<span class="gm-picker-server" style="font-size:0.75rem; color:var(--text-muted); font-weight:500;">#' + esc(sNum) + '</span>' +
            '</label>';
        }).join('');

        var body = document.getElementById('modal-leader-create-body');
        if (body) {
            body.innerHTML =
                '<div class="gm-segmented-control" style="display:flex; gap:0.5rem; margin-bottom:1rem;">' +
                    '<button type="button" class="gm-seg-btn gm-btn gm-btn-sm ' + (preselectType !== 'group' && preselectType !== 'r5' ? 'active gm-btn-primary' : 'gm-btn-ghost') + '" data-type="direct" style="flex:1; justify-content:center;">' +
                        '<i class="ph ph-user"></i> 1:1 Direct Chat' +
                    '</button>' +
                    '<button type="button" class="gm-seg-btn gm-btn gm-btn-sm ' + (preselectType === 'group' || preselectType === 'r5' ? 'active gm-btn-primary' : 'gm-btn-ghost') + '" data-type="group" style="flex:1; justify-content:center;">' +
                        '<i class="ph ph-users-three"></i> Group Discussion' +
                    '</button>' +
                '</div>' +
                '<div id="panel-create-direct" class="' + (preselectType === 'group' || preselectType === 'r5' ? 'hidden' : '') + '">' +
                    '<div style="margin-bottom:0.5rem;">' +
                        '<input type="text" id="filter-direct-leaders" class="gm-input" placeholder="🔍 Search leader by name, guild..." style="width:100%;">' +
                    '</div>' +
                    '<div class="gm-direct-leader-list" id="direct-leader-list-container" style="max-height:240px; overflow-y:auto; border:1px solid var(--border-soft); border-radius:var(--radius-md); padding:0.25rem;">' +
                        (directLeadersHtml || '<div class="gm-empty" style="padding:1.5rem;">No other leaders found</div>') +
                    '</div>' +
                '</div>' +
                '<div id="panel-create-group" class="' + (preselectType !== 'group' && preselectType !== 'r5' ? 'hidden' : '') + '">' +
                    '<div class="gm-login-field" style="margin-bottom:0.75rem;">' +
                        '<label style="display:block; margin-bottom:0.25rem; font-size:0.85rem; color:var(--text-muted);">Group Title</label>' +
                        '<input type="text" id="input-group-title" class="gm-input" placeholder="' + (preselectType === 'r5' ? 'e.g. S1058 Executive R5 Summit' : 'e.g. SvS Northern Sector Coalition') + '" style="width:100%;">' +
                    '</div>' +
                    '<div class="gm-login-field" style="margin-bottom:0.75rem;">' +
                        '<label class="gm-checkbox-label" style="display:flex; align-items:center; gap:0.5rem; cursor:pointer;">' +
                            '<input type="checkbox" id="check-r5-only" ' + (preselectType === 'r5' ? 'checked ' : '') + (!isCallerR5 ? 'disabled' : '') + '> ' +
                            '<span style="color:#facc15; font-weight:600;"><i class="ph ph-crown"></i> 👑 R5-Only Summit (Guild Masters only)</span>' +
                        '</label>' +
                    '</div>' +
                    '<div class="gm-login-field">' +
                        '<label style="display:block; margin-bottom:0.25rem; font-size:0.85rem; color:var(--text-muted);">Select Participants</label>' +
                        '<div class="gm-leader-picker-list" style="max-height:180px; overflow-y:auto; border:1px solid var(--border-soft); border-radius:var(--radius-md); padding:0.35rem;">' +
                            (groupLeadersHtml || '<div class="gm-empty" style="padding:1rem;">No other leaders found</div>') +
                        '</div>' +
                    '</div>' +
                '</div>';

            var segBtns = body.querySelectorAll('.gm-seg-btn');
            segBtns.forEach(function (btn) {
                btn.addEventListener('click', function () {
                    segBtns.forEach(function (b) {
                        b.classList.remove('active', 'gm-btn-primary');
                        b.classList.add('gm-btn-ghost');
                    });
                    btn.classList.add('active', 'gm-btn-primary');
                    btn.classList.remove('gm-btn-ghost');
                    var type = btn.getAttribute('data-type');
                    var pDirect = document.getElementById('panel-create-direct');
                    var pGroup = document.getElementById('panel-create-group');
                    var submitBtn = document.getElementById('modal-leader-submit-btn');

                    if (type === 'group') {
                        if (pDirect) pDirect.classList.add('hidden');
                        if (pGroup) pGroup.classList.remove('hidden');
                        if (submitBtn) submitBtn.classList.remove('hidden');
                    } else {
                        if (pDirect) pDirect.classList.remove('hidden');
                        if (pGroup) pGroup.classList.add('hidden');
                        if (submitBtn) submitBtn.classList.add('hidden');
                    }
                });
            });

            body.querySelectorAll('.btn-start-direct-chat').forEach(function (btn) {
                btn.addEventListener('click', function () {
                    var targetId = btn.getAttribute('data-account-id');
                    if (targetId) startDirectChatWith(targetId);
                });
            });

            var directFilterInput = document.getElementById('filter-direct-leaders');
            if (directFilterInput) {
                directFilterInput.addEventListener('input', function () {
                    var q = directFilterInput.value.toLowerCase().trim();
                    body.querySelectorAll('.gm-direct-leader-row').forEach(function (row) {
                        var text = row.innerText.toLowerCase();
                        row.style.display = text.includes(q) ? 'flex' : 'none';
                    });
                });
            }

            var submitBtn = document.getElementById('modal-leader-submit-btn');
            if (submitBtn) {
                if (preselectType === 'group' || preselectType === 'r5') {
                    submitBtn.classList.remove('hidden');
                } else {
                    submitBtn.classList.add('hidden');
                }
            }
        }

        modal.classList.remove('hidden');
    }

    async function startDirectChatWith(targetAccountId) {
        var db = getDb();
        if (!db) return;

        try {
            var res = await db.rpc('gm_create_e2ee_conversation', {
                p_type: 'direct',
                p_title: null,
                p_is_r5_only: false,
                p_member_account_ids: [targetAccountId]
            });

            if (res.error) throw res.error;
            var newId = res.data;
            document.getElementById('modal-leader-create').classList.add('hidden');
            await fetchConversations();
            renderAccordions();
            if (newId) selectConversation(newId);
        } catch (err) {
            console.error('Error starting direct chat', err);
            alert('Could not start direct chat: ' + (err.message || err));
        }
    }

    async function handleCreateSubmit() {
        var db = getDb();
        if (!db) return;

        var title = '';
        var titleInput = document.getElementById('input-group-title');
        if (titleInput) title = titleInput.value.trim();

        var isR5Only = false;
        var r5Check = document.getElementById('check-r5-only');
        if (r5Check) isR5Only = r5Check.checked;

        var checkedMembers = [];
        document.querySelectorAll('#modal-leader-create-body input[name="leader_member"]:checked').forEach(function (cb) {
            checkedMembers.push(cb.value);
        });

        if (checkedMembers.length === 0) {
            alert('Please select at least one leader.');
            return;
        }

        try {
            var res = await db.rpc('gm_create_e2ee_conversation', {
                p_type: 'group',
                p_title: title || (isR5Only ? 'R5 Summit' : 'Group Discussion'),
                p_is_r5_only: isR5Only,
                p_member_account_ids: checkedMembers
            });

            if (res.error) throw res.error;
            var newId = res.data;
            document.getElementById('modal-leader-create').classList.add('hidden');
            await fetchConversations();
            renderAccordions();
            if (newId) selectConversation(newId);
        } catch (err) {
            console.error('Error creating discussion', err);
            alert('Could not create discussion: ' + (err.message || err));
        }
    }

    async function showSafetyNumbersModal() {
        var modal = document.getElementById('modal-safety-numbers');
        if (!modal || !currentConversation || currentConversation.type !== 'direct') return;

        var S = getSignal();
        var acc = getAccount();
        var accId = acc ? (acc.id || acc.account_id) : '';
        var other = (currentConversation.members || []).find(function (m) { return m.account_id !== accId; });
        if (!other || !localIdentity) return;

        var db = getDb();
        var rpcRes = await db.rpc('gm_get_e2ee_prekey_bundle', { p_target_account_id: other.account_id });
        if (rpcRes.data && rpcRes.data[0]) {
            var otherBundle = rpcRes.data[0];
            var safety = S.computeSafetyNumber(
                accId,
                S.hexToBytes(localIdentity.identityKey.publicKey),
                other.account_id,
                S.hexToBytes(otherBundle.identity_key)
            );

            var codeEl = document.getElementById('safety-numbers-code');
            if (codeEl) codeEl.innerText = safety;
            modal.classList.remove('hidden');
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 7. PUBLIC LIFECYCLE
    // ─────────────────────────────────────────────────────────────────────────

    async function load() {
        ensureLayoutRendered();

        if (!isLeader()) {
            var container = document.getElementById('tab-leader-hall');
            if (container) {
                container.innerHTML = '<div class="gm-empty" style="padding:4rem 1rem;"><i class="ph ph-shield-slash gm-icon" style="color:var(--danger);"></i><div class="gm-empty-title">Guild Leaders (R5/R4) Only</div><p style="color:var(--text-muted); font-size:0.9rem;">The Guild Leader Hall is strictly reserved for Guild Masters and Officers.</p></div>';
            }
            return;
        }

        await initSignalIdentity();
        await fetchBlockedAccounts();
        await fetchEligibleLeaders();
        await fetchConversations();
        initGlobalUnreadListener();
        var isMobile = window.innerWidth <= 900;
        if (!currentConversation) {
            if (!isMobile) {
                selectConversation(GLOBAL_CHANNELS[0].id);
            } else {
                renderAccordions();
            }
        } else {
            renderAccordions();
            renderActiveConversationHeader();
        }

        document.querySelectorAll('.gm-hall-acc-header').forEach(function (header) {
            header.onclick = function (e) {
                if (e.target.closest('.gm-acc-add-btn')) return;
                var space = header.getAttribute('data-space');
                var accEl = header.closest('.gm-hall-accordion');
                if (!accEl) return;
                accordionState[space] = !accordionState[space];
                if (accordionState[space]) {
                    accEl.classList.remove('is-collapsed');
                } else {
                    accEl.classList.add('is-collapsed');
                }
            };
        });

        var btnAddDirect = document.getElementById('btn-add-direct');
        if (btnAddDirect) btnAddDirect.onclick = function (e) { e.stopPropagation(); showCreateModal('direct'); };
        var btnAddGroup = document.getElementById('btn-add-group');
        if (btnAddGroup) btnAddGroup.onclick = function (e) { e.stopPropagation(); showCreateModal('group'); };
        var btnAddR5 = document.getElementById('btn-add-r5');
        if (btnAddR5) btnAddR5.onclick = function (e) { e.stopPropagation(); showCreateModal('r5'); };

        var sendBtn = document.getElementById('leader-hall-send-btn');
        var input = document.getElementById('leader-hall-msg-input');
        if (sendBtn && input) {
            sendBtn.onclick = function () {
                sendMessage(input.value);
                input.value = '';
            };
            input.onkeydown = function (e) {
                if (e.key === 'Enter' && !e.shiftKey) {
                    var popup = document.getElementById('leader-hall-mention-popup');
                    if (popup && !popup.classList.contains('hidden') && mentionCandidates.length > 0) {
                        return; // Let mention autocomplete handle selection!
                    }
                    e.preventDefault();
                    sendMessage(input.value);
                    input.value = '';
                }
            };
        }

        var btnCancelReply = document.getElementById('leader-hall-cancel-reply');
        if (btnCancelReply) {
            btnCancelReply.onclick = function () {
                clearReplyingTo();
            };
        }

        initMentionAutocomplete();

        var btnSubmitCreate = document.getElementById('modal-leader-submit-btn');
        if (btnSubmitCreate) {
            btnSubmitCreate.onclick = handleCreateSubmit;
        }

        var btnCloseModal = document.getElementById('modal-leader-close-btn');
        if (btnCloseModal) {
            btnCloseModal.onclick = function () {
                document.getElementById('modal-leader-create').classList.add('hidden');
            };
        }

        var btnCloseSafety = document.getElementById('modal-safety-close-btn');
        if (btnCloseSafety) {
            btnCloseSafety.onclick = function () {
                document.getElementById('modal-safety-numbers').classList.add('hidden');
            };
        }

        // Treaty Modal Handlers
        var btnSubmitTreaty = document.getElementById('modal-treaty-submit-btn');
        if (btnSubmitTreaty) btnSubmitTreaty.onclick = handleCreateTreatySubmit;

        var btnCloseTreaty = document.getElementById('modal-treaty-close-btn');
        if (btnCloseTreaty) {
            btnCloseTreaty.onclick = function () {
                document.getElementById('modal-treaty-create').classList.add('hidden');
            };
        }

        var btnCancelTreaty = document.getElementById('modal-treaty-cancel-btn');
        if (btnCancelTreaty) {
            btnCancelTreaty.onclick = function () {
                document.getElementById('modal-treaty-create').classList.add('hidden');
            };
        }

        // Group Members Modal Handlers
        var btnCloseMembers = document.getElementById('modal-group-members-close-btn');
        if (btnCloseMembers) {
            btnCloseMembers.onclick = function () {
                document.getElementById('modal-group-members').classList.add('hidden');
            };
        }

        var btnDoneMembers = document.getElementById('modal-group-members-done-btn');
        if (btnDoneMembers) {
            btnDoneMembers.onclick = function () {
                document.getElementById('modal-group-members').classList.add('hidden');
            };
        }

        setupAntiCaptureProtection();
    }

    var antiCaptureInitialized = false;

    var blackoutTimeout = null;

    function triggerBlackoutScreen(durationMs) {
        var overlay = document.getElementById('gm-anti-capture-fullscreen-overlay');
        if (!overlay) return;
        overlay.classList.remove('hidden');
        if (blackoutTimeout) {
            clearTimeout(blackoutTimeout);
            blackoutTimeout = null;
        }

        // Only set auto-dismiss timer if window is focused.
        // While window is unfocused / blurred, blackout remains permanently until focus returns.
        if (durationMs && document.hasFocus() && !document.hidden) {
            blackoutTimeout = setTimeout(function () {
                if (document.hasFocus() && !document.hidden) {
                    overlay.classList.add('hidden');
                }
            }, durationMs);
        }

        showSecurityNotification();
    }

    function dismissBlackoutScreen() {
        var overlay = document.getElementById('gm-anti-capture-fullscreen-overlay');
        if (overlay) overlay.classList.add('hidden');
        if (blackoutTimeout) {
            clearTimeout(blackoutTimeout);
            blackoutTimeout = null;
        }
    }

    var lastToastTime = 0;
    function showSecurityNotification() {
        var now = Date.now();
        if (now - lastToastTime < 2500) return;
        lastToastTime = now;
        if (window.GM && window.GM.showToast) {
            window.GM.showToast('🚫 Screen capture is restricted in confidential diplomatic sessions.', 'warning');
        }
    }

    function setupAntiCaptureProtection() {
        if (antiCaptureInitialized) return;
        antiCaptureInitialized = true;

        var overlay = document.getElementById('gm-anti-capture-fullscreen-overlay');
        if (overlay) {
            overlay.addEventListener('click', function () {
                dismissBlackoutScreen();
            });
        }

        // Global Anti-copy / cut / contextmenu on protected messages viewport
        ['copy', 'cut', 'contextmenu', 'dragstart', 'selectstart'].forEach(function (evt) {
            document.addEventListener(evt, function (e) {
                if (!isProtectedConversation()) return;
                var target = e.target;
                if (target && (target.closest('#leader-hall-messages') || target.closest('.gm-protected-session'))) {
                    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
                    e.preventDefault();
                    showSecurityNotification();
                }
            }, true);
        });

        // Window Blur & Visibility change (permanent blackout as long as window is not focused!)
        function handleVisibility() {
            var activeTab = document.querySelector('.tab-panel.active');
            var isLeaderHall = activeTab && activeTab.id === 'tab-leader-hall';
            if (isLeaderHall && isProtectedConversation()) {
                if (document.hidden || !document.hasFocus()) {
                    triggerBlackoutScreen(); // Indefinite blackout while unfocused!
                } else {
                    dismissBlackoutScreen(); // Dismiss as soon as user returns to the window!
                }
            }
        }

        window.addEventListener('blur', handleVisibility, true);
        window.addEventListener('focus', handleVisibility, true);
        document.addEventListener('visibilitychange', handleVisibility, true);

        // Universal Keyboard Screenshot Interceptions (Mac, Windows, Linux)
        function handleScreenshotKey(e) {
            if (!isProtectedConversation()) return;

            var activeTab = document.querySelector('.tab-panel.active');
            if (!activeTab || activeTab.id !== 'tab-leader-hall') return;

            if (e.key === 'Escape' && overlay) {
                overlay.classList.add('hidden');
                if (blackoutTimeout) clearTimeout(blackoutTimeout);
                return;
            }

            // Proactive Mac/Win modifier chord detection: the instant Cmd+Shift or Win+Shift or Cmd+Alt is pressed
            var hasCmdOrCtrl = e.metaKey || e.ctrlKey;
            var isModifierChord = (hasCmdOrCtrl && e.shiftKey) ||
                                  (hasCmdOrCtrl && e.altKey) ||
                                  (e.key === 'Shift' && hasCmdOrCtrl) ||
                                  ((e.key === 'Meta' || e.key === 'Control') && e.shiftKey);

            var isPrtScn = e.key === 'PrintScreen' || e.code === 'PrintScreen' || e.keyCode === 44 || e.which === 44;
            var isPrintPdf = hasCmdOrCtrl && (e.key === 'p' || e.key === 'P' || e.code === 'KeyP');

            if (isModifierChord || isPrtScn || isPrintPdf) {
                triggerBlackoutScreen(3500);
            }

            // Block copy shortcut inside messages
            if (hasCmdOrCtrl && (e.key === 'c' || e.key === 'C' || e.code === 'KeyC')) {
                var target = e.target;
                if (target && target.closest && (target.closest('#leader-hall-messages') || target.closest('.gm-protected-session'))) {
                    if (target.id === 'leader-hall-msg-input') return;
                    e.preventDefault();
                    showSecurityNotification();
                }
            }
        }

        window.addEventListener('keydown', handleScreenshotKey, true);
        window.addEventListener('keyup', handleScreenshotKey, true);
    }

    return {
        load: load,
        initSignalIdentity: initSignalIdentity,
        fetchConversations: fetchConversations,
        fetchTreaties: fetchTreaties,
        sendMessage: sendMessage,
        decryptMessage: decryptMessage,
        initGlobalUnreadListener: initGlobalUnreadListener,
        fetchUnreadCounts: fetchUnreadCounts,
        markConversationRead: markConversationRead,
        updateAllUnreadBadges: updateAllUnreadBadges,
        parseMessagePayload: parseMessagePayload,
        formatMessageBody: formatMessageBody,
        aggregateReactions: aggregateReactions,
        getMentionCandidates: getMentionCandidates,
        setReplyingTo: setReplyingTo,
        clearReplyingTo: clearReplyingTo,
        handleToggleReaction: handleToggleReaction,
        formatLeaderTag: formatLeaderTag,
        formatLeaderHtml: formatLeaderHtml,
        resolveLeaderServer: resolveLeaderServer,
        formatMessageTimestamp: formatMessageTimestamp
    };
});
