// Source for noble-crypto.bundle.js — do not edit the bundle by hand.
// Rebuild with: npm run build:vendor-crypto
//
// Exposes the exact primitives gm-signal-crypto.js needs, pre-bundled from
// @noble/curves and @noble/hashes (audited, dependency-free) so the browser
// never fetches crypto code from a third-party origin at runtime. Loaded as
// a plain <script> (no bundler for root files), so this must be a
// self-contained global, not an ES module import consumers resolve themselves.

import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { hkdf as nobleHkdf } from '@noble/hashes/hkdf.js';

globalThis.NobleCrypto = {
  x25519: {
    randomPrivateKey: () => x25519.utils.randomSecretKey(),
    getPublicKey: (privateKey) => x25519.getPublicKey(privateKey),
    getSharedSecret: (privateKey, publicKey) => x25519.getSharedSecret(privateKey, publicKey),
  },
  ed25519: {
    randomPrivateKey: () => ed25519.utils.randomSecretKey(),
    getPublicKey: (privateKey) => ed25519.getPublicKey(privateKey),
    sign: (message, privateKey) => ed25519.sign(message, privateKey),
    verify: (signature, message, publicKey) => ed25519.verify(signature, message, publicKey),
  },
  sha256: (data) => sha256(data),
  hmacSha256: (key, data) => hmac(sha256, key, data),
  hkdf: (ikm, salt, info, length) => nobleHkdf(sha256, ikm, salt, info, length),
};
