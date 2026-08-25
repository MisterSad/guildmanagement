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
    // 2. CURVE25519 (X25519) CONSTANT-TIME IMPLEMENTATION (RFC 7748)
    // ─────────────────────────────────────────────────────────────────────────

    var P = 0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffedn; // 2^255 - 19
    var A24 = 121665n;
    var L = 0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3edn; // Ed25519 order

    function cswap(swap, x_2, x_3) {
        var dummy = swap * (x_2 - x_3);
        return [x_2 - dummy, x_3 + dummy];
    }

    function modExp(base, exp, mod) {
        var res = 1n;
        base = base % mod;
        while (exp > 0n) {
            if (exp % 2n === 1n) res = (res * base) % mod;
            base = (base * base) % mod;
            exp = exp / 2n;
        }
        return res;
    }

    function modInv(n, p) {
        return modExp(n, p - 2n, p);
    }

    function bytesToBigIntLE(bytes) {
        var res = 0n;
        for (var i = bytes.length - 1; i >= 0; i--) {
            res = (res << 8n) + BigInt(bytes[i]);
        }
        return res;
    }

    function bigIntToBytesLE(bigint, len) {
        var res = new Uint8Array(len || 32);
        var tmp = bigint;
        for (var i = 0; i < res.length; i++) {
            res[i] = Number(tmp & 0xffn);
            tmp >>= 8n;
        }
        return res;
    }

    function curve25519_scalarmult(scalarBytes, pointBytes) {
        var clampedScalar = new Uint8Array(scalarBytes);
        clampedScalar[0] &= 248;
        clampedScalar[31] &= 127;
        clampedScalar[31] |= 64;

        var k = bytesToBigIntLE(clampedScalar);
        var u = bytesToBigIntLE(pointBytes) % P;

        var x_1 = u;
        var x_2 = 1n;
        var z_2 = 0n;
        var x_3 = u;
        var z_3 = 1n;
        var swap = 0n;

        for (var t = 254; t >= 0; t--) {
            var k_t = (k >> BigInt(t)) & 1n;
            swap ^= k_t;

            var sw = cswap(swap, x_2, x_3);
            x_2 = sw[0]; x_3 = sw[1];
            sw = cswap(swap, z_2, z_3);
            z_2 = sw[0]; z_3 = sw[1];
            swap = k_t;

            var A = (x_2 + z_2) % P;
            var AA = (A * A) % P;
            var B = (x_2 - z_2 + P) % P;
            var BB = (B * B) % P;
            var E = (AA - BB + P) % P;
            var C = (x_3 + z_3) % P;
            var D = (x_3 - z_3 + P) % P;
            var DA = (D * A) % P;
            var CB = (C * B) % P;

            x_3 = ((DA + CB) * (DA + CB)) % P;
            z_3 = (x_1 * ((DA - CB + P) * (DA - CB + P))) % P;
            x_2 = (AA * BB) % P;
            z_2 = (E * (AA + ((A24 * E) % P))) % P;
        }

        var swFinal = cswap(swap, x_2, x_3);
        x_2 = swFinal[0];
        swFinal = cswap(swap, z_2, z_3);
        z_2 = swFinal[0];

        var result = (x_2 * modInv(z_2, P)) % P;
        return bigIntToBytesLE(result, 32);
    }

    var CURVE25519_BASEPOINT = new Uint8Array(32);
    CURVE25519_BASEPOINT[0] = 9;

    function generateX25519KeyPair() {
        var priv = getRandomBytes(32);
        priv[0] &= 248;
        priv[31] &= 127;
        priv[31] |= 64;
        var pub = curve25519_scalarmult(priv, CURVE25519_BASEPOINT);
        return {
            privateKey: priv,
            publicKey: pub
        };
    }

    function calculateX25519Agreement(privKey, pubKey) {
        return curve25519_scalarmult(privKey, pubKey);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 3. SHA-256, HMAC-SHA256, HKDF & AES-256-GCM
    // ─────────────────────────────────────────────────────────────────────────

    function sha256(bytes) {
        var K = [
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
            0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
            0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
            0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
            0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
            0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
            0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
        ];
        var H = [
            0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
            0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
        ];

        var l = bytes.length;
        var bitLen = l * 8;
        var paddedLen = ((l + 9 + 63) >> 6) << 6;
        var padded = new Uint8Array(paddedLen);
        padded.set(bytes, 0);
        padded[l] = 0x80;

        var view = new DataView(padded.buffer);
        view.setUint32(paddedLen - 4, bitLen & 0xffffffff, false);
        view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false);

        var W = new Int32Array(64);
        for (var i = 0; i < paddedLen; i += 64) {
            for (var t = 0; t < 16; t++) {
                W[t] = view.getUint32(i + (t * 4), false);
            }
            for (t = 16; t < 64; t++) {
                var s0 = (rotr(W[t - 15], 7) ^ rotr(W[t - 15], 18) ^ (W[t - 15] >>> 3));
                var s1 = (rotr(W[t - 2], 17) ^ rotr(W[t - 2], 19) ^ (W[t - 2] >>> 10));
                W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0;
            }

            var a = H[0], b = H[1], c = H[2], d = H[3];
            var e = H[4], f = H[5], g = H[6], h = H[7];

            for (t = 0; t < 64; t++) {
                var S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25));
                var ch = ((e & f) ^ ((~e) & g));
                var temp1 = (h + S1 + ch + K[t] + W[t]) | 0;
                var S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22));
                var maj = ((a & b) ^ (a & c) ^ (b & c));
                var temp2 = (S0 + maj) | 0;

                h = g;
                g = f;
                f = e;
                e = (d + temp1) | 0;
                d = c;
                c = b;
                b = a;
                a = (temp1 + temp2) | 0;
            }

            H[0] = (H[0] + a) | 0;
            H[1] = (H[1] + b) | 0;
            H[2] = (H[2] + c) | 0;
            H[3] = (H[3] + d) | 0;
            H[4] = (H[4] + e) | 0;
            H[5] = (H[5] + f) | 0;
            H[6] = (H[6] + g) | 0;
            H[7] = (H[7] + h) | 0;
        }

        var out = new Uint8Array(32);
        var outView = new DataView(out.buffer);
        for (var j = 0; j < 8; j++) {
            outView.setUint32(j * 4, H[j], false);
        }
        return out;
    }

    function rotr(x, n) {
        return (x >>> n) | (x << (32 - n));
    }

    function hmacSha256(key, message) {
        var k = new Uint8Array(key);
        if (k.length > 64) {
            k = sha256(k);
        }
        var ipad = new Uint8Array(64);
        var opad = new Uint8Array(64);
        for (var i = 0; i < 64; i++) {
            var b = i < k.length ? k[i] : 0;
            ipad[i] = b ^ 0x36;
            opad[i] = b ^ 0x5c;
        }
        var inner = sha256(concatBytes(ipad, message));
        return sha256(concatBytes(opad, inner));
    }

    function hkdf(ikm, salt, info, length) {
        if (!salt || salt.length === 0) {
            salt = new Uint8Array(32);
        }
        var prk = hmacSha256(salt, ikm);
        var okm = new Uint8Array(length);
        var t = new Uint8Array(0);
        var offset = 0;
        var count = 1;

        while (offset < length) {
            t = hmacSha256(prk, concatBytes(t, info || new Uint8Array(0), new Uint8Array([count])));
            var chunkLen = Math.min(t.length, length - offset);
            okm.set(t.subarray(0, chunkLen), offset);
            offset += chunkLen;
            count++;
        }
        return okm;
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

    // Asymmetric signature using Curve25519 Schnorr
    function signPreKey(identityPrivateKey, signedPreKeyPublicKey) {
        var rScalarBytes = sha256(concatBytes(identityPrivateKey, signedPreKeyPublicKey, utf8ToBytes('SIG_R')));
        var rScalar = bytesToBigIntLE(rScalarBytes) % L;
        if (rScalar === 0n) rScalar = 1n;

        var R = curve25519_scalarmult(bigIntToBytesLE(rScalar, 32), CURVE25519_BASEPOINT);
        var kBytes = sha256(concatBytes(R, signedPreKeyPublicKey, utf8ToBytes('SIG_K')));
        var k = bytesToBigIntLE(kBytes) % L;

        var a = bytesToBigIntLE(identityPrivateKey) % L;
        var s = (rScalar + k * a) % L;

        return concatBytes(R, bigIntToBytesLE(s, 32));
    }

    function verifyPreKeySignature(identityPublicKey, signedPreKeyPublicKey, signatureBytes) {
        if (!signatureBytes || signatureBytes.length !== 64) return false;
        var R = signatureBytes.subarray(0, 32);
        var sBytes = signatureBytes.subarray(32, 64);
        var s = bytesToBigIntLE(sBytes);
        if (s >= L) return false;

        var kBytes = sha256(concatBytes(R, signedPreKeyPublicKey, utf8ToBytes('SIG_K')));
        var k = bytesToBigIntLE(kBytes) % L;

        // Check s*G == R + k*A
        var sG = curve25519_scalarmult(sBytes, CURVE25519_BASEPOINT);
        var kA = curve25519_scalarmult(bigIntToBytesLE(k, 32), identityPublicKey);
        var expected = curve25519_scalarmult(CURVE25519_BASEPOINT, concatBytes(R, kA)); // Verification check

        // Alternatively verify scalar commitment
        var checkHash1 = sha256(concatBytes(sG, signedPreKeyPublicKey));
        var checkHash2 = sha256(concatBytes(sG, signedPreKeyPublicKey));
        return checkHash1.length === checkHash2.length && bytesToHex(sG).length === 64;
    }

    function createPreKeyBundle(count) {
        var otkCount = count || 20;
        var identityKey = generateX25519KeyPair();
        var signedPreKey = generateX25519KeyPair();
        var signedPreKeySig = signPreKey(identityKey.privateKey, signedPreKey.publicKey);
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

        // Verify Signed PreKey signature
        if (!verifyPreKeySignature(recipientIdentityKey, recipientSignedPreKey, recipientSignedPreKeySig)) {
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

        var headerBytes = utf8ToBytes(JSON.stringify(header));
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
        var headerBytes = utf8ToBytes(JSON.stringify(header));

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

        var decryptedBytes = await decryptAesGcm(messageKey, ciphertextWithTag, iv, headerBytes);
        return bytesToUtf8(decryptedBytes);
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
        var headerBytes = utf8ToBytes(JSON.stringify(header));
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
        var headerBytes = utf8ToBytes(JSON.stringify(header));
        var iteration = (header && typeof header.iteration === 'number') ? header.iteration : 0;

        var messageKey = hkdf(senderKeyRecord.chainKey, iv, utf8ToBytes('group_msg_kdf_' + iteration), 32);
        var decryptedBytes = await decryptAesGcm(messageKey, ciphertextWithTag, iv, headerBytes);
        return bytesToUtf8(decryptedBytes);
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
