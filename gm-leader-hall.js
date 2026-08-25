/**
 * gm-leader-hall.js — Guild Leader Hall (Global Lounge + E2EE 1:1 & Groups)
 * FGF Guild Management Tool — 2026 Zero-Trust Architecture
 *
 * Implements:
 * 1. Pinned Global Leaders Lounge (All Guild Leaders across all servers)
 * 2. 1:1 Direct Discussions (Double Ratchet E2EE with X3DH handshake)
 * 3. Custom Group Discussions (Signal Sender Keys with R5-only filter)
 * 4. Realtime messaging subscription & Presence engine
 * 5. Safety Numbers verification modal (60-digit fingerprint)
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.GM_LEADER_HALL = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var GLOBAL_CONV_ID = '00000000-0000-0000-0000-000000000001';
    var esc = (window.GM && window.GM.escapeHTML) ? window.GM.escapeHTML : function (s) { return s || ''; };
    var t = (window.GM && window.GM.t) ? window.GM.t : function (k) { return k; };

    var currentConversation = null;
    var conversationsList = [];
    var activeFilter = 'all'; // 'all' | 'direct' | 'group' | 'r5'
    var realtimeChannel = null;
    var localIdentity = null;
    var activeAccounts = [];
    var decryptedCache = {}; // messageId -> plaintext

    var GLOBAL_LOUNGE_CONV = {
        id: GLOBAL_CONV_ID,
        type: 'global',
        title: 'Global Leaders Lounge',
        isR5Only: false,
        members: []
    };

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
        var server = localStorage.getItem('gm_server_restriction') || null;

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
            if (r === 'super_admin' || r === 'r5' || r === 'admin') return true;
        }
        var acc = getAccount();
        if (!acc) return false;
        var accRole = (acc.role || '').toLowerCase();
        return accRole === 'super_admin' || accRole === 'r5' || accRole === 'admin';
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 1. SIGNAL IDENTITY & PREKEY SYNC
    // ─────────────────────────────────────────────────────────────────────────

    async function initSignalIdentity() {
        var S = getSignal();
        var acc = getAccount();
        var db = getDb();
        if (!S || !acc || !db) return null;

        var accId = acc.id || acc.account_id;
        var stored = await S.loadKeyRecord('identity_keys', accId);

        if (stored && stored.identityKey) {
            localIdentity = stored;
            return stored;
        }

        var bundle = S.createPreKeyBundle(30);
        var recordToStore = {
            identityKey: {
                privateKey: S.bytesToHex(bundle.identityKey.privateKey),
                publicKey: S.bytesToHex(bundle.identityKey.publicKey)
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

        try {
            await db.from('e2ee_prekey_bundles').upsert({
                account_id: accId,
                identity_key: recordToStore.identityKey.publicKey,
                signed_prekey: recordToStore.signedPreKey.keyPair.publicKey,
                signed_prekey_sig: recordToStore.signedPreKey.signature,
                registration_id: recordToStore.registrationId,
                updated_at: new Date().toISOString()
            });

            var otksToInsert = recordToStore.oneTimePreKeys.map(function (otk) {
                return {
                    account_id: accId,
                    key_id: otk.keyId,
                    public_key: otk.publicKey,
                    is_used: false
                };
            });

            await db.from('e2ee_one_time_prekeys').upsert(otksToInsert, { onConflict: 'account_id,key_id' });
        } catch (err) {
            console.error('Error publishing E2EE prekey bundle', err);
        }

        return localIdentity;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. CONVERSATION MANAGEMENT & FETCHING
    // ─────────────────────────────────────────────────────────────────────────

    async function fetchConversations() {
        var db = getDb();
        var acc = getAccount();
        if (!db || !acc) return [GLOBAL_LOUNGE_CONV];

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
            return list;
        } catch (err) {
            console.error('Error fetching E2EE conversations', err);
            return [];
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
            return activeAccounts;
        } catch (e) {
            return [];
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 3. E2EE DOUBLE RATCHET & SENDER KEY SESSIONS
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

        var rpcRes = await db.rpc('gm_get_e2ee_prekey_bundle', { p_target_account_id: targetAccountId });
        if (rpcRes.error || !rpcRes.data || rpcRes.data.length === 0) {
            throw new Error('Could not fetch recipient prekey bundle');
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

    // ─────────────────────────────────────────────────────────────────────────
    // 4. SEND & DECRYPT MESSAGES
    // ─────────────────────────────────────────────────────────────────────────

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

        try {
            var encrypted = null;
            if (currentConversation.type === 'direct') {
                var otherMember = (currentConversation.members || []).find(function (m) { return m.account_id !== accId; });
                var targetId = otherMember ? otherMember.account_id : accId;
                var session = await getOrEstablish1to1Session(targetId);
                encrypted = await S.doubleRatchetEncrypt(session, cleanText);
                await saveSession(accId + ':' + targetId, session);
            } else {
                var senderKey = await getOrEstablishGroupSenderKey(currentConversation.id);
                encrypted = await S.groupSenderKeyEncrypt(senderKey, cleanText);
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
                iv: encrypted.iv,
                created_at: new Date().toISOString()
            }).select();

            if (insertRes.data && insertRes.data[0]) {
                decryptedCache[insertRes.data[0].id] = cleanText;
            }

            renderMessages();
        } catch (err) {
            console.error('Failed to encrypt & send E2EE message', err);
            alert('Failed to send encrypted message: ' + (err.message || err));
        }
    }

    async function decryptMessage(msg) {
        if (decryptedCache[msg.id]) return decryptedCache[msg.id];
        var S = getSignal();
        var acc = getAccount();
        var accId = acc ? (acc.id || acc.account_id) : '';

        try {
            var plaintext = '';
            if (currentConversation.type === 'direct') {
                if (msg.sender_account_id === accId) {
                    plaintext = '[Your message]';
                } else {
                    var session = await getOrEstablish1to1Session(msg.sender_account_id);
                    plaintext = await S.doubleRatchetDecrypt(session, msg.header_data, msg.iv, msg.ciphertext);
                    await saveSession(accId + ':' + msg.sender_account_id, session);
                }
            } else {
                var senderKey = await getOrEstablishGroupSenderKey(currentConversation.id);
                plaintext = await S.groupSenderKeyDecrypt(senderKey, msg.header_data, msg.iv, msg.ciphertext);
            }
            decryptedCache[msg.id] = plaintext;
            return plaintext;
        } catch (err) {
            return '[🔒 Decryption Error - Key Mismatch]';
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 5. UI RENDERING & EVENT HANDLERS
    // ─────────────────────────────────────────────────────────────────────────

    function ensureLayoutRendered() {
        var container = document.getElementById('tab-leader-hall');
        if (!container) return;
        if (document.getElementById('leader-hall-conv-list')) return;

        container.innerHTML =
            '<div class="gm-page" style="max-width:1400px; padding:0 0.5rem;">' +
                '<header class="gm-page-header" style="margin-bottom:1rem;">' +
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
                        '<div class="gm-hall-section-title"><i class="ph ph-broadcast"></i> MAIN CHANNELS</div>' +
                        '<div class="gm-hall-global-channel-box" id="btn-select-global-lounge">' +
                            '<div class="gm-global-icon"><i class="ph ph-planet"></i></div>' +
                            '<div class="gm-global-info">' +
                                '<div class="gm-global-title">Global Leaders Lounge</div>' +
                                '<div class="gm-global-sub">All Guilds & Servers (R5/R4)</div>' +
                            '</div>' +
                            '<span class="gm-global-badge">LIVE</span>' +
                        '</div>' +
                        '<div class="gm-hall-section-title" style="margin-top:1.25rem; display:flex; justify-content:space-between; align-items:center;">' +
                            '<span><i class="ph ph-chats-circle"></i> PRIVATE DISCUSSIONS</span>' +
                            '<button type="button" class="gm-btn gm-btn-primary gm-btn-xs" id="btn-new-discussion" style="padding:2px 8px; font-size:0.75rem;">' +
                                '<i class="ph ph-plus"></i> New' +
                            '</button>' +
                        '</div>' +
                        '<div class="gm-hall-filters" style="margin-bottom:0.5rem;">' +
                            '<button type="button" class="gm-hall-filter-pill active" data-filter="all">All</button>' +
                            '<button type="button" class="gm-hall-filter-pill" data-filter="direct">1:1</button>' +
                            '<button type="button" class="gm-hall-filter-pill" data-filter="group">Groups</button>' +
                            '<button type="button" class="gm-hall-filter-pill" data-filter="r5">👑 R5</button>' +
                        '</div>' +
                        '<div class="gm-leader-conv-list" id="leader-hall-conv-list">' +
                            '<div class="gm-empty" style="padding:2rem 1rem;">' +
                                '<i class="ph-duotone ph-circle-notch ph-spin gm-icon"></i>' +
                                '<div class="gm-empty-title">Loading discussions...</div>' +
                            '</div>' +
                        '</div>' +
                    '</aside>' +
                    '<section class="gm-leader-hall-main">' +
                        '<div class="gm-chat-header" id="leader-hall-chat-header">' +
                            '<div class="gm-chat-header-left">' +
                                '<h2 class="gm-chat-title">Select a conversation</h2>' +
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
                        '<div class="gm-chat-input-bar">' +
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

    function renderConversationList() {
        var listContainer = document.getElementById('leader-hall-conv-list');
        var globalBox = document.getElementById('btn-select-global-lounge');
        if (globalBox) {
            if (currentConversation && currentConversation.id === GLOBAL_CONV_ID) {
                globalBox.classList.add('active');
            } else {
                globalBox.classList.remove('active');
            }
        }

        if (!listContainer) return;

        var filtered = conversationsList.filter(function (c) {
            if (c.id === GLOBAL_CONV_ID) return false;
            if (activeFilter === 'direct') return c.type === 'direct';
            if (activeFilter === 'group') return c.type === 'group';
            if (activeFilter === 'r5') return c.isR5Only;
            return true;
        });

        if (filtered.length === 0) {
            listContainer.innerHTML =
                '<div class="gm-empty" style="padding:1.5rem 0.5rem; text-align:center;">' +
                    '<i class="ph ph-chat-circle-dots" style="color:var(--text-muted); font-size:1.5rem;"></i>' +
                    '<div style="color:var(--text-muted); font-size:0.8rem; margin-top:0.35rem;">No private discussions yet</div>' +
                    '<p style="color:var(--text-muted); font-size:0.75rem; margin:0.25rem 0 0.5rem;">Click <strong>+ New</strong> to start a 1:1 or Group discussion.</p>' +
                '</div>';
            return;
        }

        var acc = getAccount();
        var accId = acc ? (acc.id || acc.account_id) : '';

        var html = filtered.map(function (c) {
            var isSelected = currentConversation && currentConversation.id === c.id;
            var title = c.title;
            var badgeRole = c.isR5Only ? '<span class="gm-chip" style="font-size:0.65rem; background:rgba(234,179,8,0.18); color:#facc15; border:1px solid rgba(234,179,8,0.3); font-weight:700;">R5 ONLY</span>' : '';
            var typeIcon = c.type === 'direct' ? 'ph ph-user' : 'ph ph-users-three';

            if (c.type === 'direct') {
                var other = (c.members || []).find(function (m) { return m.account_id !== accId; });
                title = other ? (other.account_id + ' [' + (other.guild || 'FGF') + ']') : 'Direct Chat';
            }

            return '<div class="gm-leader-conv-item ' + (isSelected ? 'active' : '') + '" data-conv-id="' + esc(c.id) + '">' +
                '<div class="gm-conv-avatar"><i class="' + typeIcon + '"></i></div>' +
                '<div class="gm-conv-info">' +
                    '<div class="gm-conv-title-row">' +
                        '<span class="gm-conv-title">' + esc(title) + '</span>' +
                        badgeRole +
                    '</div>' +
                    '<div class="gm-conv-sub">' +
                        '<span>' + (c.type === 'direct' ? '1:1 E2EE' : (c.members.length + ' members')) + '</span>' +
                    '</div>' +
                '</div>' +
            '</div>';
        }).join('');

        listContainer.innerHTML = html;

        listContainer.querySelectorAll('.gm-leader-conv-item').forEach(function (el) {
            el.addEventListener('click', function () {
                var id = el.getAttribute('data-conv-id');
                selectConversation(id);
            });
        });
    }

    async function selectConversation(id) {
        if (id === GLOBAL_CONV_ID) {
            currentConversation = GLOBAL_LOUNGE_CONV;
        } else {
            var conv = conversationsList.find(function (c) { return c.id === id; });
            if (!conv) return;
            currentConversation = conv;
        }

        renderConversationList();
        renderActiveConversationHeader();
        await loadAndRenderMessages();
        subscribeToRealtime(currentConversation.id);
    }

    function renderActiveConversationHeader() {
        var header = document.getElementById('leader-hall-chat-header');
        if (!header || !currentConversation) return;

        var acc = getAccount();
        var accId = acc ? (acc.id || acc.account_id) : '';
        var title = currentConversation.title;
        var subtitle = '';

        if (currentConversation.id === GLOBAL_CONV_ID) {
            title = '🌐 Global Leaders Lounge';
            subtitle = 'Universal Channel • Open to all Guild Masters (R5) and Officers (R4)';
        } else if (currentConversation.type === 'direct') {
            var other = (currentConversation.members || []).find(function (m) { return m.account_id !== accId; });
            var targetId = other ? other.account_id : 'Leader';
            var targetGuild = other ? other.guild : 'FGF';
            title = targetId + ' [' + targetGuild + ']';
            subtitle = 'Direct 1:1 Signal Protocol Session';
        } else {
            subtitle = currentConversation.members.length + ' Leaders • ' + (currentConversation.isR5Only ? '👑 R5 Summit' : 'Tactical Group');
        }

        header.innerHTML =
            '<div class="gm-chat-header-left">' +
                '<h2 class="gm-chat-title">' + esc(title) + '</h2>' +
                '<div class="gm-chat-e2ee-tag">' +
                    '<i class="ph ph-lock-key"></i>' +
                    '<span>' + esc(subtitle) + '</span>' +
                '</div>' +
            '</div>' +
            '<div class="gm-chat-header-actions">' +
                (currentConversation.type === 'direct' ?
                    '<button class="gm-btn gm-btn-outline gm-btn-sm" id="btn-safety-numbers"><i class="ph ph-fingerprint"></i> Safety Fingerprint</button>' : '') +
            '</div>';

        var btnSafety = document.getElementById('btn-safety-numbers');
        if (btnSafety) {
            btnSafety.addEventListener('click', showSafetyNumbersModal);
        }
    }

    async function loadAndRenderMessages() {
        var container = document.getElementById('leader-hall-messages');
        if (!container || !currentConversation) return;

        var db = getDb();
        if (!db) return;

        container.innerHTML = '<div class="gm-empty" style="padding:3rem 1rem;"><i class="ph-duotone ph-circle-notch ph-spin gm-icon"></i><div class="gm-empty-title">Decrypting messages...</div></div>';

        try {
            var res = await db
                .from('e2ee_messages')
                .select('*')
                .eq('conversation_id', currentConversation.id)
                .order('created_at', { ascending: true });

            var messages = res.data || [];
            if (messages.length === 0) {
                container.innerHTML =
                    '<div class="gm-empty" style="padding:3rem 1rem;">' +
                        '<i class="ph ph-shield-check gm-icon" style="color:var(--primary, #38bdf8); font-size:2rem;"></i>' +
                        '<div class="gm-empty-title" style="margin-top:0.5rem;">' + (currentConversation.id === GLOBAL_CONV_ID ? 'Welcome to the Global Leaders Lounge' : 'End-to-End Encrypted Session Established') + '</div>' +
                        '<p style="color:var(--text-muted); font-size:0.85rem; max-width:400px; margin:0.5rem auto;">' +
                            (currentConversation.id === GLOBAL_CONV_ID ? 'Connect, coordinate diplomacy, and discuss galaxy tactics with leaders across all guilds and servers.' : 'Messages in this private discussion are protected by the Signal Protocol.') +
                        '</p>' +
                    '</div>';
                return;
            }

            var html = '';
            var acc = getAccount();
            var accId = acc ? (acc.id || acc.account_id) : '';

            for (var i = 0; i < messages.length; i++) {
                var m = messages[i];
                var isMe = m.sender_account_id === accId;
                var text = await decryptMessage(m);
                var timeStr = m.created_at ? new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
                var guildTag = m.sender_guild ? '[' + m.sender_guild + ']' : '';
                var roleTag = m.sender_role || 'R4';

                html +=
                    '<div class="gm-message-row ' + (isMe ? 'me' : 'other') + '">' +
                        '<div class="gm-message-bubble">' +
                            (!isMe ? '<div class="gm-message-sender"><span class="gm-sender-guild">' + esc(guildTag) + '</span> ' + esc(m.sender_account_id) + ' <span class="gm-sender-role">(' + esc(roleTag) + ')</span></div>' : '') +
                            '<div class="gm-message-body">' + esc(text) + '</div>' +
                            '<div class="gm-message-meta">' +
                                '<span>' + esc(timeStr) + '</span>' +
                                '<i class="ph ph-lock-key" style="font-size:0.75rem; margin-left:4px;" title="Signal E2EE Encrypted"></i>' +
                            '</div>' +
                        '</div>' +
                    '</div>';
            }

            container.innerHTML = html;
            container.scrollTop = container.scrollHeight;
        } catch (e) {
            console.error('Error loading messages', e);
            container.innerHTML = '<div class="gm-empty"><i class="ph ph-warning-circle gm-icon"></i><div class="gm-empty-title">Error loading messages</div></div>';
        }
    }

    function renderMessages() {
        loadAndRenderMessages();
    }

    function subscribeToRealtime(convId) {
        var db = getDb();
        if (!db) return;
        if (realtimeChannel) {
            db.removeChannel(realtimeChannel);
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
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 6. MODALS: CREATE DISCUSSION & SAFETY NUMBERS
    // ─────────────────────────────────────────────────────────────────────────

    function showCreateModal() {
        var modal = document.getElementById('modal-leader-create');
        if (!modal) return;

        var acc = getAccount();
        var accId = acc ? (acc.id || acc.account_id) : '';
        var isCallerR5 = isR5();

        var otherLeaders = activeAccounts.filter(function (a) {
            return a.id !== accId;
        });

        var directLeadersHtml = otherLeaders.map(function (a) {
            return '<div class="gm-direct-leader-row" data-account-id="' + esc(a.id) + '">' +
                '<div style="display:flex; align-items:center; gap:0.5rem;">' +
                    '<span class="gm-chip" style="font-weight:700;">[' + esc(a.guild || 'FGF') + ']</span>' +
                    '<span style="font-weight:600; color:var(--text-main);">' + esc(a.id) + '</span>' +
                    '<span style="font-size:0.75rem; color:var(--text-muted);">(' + esc(a.role) + ')</span>' +
                '</div>' +
                '<button type="button" class="gm-btn gm-btn-primary gm-btn-xs btn-start-direct-chat" data-account-id="' + esc(a.id) + '">' +
                    '<i class="ph ph-chat-circle"></i> Chat' +
                '</button>' +
            '</div>';
        }).join('');

        var groupLeadersHtml = otherLeaders.map(function (a) {
            return '<label class="gm-leader-picker-item" style="display:flex; align-items:center; gap:0.5rem; padding:0.35rem 0.5rem; border-radius:var(--radius-sm); cursor:pointer;">' +
                '<input type="checkbox" name="leader_member" value="' + esc(a.id) + '" data-role="' + esc(a.role) + '">' +
                '<span class="gm-picker-guild">[' + esc(a.guild || 'FGF') + ']</span>' +
                '<span class="gm-picker-name" style="font-weight:600;">' + esc(a.id) + '</span>' +
                '<span class="gm-picker-role" style="font-size:0.75rem; color:var(--text-muted);">(' + esc(a.role) + ')</span>' +
            '</label>';
        }).join('');

        var body = document.getElementById('modal-leader-create-body');
        if (body) {
            body.innerHTML =
                '<div class="gm-segmented-control" style="display:flex; gap:0.5rem; margin-bottom:1rem;">' +
                    '<button type="button" class="gm-seg-btn active gm-btn gm-btn-sm gm-btn-primary" data-type="direct" style="flex:1; justify-content:center;">' +
                        '<i class="ph ph-user"></i> 1:1 Direct Chat' +
                    '</button>' +
                    '<button type="button" class="gm-seg-btn gm-btn gm-btn-sm gm-btn-ghost" data-type="group" style="flex:1; justify-content:center;">' +
                        '<i class="ph ph-users-three"></i> Group Discussion' +
                    '</button>' +
                '</div>' +
                '<div id="panel-create-direct">' +
                    '<div style="margin-bottom:0.5rem;">' +
                        '<input type="text" id="filter-direct-leaders" class="gm-input" placeholder="🔍 Search leader by name, guild..." style="width:100%;">' +
                    '</div>' +
                    '<div class="gm-direct-leader-list" id="direct-leader-list-container" style="max-height:240px; overflow-y:auto; border:1px solid var(--border-soft); border-radius:var(--radius-md); padding:0.25rem;">' +
                        (directLeadersHtml || '<div class="gm-empty" style="padding:1.5rem;">No other leaders found</div>') +
                    '</div>' +
                '</div>' +
                '<div id="panel-create-group" class="hidden">' +
                    '<div class="gm-login-field" style="margin-bottom:0.75rem;">' +
                        '<label style="display:block; margin-bottom:0.25rem; font-size:0.85rem; color:var(--text-muted);">Group Title</label>' +
                        '<input type="text" id="input-group-title" class="gm-input" placeholder="e.g. SvS Northern Sector Coalition" style="width:100%;">' +
                    '</div>' +
                    '<div class="gm-login-field" style="margin-bottom:0.75rem;">' +
                        '<label class="gm-checkbox-label" style="display:flex; align-items:center; gap:0.5rem; cursor:pointer;">' +
                            '<input type="checkbox" id="check-r5-only" ' + (!isCallerR5 ? 'disabled' : '') + '> ' +
                            '<span>👑 R5-Only Summit (Guild Masters only)</span>' +
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

            // 1-Click Direct Chat triggers
            body.querySelectorAll('.btn-start-direct-chat').forEach(function (btn) {
                btn.addEventListener('click', function () {
                    var targetId = btn.getAttribute('data-account-id');
                    if (targetId) startDirectChatWith(targetId);
                });
            });

            // Filter for 1:1 search
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
            if (submitBtn) submitBtn.classList.add('hidden'); // hidden by default for 1:1 direct mode
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
            renderConversationList();
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
                p_title: title || 'Group Discussion',
                p_is_r5_only: isR5Only,
                p_member_account_ids: checkedMembers
            });

            if (res.error) throw res.error;
            var newId = res.data;
            document.getElementById('modal-leader-create').classList.add('hidden');
            await fetchConversations();
            renderConversationList();
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
        await fetchEligibleLeaders();
        await fetchConversations();

        // Default to Global Leaders Lounge on first load
        if (!currentConversation) {
            selectConversation(GLOBAL_CONV_ID);
        } else {
            renderConversationList();
            renderActiveConversationHeader();
        }

        // Setup Global Lounge button click
        var globalBox = document.getElementById('btn-select-global-lounge');
        if (globalBox) {
            globalBox.onclick = function () {
                selectConversation(GLOBAL_CONV_ID);
            };
        }

        // Setup filter pills
        document.querySelectorAll('.gm-hall-filter-pill').forEach(function (pill) {
            pill.onclick = function () {
                document.querySelectorAll('.gm-hall-filter-pill').forEach(function (p) { p.classList.remove('active'); });
                pill.classList.add('active');
                activeFilter = pill.getAttribute('data-filter') || 'all';
                renderConversationList();
            };
        });

        // Setup Send message button & input
        var sendBtn = document.getElementById('leader-hall-send-btn');
        var input = document.getElementById('leader-hall-msg-input');
        if (sendBtn && input) {
            sendBtn.onclick = function () {
                sendMessage(input.value);
                input.value = '';
            };
            input.onkeydown = function (e) {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage(input.value);
                    input.value = '';
                }
            };
        }

        // Setup New Discussion Button
        var btnNew = document.getElementById('btn-new-discussion');
        if (btnNew) {
            btnNew.onclick = showCreateModal;
        }

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
    }

    return {
        load: load,
        initSignalIdentity: initSignalIdentity,
        fetchConversations: fetchConversations,
        sendMessage: sendMessage,
        decryptMessage: decryptMessage
    };
});
