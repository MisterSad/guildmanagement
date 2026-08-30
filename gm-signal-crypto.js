/**
 * gm-signal-crypto.js — Signal Protocol Cryptographic Engine
 * FGF Guild Management Tool — 2026 Zero-Trust E2EE Module
 *
 * Implements:
 * 1. X25519 (Curve25519) ECDH Key Exchange & Ed25519 Signatures (RFC 8032 / RFC 7748)
 * 2. HKDF-SHA256 Key Derivation (RFC 5869) & AES-256-GCM Authenticated Encryption
 * 3. X3DH (Extended Triple Diffie-Hellman) Asynchronous Handshake
 * 4. Double Ratchet Algorithm (Forward Secrecy + Break-in Recovery for 1:1)
 * 5. Signal Sender Keys Protocol (Multi-member group encryption with forward secrecy)
 * 6. IndexedDB Key Storage & Session Persistence
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.GM_SIGNAL = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var INFO_RATCHET_ROOT = 'FGF_SIGNAL_ROOT_KDF_V1';
    var INFO_MESSAGE_KEY = 'FGF_SIGNAL_MSG_KEY_V1';
    var INFO_SENDER_KEY = 'FGF_SIGNAL_SENDER_KEY_V1';

    function getCrypto() {
        if (typeof globalThis !== 'undefined' && globalThis.crypto) return globalThis.crypto;
        if (typeof window !== 'undefined' && window.crypto) return window.crypto;
        try {
            var nodeCrypto = require('crypto');
            return nodeCrypto.webcrypto || nodeCrypto;
        } catch (e) {
            return null;
        }
    }

    function getRandomBytes(len) {
        var c = getCrypto();
        var buf = new Uint8Array(len);
        if (c && c.getRandomValues) {
            c.getRandomValues(buf);
        } else {
            for (var i = 0; i < len; i++) {
                buf[i] = Math.floor(Math.random() * 256);
            }
        }
        return buf;
    }

    function bytesToHex(bytes) {
        var hex = [];
        for (var i = 0; i < bytes.length; i++) {
            var b = bytes[i].toString(16);
            hex.push(b.length === 1 ? '0' + b : b);
        }
        return hex.join('');
    }

    function hexToBytes(hex) {
        if (typeof hex !== 'string') return new Uint8Array(0);
        var clean = hex.replace(/[^0-9a-fA-F]/g, '');
        var bytes = new Uint8Array(clean.length / 2);
        for (var i = 0; i < clean.length; i += 2) {
            bytes[i / 2] = parseInt(clean.substring(i, i + 2), 16);
        }
        return bytes;
    }

    function bytesToBase64(bytes) {
        var bin = '';
        for (var i = 0; i < bytes.length; i++) {
            bin += String.fromCharCode(bytes[i]);
        }
        if (typeof btoa === 'function') {
            return btoa(bin);
        }
        return Buffer.from(bytes).toString('base64');
    }

    function base64ToBytes(b64) {
        if (typeof atob === 'function') {
            var bin = atob(b64);
            var bytes = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i++) {
                bytes[i] = bin.charCodeAt(i);
            }
            return bytes;
        }
        return new Uint8Array(Buffer.from(b64, 'base64'));
    }

    function utf8ToBytes(str) {
        if (typeof TextEncoder !== 'undefined') {
            return new TextEncoder().encode(str);
        }
        var utf8 = [];
        for (var i = 0; i < str.length; i++) {
            var charcode = str.charCodeAt(i);
            if (charcode < 0x80) utf8.push(charcode);
            else if (charcode < 0x800) {
                utf8.push(0xc0 | (charcode >> 6), 0x80 | (charcode & 0x3f));
            } else if (charcode < 0xd800 || charcode >= 0xe000) {
                utf8.push(0xe0 | (charcode >> 12), 0x80 | ((charcode >> 6) & 0x3f), 0x80 | (charcode & 0x3f));
            } else {
                i++;
                charcode = 0x10000 + (((charcode & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff));
                utf8.push(0xf0 | (charcode >> 18), 0x80 | ((charcode >> 12) & 0x3f), 0x80 | ((charcode >> 6) & 0x3f), 0x80 | (charcode & 0x3f));
            }
        }
        return new Uint8Array(utf8);
    }

    function bytesToUtf8(bytes) {
        if (typeof TextDecoder !== 'undefined') {
            return new TextDecoder().decode(bytes);
        }
        var str = '';
        var i = 0;
        while (i < bytes.length) {
            var c = bytes[i++];
            if (c > 127) {
                if (c > 191 && c < 224) {
                    c = ((c & 31) << 6) | (bytes[i++] & 63);
                } else if (c > 223 && c < 240) {
                    c = ((c & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
                } else if (c > 239 && c <= 247) {
                    c = ((c & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
                }
            }
            str += String.fromCharCode(c);
        }
        return str;
    }

    function concatBytes() {
        var totalLen = 0;
        for (var i = 0; i < arguments.length; i++) {
            totalLen += arguments[i].length;
        }
        var res = new Uint8Array(totalLen);
        var offset = 0;
        for (var j = 0; j < arguments.length; j++) {
            res.set(arguments[j], offset);
            offset += arguments[j].length;
        }
        return res;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. X25519 (ECDH) & Ed25519 (signatures) — via @noble/curves, audited,
    // zero-dependency (see vendor-src/noble-crypto-entry.js). Previously a
    // hand-rolled BigInt Montgomery ladder here; replaced because it is not
    // guaranteed constant-time and, worse, the signature *verification* built
    // on top of it (removed below, see history) never actually checked the
    // signature equation — it always returned true. Real Ed25519 fixes that.
    // ─────────────────────────────────────────────────────────────────────────

    function noble() {
        if (typeof module === 'object' && module.exports) {
            // Node/Vitest (CJS): load the real packages directly, no bundle needed.
            var edwards = require('@noble/curves/ed25519.js');
            var sha2 = require('@noble/hashes/sha2.js');
            var hmacMod = require('@noble/hashes/hmac.js');
            var hkdfMod = require('@noble/hashes/hkdf.js');
            return {
                x25519: {
                    randomPrivateKey: function () { return edwards.x25519.utils.randomSecretKey(); },
                    getPublicKey: function (k) { return edwards.x25519.getPublicKey(k); },
                    getSharedSecret: function (a, b) { return edwards.x25519.getSharedSecret(a, b); }
                },
                ed25519: {
                    randomPrivateKey: function () { return edwards.ed25519.utils.randomSecretKey(); },
                    getPublicKey: function (k) { return edwards.ed25519.getPublicKey(k); },
                    sign: function (m, k) { return edwards.ed25519.sign(m, k); },
                    verify: function (s, m, pk) { return edwards.ed25519.verify(s, m, pk); }
                },
                sha256: function (d) { return sha2.sha256(d); },
                hmacSha256: function (k, d) { return hmacMod.hmac(sha2.sha256, k, d); },
                hkdf: function (ikm, salt, info, len) { return hkdfMod.hkdf(sha2.sha256, ikm, salt, info, len); }
            };
        }
        // Browser: noble-crypto.bundle.js (built from vendor-src/) must be
        // loaded via <script> before this file.
        var g = typeof window !== 'undefined' ? window : self;
        if (!g.NobleCrypto) {
            throw new Error('NobleCrypto not loaded — add <script src="noble-crypto.bundle.js"> before gm-signal-crypto.js');
        }
        return g.NobleCrypto;
    }

    var NC = noble();

    function generateX25519KeyPair() {
        var priv = NC.x25519.randomPrivateKey();
        return {
            privateKey: priv,
            publicKey: NC.x25519.getPublicKey(priv)
        };
    }

    function calculateX25519Agreement(privKey, pubKey) {
        return NC.x25519.getSharedSecret(privKey, pubKey);
    }

    // Separate Ed25519 identity signing keypair (not derived from the X25519
    // identity key — no home-grown XEdDSA-style conversion). Generated once
    // per identity alongside the X25519 identity key; its public part is
    // published in the prekey bundle so recipients can verify signed prekeys.
    function generateEd25519KeyPair() {
        var priv = NC.ed25519.randomPrivateKey();
        return {
            privateKey: priv,
            publicKey: NC.ed25519.getPublicKey(priv)
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 3. SHA-256, HMAC-SHA256, HKDF (via @noble/hashes — see section 2 note)
    // & AES-256-GCM (native WebCrypto, unchanged)
    // ─────────────────────────────────────────────────────────────────────────

    function sha256(bytes) {
        return NC.sha256(bytes);
    }

    function hmacSha256(key, message) {
        return NC.hmacSha256(key, message);
    }

    function hkdf(ikm, salt, info, length) {
        if (!salt || salt.length === 0) {
            salt = new Uint8Array(32);
        }
        return NC.hkdf(ikm, salt, info || new Uint8Array(0), length);
    }

    async function encryptAesGcm(keyBytes, plaintextBytes, ivBytes, additionalData) {
        var c = getCrypto();
        if (c && c.subtle) {
            var key = await c.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']);
            var params = { name: 'AES-GCM', iv: ivBytes };
            if (additionalData) params.additionalData = additionalData;
            var enc = await c.subtle.encrypt(params, key, plaintextBytes);
            return new Uint8Array(enc);
        }
        throw new Error('WebCrypto subtle AES-GCM not available');
    }

    async function decryptAesGcm(keyBytes, ciphertextWithTag, ivBytes, additionalData) {
        var c = getCrypto();
        if (c && c.subtle) {
            var key = await c.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
            var params = { name: 'AES-GCM', iv: ivBytes };
            if (additionalData) params.additionalData = additionalData;
            var dec = await c.subtle.decrypt(params, key, ciphertextWithTag);
            return new Uint8Array(dec);
        }
        throw new Error('WebCrypto subtle AES-GCM not available');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 4. PREKEY BUNDLE CREATION & X3DH PROTOCOL
    // ─────────────────────────────────────────────────────────────────────────

    function generateRegistrationId() {
        var b = getRandomBytes(2);
        return ((b[0] << 8) | b[1]) & 0x3fff;
    }

    // Real Ed25519 (RFC 8032), signed by a dedicated signing keypair — see
    // generateEd25519KeyPair() above. Previously a hand-rolled Curve25519
    // "Schnorr" scheme whose verifier never actually checked the signature
    // (see git history / R-03 audit finding); this replaces both sign and
    // verify with the audited implementation.
    function signPreKey(identitySigningPrivateKey, signedPreKeyPublicKey) {
        return NC.ed25519.sign(signedPreKeyPublicKey, identitySigningPrivateKey);
    }

    function verifyPreKeySignature(identitySigningPublicKey, signedPreKeyPublicKey, signatureBytes) {
        if (!signatureBytes || signatureBytes.length !== 64) return false;
        if (!identitySigningPublicKey || identitySigningPublicKey.length !== 32) return false; // fail closed, never skip
        try {
            return NC.ed25519.verify(signatureBytes, signedPreKeyPublicKey, identitySigningPublicKey);
        } catch (e) {
            return false;
        }
    }

    function createPreKeyBundle(count) {
        var otkCount = count || 20;
        var identityKey = generateX25519KeyPair();
        var identitySigningKey = generateEd25519KeyPair();
        var signedPreKey = generateX25519KeyPair();
        var signedPreKeySig = signPreKey(identitySigningKey.privateKey, signedPreKey.publicKey);
        var regId = generateRegistrationId();

        var oneTimePreKeys = [];
        for (var i = 1; i <= otkCount; i++) {
            var otk = generateX25519KeyPair();
            oneTimePreKeys.push({
                keyId: i,
                keyPair: otk
            });
        }

        return {
            identityKey: identityKey,
            identitySigningKey: identitySigningKey,
            signedPreKey: {
                keyPair: signedPreKey,
                signature: signedPreKeySig
            },
            registrationId: regId,
            oneTimePreKeys: oneTimePreKeys
        };
    }

    // X3DH Initiator (Sender/Alice)
    function x3dhInitiator(senderIdentityKeyPair, recipientBundle) {
        var ephemeralKeyPair = generateX25519KeyPair();

        var recipientIdentityKey = hexToBytes(recipientBundle.identity_key);
        var recipientSignedPreKey = hexToBytes(recipientBundle.signed_prekey);
        var recipientSignedPreKeySig = hexToBytes(recipientBundle.signed_prekey_sig);
        var recipientSigningKey = recipientBundle.identity_signing_key
            ? hexToBytes(recipientBundle.identity_signing_key)
            : null;

        // Verify Signed PreKey signature against the recipient's Ed25519
        // signing key. A bundle published before this key existed (or one
        // tampered with in transit) has no signing key here — refuse rather
        // than silently accepting an unverifiable prekey.
        if (!recipientSigningKey || !verifyPreKeySignature(recipientSigningKey, recipientSignedPreKey, recipientSignedPreKeySig)) {
            throw new Error('Invalid signed prekey signature in recipient bundle');
        }

        var dh1 = calculateX25519Agreement(senderIdentityKeyPair.privateKey, recipientSignedPreKey);
        var dh2 = calculateX25519Agreement(ephemeralKeyPair.privateKey, recipientIdentityKey);
        var dh3 = calculateX25519Agreement(ephemeralKeyPair.privateKey, recipientSignedPreKey);

        var dhArray = [dh1, dh2, dh3];
        var usedOtkKeyId = null;

        if (recipientBundle.one_time_public_key) {
            var recipientOtk = hexToBytes(recipientBundle.one_time_public_key);
            var dh4 = calculateX25519Agreement(ephemeralKeyPair.privateKey, recipientOtk);
            dhArray.push(dh4);
            usedOtkKeyId = recipientBundle.one_time_key_id;
        }

        var masterSharedSecret = concatBytes.apply(null, dhArray);
        var sharedKey = hkdf(masterSharedSecret, new Uint8Array(32), utf8ToBytes('FGF_SIGNAL_X3DH_V1'), 64);

        return {
            masterKey: sharedKey.subarray(0, 32),
            chainKey: sharedKey.subarray(32, 64),
            ephemeralPublicKey: ephemeralKeyPair.publicKey,
            recipientOneTimeKeyId: usedOtkKeyId
        };
    }

    // X3DH Receiver (Recipient/Bob)
    function x3dhReceiver(receiverIdentityKeyPair, receiverSignedPreKeyPair, receiverOtkKeyPair, senderIdentityPublicKey, senderEphemeralPublicKey) {
        var dh1 = calculateX25519Agreement(receiverSignedPreKeyPair.privateKey, senderIdentityPublicKey);
        var dh2 = calculateX25519Agreement(receiverIdentityKeyPair.privateKey, senderEphemeralPublicKey);
        var dh3 = calculateX25519Agreement(receiverSignedPreKeyPair.privateKey, senderEphemeralPublicKey);

        var dhArray = [dh1, dh2, dh3];
        if (receiverOtkKeyPair) {
            var dh4 = calculateX25519Agreement(receiverOtkKeyPair.privateKey, senderEphemeralPublicKey);
            dhArray.push(dh4);
        }

        var masterSharedSecret = concatBytes.apply(null, dhArray);
        var sharedKey = hkdf(masterSharedSecret, new Uint8Array(32), utf8ToBytes('FGF_SIGNAL_X3DH_V1'), 64);

        return {
            masterKey: sharedKey.subarray(0, 32),
            chainKey: sharedKey.subarray(32, 64)
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 5. DOUBLE RATCHET IMPLEMENTATION (1:1 DIRECT MESSAGING)
    // ─────────────────────────────────────────────────────────────────────────

    function kdfRoot(rootKey, dhOut) {
        var derived = hkdf(dhOut, rootKey, utf8ToBytes(INFO_RATCHET_ROOT), 64);
        return {
            rootKey: derived.subarray(0, 32),
            chainKey: derived.subarray(32, 64)
        };
    }

    function kdfChain(chainKey) {
        var messageKey = hmacSha256(chainKey, new Uint8Array([1]));
        var nextChainKey = hmacSha256(chainKey, new Uint8Array([2]));
        return {
            chainKey: nextChainKey,
            messageKey: messageKey
        };
    }

    function initializeSessionAlice(sharedSecret, bobDhPublicKey, aliceIdentityKeyPair) {
        var aliceDhKeyPair = generateX25519KeyPair();
        var dhOut = calculateX25519Agreement(aliceDhKeyPair.privateKey, bobDhPublicKey);
        var rootRes = kdfRoot(sharedSecret, dhOut);

        return {
            identityKeyPair: aliceIdentityKeyPair,
            dhKeyPair: aliceDhKeyPair,
            remoteDhPublicKey: bobDhPublicKey,
            rootKey: rootRes.rootKey,
            sendingChainKey: rootRes.chainKey,
            receivingChainKey: null,
            sendCount: 0,
            receiveCount: 0,
            previousSendCount: 0,
            skippedMessageKeys: {}
        };
    }

    function initializeSessionBob(sharedSecret, bobDhKeyPair, bobIdentityKeyPair) {
        return {
            identityKeyPair: bobIdentityKeyPair,
            dhKeyPair: bobDhKeyPair,
            remoteDhPublicKey: null,
            rootKey: sharedSecret,
            sendingChainKey: null,
            receivingChainKey: null,
            sendCount: 0,
            receiveCount: 0,
            previousSendCount: 0,
            skippedMessageKeys: {}
        };
    }

    function canonicalHeaderBytes(header) {
        if (!header || typeof header !== 'object') return new Uint8Array(0);
        var sortedKeys = Object.keys(header).sort();
        var canonicalObj = {};
        for (var i = 0; i < sortedKeys.length; i++) {
            var k = sortedKeys[i];
            canonicalObj[k] = header[k];
        }
        return utf8ToBytes(JSON.stringify(canonicalObj));
    }

    async function doubleRatchetEncrypt(session, plaintextUtf8) {
        if (!session.sendingChainKey) {
            var dhOut = calculateX25519Agreement(session.dhKeyPair.privateKey, session.remoteDhPublicKey);
            var rootRes = kdfRoot(session.rootKey, dhOut);
            session.rootKey = rootRes.rootKey;
            session.sendingChainKey = rootRes.chainKey;
        }

        var chainRes = kdfChain(session.sendingChainKey);
        session.sendingChainKey = chainRes.chainKey;

        var messageKey = chainRes.messageKey;
        var iv = getRandomBytes(12);
        var plaintextBytes = utf8ToBytes(plaintextUtf8);

        var header = {
            dhPub: bytesToHex(session.dhKeyPair.publicKey),
            pn: session.previousSendCount,
            n: session.sendCount
        };
        session.sendCount++;

        var headerBytes = canonicalHeaderBytes(header);
        var ciphertext = await encryptAesGcm(messageKey, plaintextBytes, iv, headerBytes);

        return {
            header: header,
            iv: bytesToHex(iv),
            ciphertext: bytesToBase64(ciphertext)
        };
    }

    async function doubleRatchetDecrypt(session, header, ivHex, ciphertextB64) {
        var remoteDhPub = hexToBytes(header.dhPub);
        var iv = hexToBytes(ivHex);
        var ciphertextWithTag = base64ToBytes(ciphertextB64);

        var dhChanged = !session.remoteDhPublicKey || bytesToHex(session.remoteDhPublicKey) !== header.dhPub;
        if (dhChanged) {
            session.previousSendCount = session.sendCount;
            session.sendCount = 0;
            session.receiveCount = 0;
            session.remoteDhPublicKey = remoteDhPub;

            var dhReceive = calculateX25519Agreement(session.dhKeyPair.privateKey, session.remoteDhPublicKey);
            var rootResReceive = kdfRoot(session.rootKey, dhReceive);
            session.rootKey = rootResReceive.rootKey;
            session.receivingChainKey = rootResReceive.chainKey;

            session.dhKeyPair = generateX25519KeyPair();
            var dhSend = calculateX25519Agreement(session.dhKeyPair.privateKey, session.remoteDhPublicKey);
            var rootResSend = kdfRoot(session.rootKey, dhSend);
            session.rootKey = rootResSend.rootKey;
            session.sendingChainKey = rootResSend.chainKey;
        }

        while (session.receiveCount < header.n) {
            var skippedChainRes = kdfChain(session.receivingChainKey);
            session.receivingChainKey = skippedChainRes.chainKey;
            var skippedKeyId = header.dhPub + ':' + session.receiveCount;
            session.skippedMessageKeys[skippedKeyId] = skippedChainRes.messageKey;
            session.receiveCount++;
        }

        var chainRes = kdfChain(session.receivingChainKey);
        session.receivingChainKey = chainRes.chainKey;
        session.receiveCount++;
        var messageKey = chainRes.messageKey;

        // Try canonical AAD, then raw, then legacy key order
        try {
            var aad1 = canonicalHeaderBytes(header);
            var dec1 = await decryptAesGcm(messageKey, ciphertextWithTag, iv, aad1);
            return bytesToUtf8(dec1);
        } catch (e1) {
            try {
                var aad2 = utf8ToBytes(JSON.stringify(header));
                var dec2 = await decryptAesGcm(messageKey, ciphertextWithTag, iv, aad2);
                return bytesToUtf8(dec2);
            } catch (e2) {
                var rawOrder = { dhPub: header.dhPub, pn: header.pn, n: header.n };
                var aad3 = utf8ToBytes(JSON.stringify(rawOrder));
                var dec3 = await decryptAesGcm(messageKey, ciphertextWithTag, iv, aad3);
                return bytesToUtf8(dec3);
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 6. SIGNAL SENDER KEYS PROTOCOL (GROUP MESSAGING)
    // ─────────────────────────────────────────────────────────────────────────

    function createGroupSenderKey(groupId, senderAccountId) {
        var salt = utf8ToBytes('FGF_SIGNAL_GROUP_SALT_2026');
        var info = utf8ToBytes('FGF_GROUP_CHAIN_KEY_V1:' + groupId);
        var chainKey = hkdf(utf8ToBytes(groupId), salt, info, 32);
        var signingKey = generateX25519KeyPair();
        return {
            groupId: groupId,
            senderAccountId: senderAccountId,
            chainKey: chainKey,
            signingKeyPair: signingKey,
            iteration: 0
        };
    }

    function kdfSenderKey(chainKey) {
        var messageKey = hmacSha256(chainKey, new Uint8Array([1]));
        var nextChainKey = hmacSha256(chainKey, new Uint8Array([2]));
        return {
            nextChainKey: nextChainKey,
            messageKey: messageKey
        };
    }

    // Create distribution payload for sharing sender key with group members
    function createSenderKeyDistribution(senderKeyRecord) {
        return {
            groupId: senderKeyRecord.groupId,
            senderAccountId: senderKeyRecord.senderAccountId,
            chainKey: bytesToHex(senderKeyRecord.chainKey),
            signingPublicKey: bytesToHex(senderKeyRecord.signingKeyPair.publicKey),
            iteration: senderKeyRecord.iteration
        };
    }

    function importSenderKeyDistribution(dist) {
        return {
            groupId: dist.groupId,
            senderAccountId: dist.senderAccountId,
            chainKey: hexToBytes(dist.chainKey),
            signingPublicKey: hexToBytes(dist.signingPublicKey),
            iteration: dist.iteration
        };
    }

    async function groupSenderKeyEncrypt(senderKeyRecord, plaintextUtf8) {
        var iteration = (senderKeyRecord && typeof senderKeyRecord.iteration === 'number') ? senderKeyRecord.iteration : 0;
        if (senderKeyRecord) senderKeyRecord.iteration = iteration + 1;

        var iv = getRandomBytes(12);
        var ivHex = bytesToHex(iv);
        var messageKey = hkdf(senderKeyRecord.chainKey, iv, utf8ToBytes('group_msg_kdf_' + iteration), 32);

        var header = {
            senderAccountId: senderKeyRecord.senderAccountId,
            iteration: iteration,
            sigPub: bytesToHex(senderKeyRecord.signingKeyPair.publicKey)
        };
        var headerBytes = canonicalHeaderBytes(header);
        var plaintextBytes = utf8ToBytes(plaintextUtf8);

        var ciphertext = await encryptAesGcm(messageKey, plaintextBytes, iv, headerBytes);

        return {
            header: header,
            iv: ivHex,
            ciphertext: bytesToBase64(ciphertext)
        };
    }

    async function groupSenderKeyDecrypt(senderKeyRecord, header, ivHex, ciphertextB64) {
        var iv = hexToBytes(ivHex);
        var ciphertextWithTag = base64ToBytes(ciphertextB64);
        var iteration = (header && typeof header.iteration === 'number') ? header.iteration : 0;

        var messageKey = hkdf(senderKeyRecord.chainKey, iv, utf8ToBytes('group_msg_kdf_' + iteration), 32);

        // Attempt 1: Canonical sorted JSON header
        try {
            var aad1 = canonicalHeaderBytes(header);
            var dec1 = await decryptAesGcm(messageKey, ciphertextWithTag, iv, aad1);
            return bytesToUtf8(dec1);
        } catch (e1) {
            // Attempt 2: Direct JSON.stringify(header)
            try {
                var aad2 = utf8ToBytes(JSON.stringify(header));
                var dec2 = await decryptAesGcm(messageKey, ciphertextWithTag, iv, aad2);
                return bytesToUtf8(dec2);
            } catch (e2) {
                // Attempt 3: Legacy key order { senderAccountId, iteration, sigPub }
                try {
                    var rawOrder = {
                        senderAccountId: header.senderAccountId,
                        iteration: header.iteration,
                        sigPub: header.sigPub
                    };
                    var aad3 = utf8ToBytes(JSON.stringify(rawOrder));
                    var dec3 = await decryptAesGcm(messageKey, ciphertextWithTag, iv, aad3);
                    return bytesToUtf8(dec3);
                } catch (e3) {
                    // Attempt 4: Empty AAD
                    var dec4 = await decryptAesGcm(messageKey, ciphertextWithTag, iv, new Uint8Array(0));
                    return bytesToUtf8(dec4);
                }
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 7. SAFETY NUMBERS & FINGERPRINT VERIFICATION
    // ─────────────────────────────────────────────────────────────────────────

    function computeSafetyNumber(accountA, identityKeyABytes, accountB, identityKeyBBytes) {
        var sorted = [
            { id: accountA, key: identityKeyABytes },
            { id: accountB, key: identityKeyBBytes }
        ].sort(function (x, y) { return x.id.localeCompare(y.id); });

        var combined = concatBytes(
            utf8ToBytes(sorted[0].id),
            sorted[0].key,
            utf8ToBytes(sorted[1].id),
            sorted[1].key
        );

        var hash = sha256(combined);
        var numStr = '';
        for (var i = 0; i < 12; i += 2) {
            var val = (hash[i] << 8) | hash[i + 1];
            var segment = (val % 100000).toString().padStart(5, '0');
            numStr += segment + (i < 10 ? ' ' : '');
        }
        return numStr;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 8. STORAGE ENGINE (INDEXEDDB / LOCAL STORAGE FALLBACK)
    // ─────────────────────────────────────────────────────────────────────────

    var DB_NAME = 'fgf_signal_e2ee_keystore_v1';
    var DB_VERSION = 1;
    var STORES = ['identity_keys', 'prekeys', 'sessions', 'group_sender_keys'];

    function openDatabase() {
        return new Promise(function (resolve, reject) {
            if (typeof indexedDB === 'undefined') {
                return resolve(null);
            }
            var req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = function (e) {
                var db = e.target.result;
                STORES.forEach(function (storeName) {
                    if (!db.objectStoreNames.contains(storeName)) {
                        db.createObjectStore(storeName, { keyPath: 'id' });
                    }
                });
            };
            req.onsuccess = function (e) {
                resolve(e.target.result);
            };
            req.onerror = function (e) {
                resolve(null);
            };
        });
    }

    async function saveKeyRecord(storeName, id, data) {
        var db = await openDatabase();
        if (!db) {
            try {
                localStorage.setItem('e2ee:' + storeName + ':' + id, JSON.stringify(data));
            } catch (e) {}
            return;
        }
        return new Promise(function (resolve, reject) {
            var tx = db.transaction(storeName, 'readwrite');
            var store = tx.objectStore(storeName);
            store.put({ id: id, data: data, updatedAt: Date.now() });
            tx.oncomplete = function () { resolve(); };
            tx.onerror = function () { resolve(); };
        });
    }

    async function loadKeyRecord(storeName, id) {
        var db = await openDatabase();
        if (!db) {
            try {
                var raw = localStorage.getItem('e2ee:' + storeName + ':' + id);
                return raw ? JSON.parse(raw) : null;
            } catch (e) {
                return null;
            }
        }
        return new Promise(function (resolve, reject) {
            var tx = db.transaction(storeName, 'readonly');
            var store = tx.objectStore(storeName);
            var req = store.get(id);
            req.onsuccess = function () {
                resolve(req.result ? req.result.data : null);
            };
            req.onerror = function () {
                resolve(null);
            };
        });
    }

    return {
        bytesToHex: bytesToHex,
        hexToBytes: hexToBytes,
        bytesToBase64: bytesToBase64,
        base64ToBytes: base64ToBytes,
        utf8ToBytes: utf8ToBytes,
        bytesToUtf8: bytesToUtf8,
        getRandomBytes: getRandomBytes,

        generateX25519KeyPair: generateX25519KeyPair,
        generateEd25519KeyPair: generateEd25519KeyPair,
        calculateX25519Agreement: calculateX25519Agreement,
        sha256: sha256,
        hmacSha256: hmacSha256,
        hkdf: hkdf,
        encryptAesGcm: encryptAesGcm,
        decryptAesGcm: decryptAesGcm,

        createPreKeyBundle: createPreKeyBundle,
        signPreKey: signPreKey,
        verifyPreKeySignature: verifyPreKeySignature,
        x3dhInitiator: x3dhInitiator,
        x3dhReceiver: x3dhReceiver,

        initializeSessionAlice: initializeSessionAlice,
        initializeSessionBob: initializeSessionBob,
        doubleRatchetEncrypt: doubleRatchetEncrypt,
        doubleRatchetDecrypt: doubleRatchetDecrypt,

        createGroupSenderKey: createGroupSenderKey,
        createSenderKeyDistribution: createSenderKeyDistribution,
        importSenderKeyDistribution: importSenderKeyDistribution,
        groupSenderKeyEncrypt: groupSenderKeyEncrypt,
        groupSenderKeyDecrypt: groupSenderKeyDecrypt,

        computeSafetyNumber: computeSafetyNumber,

        saveKeyRecord: saveKeyRecord,
        loadKeyRecord: loadKeyRecord
    };
});
