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

    var accordionState = {
        global: true,
        direct: true,
        group: true,
        r5: true
    };

    var esc = (window.GM && window.GM.escapeHTML) ? window.GM.escapeHTML : function (s) { return s || ''; };
    var t = (window.GM && window.GM.t) ? window.GM.t : function (k) { return k; };

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
                p_one_time_prekeys: otks
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
            return list;
        } catch (err) {
            console.error('Error fetching E2EE conversations', err);
            return [];
        }
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

            var gRes = await db.from('guilds').select('id, name, server_number').order('id', { ascending: true });
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

        try {
            var encrypted = null;
            var usedDoubleRatchet = false;

            if (currentConversation.type === 'direct') {
                var otherMember = (currentConversation.members || []).find(function (m) { return m.account_id !== accId; });
                var targetId = otherMember ? otherMember.account_id : accId;
                var session = await getOrEstablish1to1Session(targetId);
                if (session) {
                    try {
                        encrypted = await S.doubleRatchetEncrypt(session, cleanText);
                        await saveSession(accId + ':' + targetId, session);
                        usedDoubleRatchet = true;
                    } catch (e) {
                        usedDoubleRatchet = false;
                    }
                }
            }

            if (!usedDoubleRatchet) {
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
                iv: encrypted.iv
            }).select();

            if (insertRes.data && insertRes.data[0]) {
                setCachedDecrypted(insertRes.data[0].id, cleanText);
            }

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
                    '<div class="gm-sign-status signed"><i class="ph ph-check-circle"></i> Signed by <strong>' + esc(tr.guild_a_signed_by) + '</strong> (' + esc(tr.guild_a) + ')</div>' :
                    '<div class="gm-sign-status pending"><i class="ph ph-clock"></i> Awaiting ' + esc(tr.guild_a) + ' signature</div>';

                // Signature status for Guild B
                var bSigned = tr.guild_b_signed_by ?
                    '<div class="gm-sign-status signed"><i class="ph ph-check-circle"></i> Signed by <strong>' + esc(tr.guild_b_signed_by) + '</strong> (' + esc(tr.guild_b) + ')</div>' :
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
                                '<div class="gm-party-name">👑 Guild A: [' + esc(tr.guild_a) + '] (S' + esc(tr.guild_a_server) + ')</div>' +
                                aSigned +
                            '</div>' +
                            '<div class="gm-party-divider"><i class="ph ph-handshake"></i></div>' +
                            '<div class="gm-party-box">' +
                                '<div class="gm-party-name">🛡️ Guild B: [' + esc(tr.guild_b) + '] (S' + esc(tr.guild_b_server) + ')</div>' +
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
            return '<option value="' + esc(g.id) + '" data-server="' + esc(g.server_number || callerServer) + '">' + esc(g.name || g.id) + ' [' + esc(g.id) + '] (S' + esc(g.server_number || callerServer) + ')</option>';
        }).join('');

        var body = document.getElementById('modal-treaty-create-body');
        if (body) {
            body.innerHTML =
                '<div class="gm-login-field">' +
                    '<label style="display:block; margin-bottom:0.25rem; font-size:0.85rem; color:var(--text-muted);">Signatory Parties</label>' +
                    '<div style="display:grid; grid-template-columns:1fr 1fr; gap:0.75rem;">' +
                        '<div style="background:rgba(255,255,255,0.04); padding:0.65rem; border-radius:var(--radius-sm); border:1px solid var(--border-soft);">' +
                            '<div style="font-size:0.75rem; color:var(--text-muted);">Proposing Party (Party A)</div>' +
                            '<div style="font-weight:700; color:var(--text-main); font-size:0.95rem; margin-top:2px;">[' + esc(callerGuild) + '] (S' + esc(callerServer) + ')</div>' +
                        '</div>' +
                        '<div>' +
                            '<div style="font-size:0.75rem; color:var(--text-muted); margin-bottom:2px;">Target Guild (Party B)</div>' +
                            '<select id="input-treaty-guild-b" class="gm-input" style="width:100%;">' +
                                (guildOptions || '<option value="OMEGA">OMEGA [OMEGA] (S1058)</option>') +
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

        header.innerHTML =
            '<div class="gm-chat-header-left">' +
                titleHtml +
                '<div style="display:flex; align-items:center; gap:0.4rem; flex-wrap:wrap; margin-top:2px;">' +
                    '<div class="gm-chat-e2ee-tag">' +
                        '<i class="ph ph-lock-key"></i>' +
                        '<span>' + esc(subtitle) + '</span>' +
                    '</div>' +
                    shieldBadge +
                '</div>' +
            '</div>' +
            '<div class="gm-chat-header-actions" style="display:flex; align-items:center; gap:0.4rem;">' +
                actionsHtml +
            '</div>';

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
            return '<option value="' + esc(a.id) + '">' + esc(a.id) + ' [' + esc(a.guild || 'FGF') + '] (' + esc(a.role) + ')</option>';
        }).join('');

        var membersListHtml = members.map(function (m) {
            var isThisCreator = currentConversation.createdBy === m.account_id;
            var canRemove = (isCreator || isSuper) && !isThisCreator;
            var isSelf = (m.account_id === accId);

            var badgeRole = isThisCreator ?
                '<span class="gm-chip" style="background:rgba(234,179,8,0.15); color:#facc15; font-size:0.72rem; padding:1px 6px;">👑 Creator</span>' :
                '<span class="gm-chip" style="font-size:0.72rem; padding:1px 6px;">Member</span>';

            return '<div class="gm-direct-leader-row" style="padding:0.45rem 0.5rem; background:rgba(255,255,255,0.02); margin-bottom:4px; border-radius:var(--radius-sm);">' +
                '<div style="display:flex; align-items:center; gap:0.5rem;">' +
                    '<span class="gm-picker-guild">[' + esc(m.guild || 'FGF') + ']</span>' +
                    '<span style="font-weight:700; color:var(--text-main);">' + esc(m.account_id) + '</span>' +
                    '<span style="font-size:0.75rem; color:var(--text-muted);">(' + esc(m.role || 'Leader') + ')</span>' +
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
                var callerServer = acc ? (acc.server_number ? 'S' + acc.server_number : 'S1058') : 'S1058';
                var watermarkText = '[' + esc(callerGuild) + '] ' + esc(accId) + ' • ' + esc(callerServer) + ' • CONFIDENTIAL';
                watermarkHtml = '<div class="gm-watermark-overlay" aria-hidden="true">';
                for (var w = 0; w < 16; w++) {
                    watermarkHtml += '<div class="gm-watermark-item">' + watermarkText + '</div>';
                }
                watermarkHtml += '</div>';
            }

            for (var i = 0; i < messages.length; i++) {
                var m = messages[i];
                var isMe = m.sender_account_id === accId;
                var text = await decryptMessage(m);
                var timeStr = m.created_at ? new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '';
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

            container.innerHTML = watermarkHtml + html;
            container.scrollTop = container.scrollHeight;
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

        if (!currentConversation) {
            selectConversation(GLOBAL_CHANNELS[0].id);
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
        if (blackoutTimeout) clearTimeout(blackoutTimeout);
        blackoutTimeout = setTimeout(function () {
            overlay.classList.add('hidden');
        }, durationMs || 2800);

        showSecurityNotification();
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
                overlay.classList.add('hidden');
                if (blackoutTimeout) clearTimeout(blackoutTimeout);
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

        // Window Blur & Visibility change (triggers blackout when external screenshot tool steals OS focus)
        function handleVisibility() {
            var activeTab = document.querySelector('.tab-panel.active');
            var isLeaderHall = activeTab && activeTab.id === 'tab-leader-hall';
            if (isLeaderHall && isProtectedConversation()) {
                if (document.hidden || !document.hasFocus()) {
                    triggerBlackoutScreen(3000);
                }
            }
        }

        window.addEventListener('blur', handleVisibility, true);
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

            // Universal detection: PrintScreen, Mac Cmd+Shift+3/4/5/6, Win+Shift+S, Win+Alt+R, Ctrl+P, Alt+PrtScn
            var isPrtScn = e.key === 'PrintScreen' || e.code === 'PrintScreen' || e.keyCode === 44 || e.which === 44;
            var isPrintPdf = (e.metaKey || e.ctrlKey) && (e.key === 'p' || e.key === 'P' || e.code === 'KeyP');
            var isMacScreenshot = (e.metaKey || e.ctrlKey) && e.shiftKey && (
                e.code === 'Digit3' || e.code === 'Digit4' || e.code === 'Digit5' || e.code === 'Digit6' ||
                e.key === '3' || e.key === '4' || e.key === '5' || e.key === '6' ||
                e.key === '#' || e.key === '$' || e.key === '%' || e.key === '&' || e.key === '"' || e.key === "'"
            );
            var isWinSnipping = (e.metaKey || e.ctrlKey) && e.shiftKey && (e.code === 'KeyS' || e.key === 's' || e.key === 'S');
            var isWinGameBar = (e.metaKey || e.ctrlKey) && e.altKey && (e.code === 'KeyR' || e.key === 'r' || e.key === 'R');

            if (isPrtScn || isPrintPdf || isMacScreenshot || isWinSnipping || isWinGameBar) {
                e.preventDefault();
                e.stopPropagation();
                triggerBlackoutScreen(3200);
            }

            // Block copy shortcut inside messages
            if ((e.metaKey || e.ctrlKey) && (e.key === 'c' || e.key === 'C' || e.code === 'KeyC')) {
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
        decryptMessage: decryptMessage
    };
});
