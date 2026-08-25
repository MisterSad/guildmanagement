/**
 * src/core/crypto/signal.ts — TypeScript Signal Protocol Types and Wrapper
 * FGF Guild Management Tool — 2026 Zero-Trust Architecture
 */

export interface KeyPair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export interface PreKeyBundle {
  identityKey: KeyPair;
  signedPreKey: {
    keyPair: KeyPair;
    signature: Uint8Array;
  };
  registrationId: number;
  oneTimePreKeys: Array<{
    keyId: number;
    keyPair: KeyPair;
  }>;
}

export interface PublicPreKeyBundle {
  account_id: string;
  identity_key: string;
  signed_prekey: string;
  signed_prekey_sig: string;
  registration_id: number;
  one_time_key_id?: number | null;
  one_time_public_key?: string | null;
}

export interface DoubleRatchetHeader {
  dhPub: string;
  pn: number;
  n: number;
}

export interface EncryptedMessagePayload {
  header: DoubleRatchetHeader | { senderAccountId: string; iteration: number; sigPub: string };
  iv: string;
  ciphertext: string;
}

export interface SenderKeyDistribution {
  groupId: string;
  senderAccountId: string;
  chainKey: string;
  signingPublicKey: string;
  iteration: number;
}

export interface SignalSession {
  identityKeyPair: KeyPair;
  dhKeyPair: KeyPair;
  remoteDhPublicKey: Uint8Array | null;
  rootKey: Uint8Array;
  sendingChainKey: Uint8Array | null;
  receivingChainKey: Uint8Array | null;
  sendCount: number;
  receiveCount: number;
  previousSendCount: number;
  skippedMessageKeys: Record<string, Uint8Array>;
}

export interface GroupSenderKeyRecord {
  groupId: string;
  senderAccountId: string;
  chainKey: Uint8Array;
  signingKeyPair?: KeyPair;
  signingPublicKey?: Uint8Array;
  iteration: number;
}
