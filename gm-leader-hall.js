/**
 * gm-leader-hall.js — Guild Leader Hall (Accordions, Global Channels, 1:1, Groups & R5 Summit)
 * FGF Guild Management Tool — 2026 Zero-Trust Architecture
 *
 * Implements:
 * 1. 4 Collapsible Spaces (Global Lounge, 1:1 Direct, Group Discussions, R5 Summit)
 * 2. Discussion Actions (Delete, Leave Group, Block/Unblock Leader)
 * 3. 1:1 Double Ratchet E2EE Sessions with X3DH handshake
 * 4. Group Discussions with Signal Sender Keys & forward secrecy
 * 5. Realtime messaging subscription & Presence engine
 * 6. Safety Numbers verification modal (60-digit fingerprint)
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.GM_LEADER_HALL = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var esc = (window.GM && window.GM.escapeHTML) ? window.GM.escapeHTML : function (s) { return s || ''; };
    var t = (window.GM && window.GM.t) ? window.GM.t : function (k) { return k; };

    var GLOBAL_CHANNELS = [
        { id: '00000000-0000-0000-0000-000000000001', type: 'global', title: 'Global Lounge', subtitle: 'General lounge for all guild leaders', icon: 'ph ph-chat-circle-dots' },
        { id: '00000000-0000-0000-0000-000000000002', type: 'global', title: 'Diplomacy & Treaties', subtitle: 'Inter-guild N.A.P. & strategic pacts', icon: 'ph ph-scroll' },
        { id: '00000000-0000-0000-0000-000000000003', type: 'global', title: 'SvS War Council', subtitle: 'Cross-server tactics & battle plans', icon: 'ph ph-swords' }
    ];

    var currentConversation = null;
    var conversationsList = [];
    var blockedAccountIds = new Set();
    var realtimeChannel = null;
    var localIdentity = null;
    var activeAccounts = [];
    var decryptedCache = {}; // messageId -> plaintext

    // Accordion state
    var accordionState = {
        global: true,
        direct: true,
        group: true,
        r5: true
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
            return list;
        } catch (err) {
            console.error('Error fetching E2EE conversations', err);
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

        // Filter out blocked leaders
        if (blockedAccountIds.has(msg.sender_account_id)) {
            return '[🚫 Message hidden from blocked leader]';
        }

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
                                    '<span class="gm-hall-acc-badge">3</span>' +
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

        // Update counts
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
                    var title = other ? (other.account_id + ' [' + (other.guild || 'FGF') + ']') : 'Direct Chat';
                    var roleTag = other ? other.role : 'R4';
                    var isBlocked = other && blockedAccountIds.has(other.account_id);

                    return '<div class="gm-hall-channel-item ' + (isSelected ? 'active' : '') + '" data-conv-id="' + esc(c.id) + '">' +
                        '<div class="gm-channel-icon"><i class="ph ph-user"></i></div>' +
                        '<div class="gm-channel-info">' +
                            '<div class="gm-channel-title">' + esc(title) + (isBlocked ? ' <span class="gm-badge-blocked">BLOCKED</span>' : '') + '</div>' +
                            '<div class="gm-channel-sub">' + esc(roleTag) + ' • E2EE Direct</div>' +
                        '</div>' +
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
                    return '<div class="gm-hall-channel-item ' + (isSelected ? 'active' : '') + '" data-conv-id="' + esc(c.id) + '">' +
                        '<div class="gm-channel-icon"><i class="ph ph-users-three"></i></div>' +
                        '<div class="gm-channel-info">' +
                            '<div class="gm-channel-title">' + esc(c.title) + '</div>' +
                            '<div class="gm-channel-sub">' + (c.members || []).length + ' Leaders • Coalition</div>' +
                        '</div>' +
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
                    return '<div class="gm-hall-channel-item ' + (isSelected ? 'active' : '') + '" data-conv-id="' + esc(c.id) + '">' +
                        '<div class="gm-channel-icon" style="color:#facc15;"><i class="ph ph-crown"></i></div>' +
                        '<div class="gm-channel-info">' +
                            '<div class="gm-channel-title">' + esc(c.title) + ' <span class="gm-chip-r5">R5 ONLY</span></div>' +
                            '<div class="gm-channel-sub">' + (c.members || []).length + ' Guild Masters</div>' +
                        '</div>' +
                    '</div>';
                }).join('');
            }
        }

        // Bind clicks on channel items
        document.querySelectorAll('.gm-hall-channel-item').forEach(function (el) {
            el.onclick = function () {
                var id = el.getAttribute('data-conv-id');
                selectConversation(id);
            };
        });

        // Bind quick action buttons
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
        }

        renderAccordions();
        renderActiveConversationHeader();
        await loadAndRenderMessages();
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

        if (currentConversation.type === 'global') {
            title = '🌐 ' + currentConversation.title;
            subtitle = currentConversation.subtitle || 'Universal Channel • Open to all Guild Leaders';
        } else if (currentConversation.type === 'direct') {
            var other = (currentConversation.members || []).find(function (m) { return m.account_id !== accId; });
            var targetId = other ? other.account_id : 'Leader';
            var targetGuild = other ? other.guild : 'FGF';
            title = targetId + ' [' + targetGuild + ']';
            subtitle = 'Direct 1:1 Signal Protocol Session';

            var isBlocked = other && blockedAccountIds.has(other.account_id);
            actionsHtml =
                '<button class="gm-btn gm-btn-outline gm-btn-xs" id="btn-safety-numbers" title="View Safety Fingerprint"><i class="ph ph-fingerprint"></i> Safety Code</button>' +
                '<button class="gm-btn gm-btn-outline gm-btn-xs" id="btn-toggle-block" style="' + (isBlocked ? 'color:#f87171; border-color:#f87171;' : '') + '">' +
                    '<i class="ph ph-prohibit"></i> ' + (isBlocked ? 'Unblock Leader' : 'Block Leader') +
                '</button>' +
                '<button class="gm-btn gm-btn-outline gm-btn-xs" id="btn-delete-conv" style="color:var(--danger);" title="Delete Conversation"><i class="ph ph-trash"></i> Delete</button>';
        } else {
            // Group or R5 Summit
            subtitle = (currentConversation.members || []).length + ' Leaders • ' + (currentConversation.isR5Only ? '👑 R5 Summit' : 'Tactical Group');
            var isCreator = currentConversation.createdBy === accId;

            actionsHtml =
                '<button class="gm-btn gm-btn-outline gm-btn-xs" id="btn-leave-group" title="Leave Group"><i class="ph ph-sign-out"></i> Leave Group</button>' +
                (isCreator || isSuper ? '<button class="gm-btn gm-btn-outline gm-btn-xs" id="btn-delete-conv" style="color:var(--danger);" title="Delete Group"><i class="ph ph-trash"></i> Delete Group</button>' : '');
        }

        header.innerHTML =
            '<div class="gm-chat-header-left">' +
                '<h2 class="gm-chat-title">' + esc(title) + '</h2>' +
                '<div class="gm-chat-e2ee-tag">' +
                    '<i class="ph ph-lock-key"></i>' +
                    '<span>' + esc(subtitle) + '</span>' +
                '</div>' +
            '</div>' +
            '<div class="gm-chat-header-actions" style="display:flex; align-items:center; gap:0.4rem;">' +
                actionsHtml +
            '</div>';

        // Bind header actions
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

        // Default to Global Lounge on first load
        if (!currentConversation) {
            selectConversation(GLOBAL_CHANNELS[0].id);
        } else {
            renderAccordions();
            renderActiveConversationHeader();
        }

        // Setup Accordion toggles
        document.querySelectorAll('.gm-hall-acc-header').forEach(function (header) {
            header.onclick = function (e) {
                // If clicked on add button, prevent accordion toggle
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

        // Setup Accordion Add Buttons
        var btnAddDirect = document.getElementById('btn-add-direct');
        if (btnAddDirect) btnAddDirect.onclick = function (e) { e.stopPropagation(); showCreateModal('direct'); };
        var btnAddGroup = document.getElementById('btn-add-group');
        if (btnAddGroup) btnAddGroup.onclick = function (e) { e.stopPropagation(); showCreateModal('group'); };
        var btnAddR5 = document.getElementById('btn-add-r5');
        if (btnAddR5) btnAddR5.onclick = function (e) { e.stopPropagation(); showCreateModal('r5'); };

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
