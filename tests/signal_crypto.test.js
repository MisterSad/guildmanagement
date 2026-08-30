import { describe, it, expect } from 'vitest';
import GM_SIGNAL from '../gm-signal-crypto.js';

describe('gm-signal-crypto.js — Signal Protocol Engine', () => {
    it('generates valid X25519 keypairs and performs ECDH scalar multiplication', () => {
        const alice = GM_SIGNAL.generateX25519KeyPair();
        const bob = GM_SIGNAL.generateX25519KeyPair();

        expect(alice.privateKey.length).toBe(32);
        expect(alice.publicKey.length).toBe(32);
        expect(bob.privateKey.length).toBe(32);
        expect(bob.publicKey.length).toBe(32);

        const secretAlice = GM_SIGNAL.calculateX25519Agreement(alice.privateKey, bob.publicKey);
        const secretBob = GM_SIGNAL.calculateX25519Agreement(bob.privateKey, alice.publicKey);

        expect(GM_SIGNAL.bytesToHex(secretAlice)).toBe(GM_SIGNAL.bytesToHex(secretBob));
    });

    it('performs SHA-256 and HMAC-SHA256 and HKDF key derivation correctly', () => {
        const data = GM_SIGNAL.utf8ToBytes('Hello Signal Protocol');
        const hash = GM_SIGNAL.sha256(data);
        expect(hash.length).toBe(32);

        const key = GM_SIGNAL.utf8ToBytes('secret-key');
        const mac = GM_SIGNAL.hmacSha256(key, data);
        expect(mac.length).toBe(32);

        const derived = GM_SIGNAL.hkdf(mac, new Uint8Array(32), GM_SIGNAL.utf8ToBytes('info'), 64);
        expect(derived.length).toBe(64);
    });

    it('executes X3DH handshake between Alice and Bob', () => {
        // Bob creates prekey bundle
        const bobBundle = GM_SIGNAL.createPreKeyBundle(5);
        const bobPublicBundle = {
            account_id: 'Bob',
            identity_key: GM_SIGNAL.bytesToHex(bobBundle.identityKey.publicKey),
            identity_signing_key: GM_SIGNAL.bytesToHex(bobBundle.identitySigningKey.publicKey),
            signed_prekey: GM_SIGNAL.bytesToHex(bobBundle.signedPreKey.keyPair.publicKey),
            signed_prekey_sig: GM_SIGNAL.bytesToHex(bobBundle.signedPreKey.signature),
            registration_id: bobBundle.registrationId,
            one_time_key_id: 1,
            one_time_public_key: GM_SIGNAL.bytesToHex(bobBundle.oneTimePreKeys[0].keyPair.publicKey)
        };

        // Alice initiates X3DH
        const aliceIdentity = GM_SIGNAL.generateX25519KeyPair();
        const aliceInit = GM_SIGNAL.x3dhInitiator(aliceIdentity, bobPublicBundle);

        // Bob completes X3DH
        const bobReceived = GM_SIGNAL.x3dhReceiver(
            bobBundle.identityKey,
            bobBundle.signedPreKey.keyPair,
            bobBundle.oneTimePreKeys[0].keyPair,
            aliceIdentity.publicKey,
            aliceInit.ephemeralPublicKey
        );

        expect(GM_SIGNAL.bytesToHex(aliceInit.masterKey)).toBe(GM_SIGNAL.bytesToHex(bobReceived.masterKey));
        expect(GM_SIGNAL.bytesToHex(aliceInit.chainKey)).toBe(GM_SIGNAL.bytesToHex(bobReceived.chainKey));
    });

    // Regression test for the R-03 audit finding: verifyPreKeySignature() used
    // to compute the real check into an unused variable and return a
    // tautology (a hash compared to itself), so it accepted every
    // signature unconditionally. These assert it actually rejects forgeries.
    describe('verifyPreKeySignature — regression: must actually verify, not always pass', () => {
        it('accepts a genuine signature', () => {
            const bundle = GM_SIGNAL.createPreKeyBundle(1);
            const ok = GM_SIGNAL.verifyPreKeySignature(
                bundle.identitySigningKey.publicKey,
                bundle.signedPreKey.keyPair.publicKey,
                bundle.signedPreKey.signature
            );
            expect(ok).toBe(true);
        });

        it('rejects a tampered signature', () => {
            const bundle = GM_SIGNAL.createPreKeyBundle(1);
            const tampered = new Uint8Array(bundle.signedPreKey.signature);
            tampered[0] ^= 0xff;
            const ok = GM_SIGNAL.verifyPreKeySignature(
                bundle.identitySigningKey.publicKey,
                bundle.signedPreKey.keyPair.publicKey,
                tampered
            );
            expect(ok).toBe(false);
        });

        it('rejects a genuine signature checked against the wrong signing key', () => {
            const bundle = GM_SIGNAL.createPreKeyBundle(1);
            const impostor = GM_SIGNAL.generateEd25519KeyPair();
            const ok = GM_SIGNAL.verifyPreKeySignature(
                impostor.publicKey,
                bundle.signedPreKey.keyPair.publicKey,
                bundle.signedPreKey.signature
            );
            expect(ok).toBe(false);
        });

        it('rejects a signature over a different signed prekey than was signed', () => {
            const bundle = GM_SIGNAL.createPreKeyBundle(1);
            const otherKeyPair = GM_SIGNAL.generateX25519KeyPair();
            const ok = GM_SIGNAL.verifyPreKeySignature(
                bundle.identitySigningKey.publicKey,
                otherKeyPair.publicKey,
                bundle.signedPreKey.signature
            );
            expect(ok).toBe(false);
        });

        it('x3dhInitiator fails closed when the bundle has no identity_signing_key', () => {
            const bobBundle = GM_SIGNAL.createPreKeyBundle(1);
            const bobPublicBundle = {
                account_id: 'Bob',
                identity_key: GM_SIGNAL.bytesToHex(bobBundle.identityKey.publicKey),
                // identity_signing_key intentionally omitted (pre-migration row)
                signed_prekey: GM_SIGNAL.bytesToHex(bobBundle.signedPreKey.keyPair.publicKey),
                signed_prekey_sig: GM_SIGNAL.bytesToHex(bobBundle.signedPreKey.signature),
                registration_id: bobBundle.registrationId
            };
            const aliceIdentity = GM_SIGNAL.generateX25519KeyPair();
            expect(() => GM_SIGNAL.x3dhInitiator(aliceIdentity, bobPublicBundle)).toThrow();
        });

        it('x3dhInitiator rejects a bundle with a forged signed-prekey signature', () => {
            const bobBundle = GM_SIGNAL.createPreKeyBundle(1);
            const forgedSig = new Uint8Array(bobBundle.signedPreKey.signature);
            forgedSig[0] ^= 0xff;
            const bobPublicBundle = {
                account_id: 'Bob',
                identity_key: GM_SIGNAL.bytesToHex(bobBundle.identityKey.publicKey),
                identity_signing_key: GM_SIGNAL.bytesToHex(bobBundle.identitySigningKey.publicKey),
                signed_prekey: GM_SIGNAL.bytesToHex(bobBundle.signedPreKey.keyPair.publicKey),
                signed_prekey_sig: GM_SIGNAL.bytesToHex(forgedSig),
                registration_id: bobBundle.registrationId
            };
            const aliceIdentity = GM_SIGNAL.generateX25519KeyPair();
            expect(() => GM_SIGNAL.x3dhInitiator(aliceIdentity, bobPublicBundle)).toThrow();
        });
    });

    it('encrypts and decrypts 1:1 messages using Double Ratchet across multiple rounds', async () => {
        const sharedSecret = GM_SIGNAL.getRandomBytes(32);
        const aliceIdentity = GM_SIGNAL.generateX25519KeyPair();
        const bobIdentity = GM_SIGNAL.generateX25519KeyPair();
        const bobDh = GM_SIGNAL.generateX25519KeyPair();

        const aliceSession = GM_SIGNAL.initializeSessionAlice(sharedSecret, bobDh.publicKey, aliceIdentity);
        const bobSession = GM_SIGNAL.initializeSessionBob(sharedSecret, bobDh, bobIdentity);

        // Alice -> Bob: Message 1
        const msg1 = await GM_SIGNAL.doubleRatchetEncrypt(aliceSession, 'Hello Bob from ALPHA [R5]');
        const dec1 = await GM_SIGNAL.doubleRatchetDecrypt(bobSession, msg1.header, msg1.iv, msg1.ciphertext);
        expect(dec1).toBe('Hello Bob from ALPHA [R5]');

        // Alice -> Bob: Message 2 (Same direction, ratchet advances)
        const msg2 = await GM_SIGNAL.doubleRatchetEncrypt(aliceSession, 'Are you ready for SvS?');
        const dec2 = await GM_SIGNAL.doubleRatchetDecrypt(bobSession, msg2.header, msg2.iv, msg2.ciphertext);
        expect(dec2).toBe('Are you ready for SvS?');

        // Bob -> Alice: Message 3 (Direction turns, DH ratchet triggers)
        const msg3 = await GM_SIGNAL.doubleRatchetEncrypt(bobSession, 'Affirmative HawkTuah, squad 1 ready.');
        const dec3 = await GM_SIGNAL.doubleRatchetDecrypt(aliceSession, msg3.header, msg3.iv, msg3.ciphertext);
        expect(dec3).toBe('Affirmative HawkTuah, squad 1 ready.');
    });

    it('encrypts and decrypts Group messages using Signal Sender Keys', async () => {
        const groupId = 'group-svs-coalition-1058';
        const aliceSenderKey = GM_SIGNAL.createGroupSenderKey(groupId, 'HawkTuah');

        // Alice distributes her initial sender key to Bob
        const distributionPayload = GM_SIGNAL.createSenderKeyDistribution(aliceSenderKey);
        const bobViewOfAliceKey = GM_SIGNAL.importSenderKeyDistribution(distributionPayload);

        // Alice encrypts multiple group messages
        const groupMsg1 = await GM_SIGNAL.groupSenderKeyEncrypt(aliceSenderKey, '📢 NAP terms active for all S1058 leaders.');
        const groupMsg2 = await GM_SIGNAL.groupSenderKeyEncrypt(aliceSenderKey, '⚔️ Target sector 4 at 18:00 UTC.');

        // Bob decrypts both messages sequentially
        const decGroupMsg1 = await GM_SIGNAL.groupSenderKeyDecrypt(
            bobViewOfAliceKey,
            groupMsg1.header,
            groupMsg1.iv,
            groupMsg1.ciphertext
        );
        expect(decGroupMsg1).toBe('📢 NAP terms active for all S1058 leaders.');

        const decGroupMsg2 = await GM_SIGNAL.groupSenderKeyDecrypt(
            bobViewOfAliceKey,
            groupMsg2.header,
            groupMsg2.iv,
            groupMsg2.ciphertext
        );
        expect(decGroupMsg2).toBe('⚔️ Target sector 4 at 18:00 UTC.');
    });

    it('computes deterministically sorted 60-digit safety numbers between two leaders', () => {
        const aliceIdentity = GM_SIGNAL.generateX25519KeyPair();
        const bobIdentity = GM_SIGNAL.generateX25519KeyPair();

        const safetyAB = GM_SIGNAL.computeSafetyNumber('HawkTuah', aliceIdentity.publicKey, 'Ares', bobIdentity.publicKey);
        const safetyBA = GM_SIGNAL.computeSafetyNumber('Ares', bobIdentity.publicKey, 'HawkTuah', aliceIdentity.publicKey);

        expect(safetyAB).toBe(safetyBA);
        expect(safetyAB.split(' ').length).toBe(6);
    });
});
