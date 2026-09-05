// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import LeaderHall from '../gm-leader-hall.js';

describe('Ticket 1.3: Privacy by Design - E2EE Plaintext Cache Elimination', () => {
    const srcPath = path.resolve(__dirname, '../gm-leader-hall.js');
    const src = fs.readFileSync(srcPath, 'utf-8');

    beforeEach(() => {
        localStorage.clear();
    });

    describe('1. Static Code Analysis & Invariant Checks', () => {
        it('never calls localStorage.setItem with gm_e2ee_cache_ prefix', () => {
            expect(src).not.toContain("localStorage.setItem('gm_e2ee_cache_");
            expect(src).not.toMatch(/localStorage\.setItem\(['"`]gm_e2ee_cache_/);
        });

        it('never calls localStorage.getItem with gm_e2ee_cache_ prefix to load decrypted text', () => {
            expect(src).not.toContain("localStorage.getItem('gm_e2ee_cache_");
            expect(src).not.toMatch(/localStorage\.getItem\(['"`]gm_e2ee_cache_/);
        });

        it('uses an in-memory Map for decryptedCache session storage', () => {
            expect(src).toContain('var decryptedCache = new Map();');
            expect(src).not.toContain('var decryptedCache = {};');
        });

        it('does not expose decryptedCache globally on window or window.GM', () => {
            expect(window.decryptedCache).toBeUndefined();
            if (window.GM) {
                expect(window.GM.decryptedCache).toBeUndefined();
            }
            expect(LeaderHall.decryptedCache).toBeUndefined();
        });
    });

    describe('2. In-Memory Session Caching Behavior', () => {
        it('caches decrypted messages in-memory without writing to localStorage', () => {
            const msgId = 'msg-uuid-999';
            const plaintext = 'Secret strategic coordinates 45:120';

            LeaderHall.setCachedDecrypted(msgId, plaintext);

            // In-memory lookup succeeds
            expect(LeaderHall.getCachedDecrypted(msgId)).toBe(plaintext);

            // LocalStorage remains completely free of E2EE plaintext
            expect(localStorage.getItem('gm_e2ee_cache_' + msgId)).toBeNull();
            expect(localStorage.getItem(msgId)).toBeNull();
            expect(localStorage.length).toBe(0);
        });

        it('handles null, undefined, or empty message IDs and content gracefully', () => {
            expect(LeaderHall.getCachedDecrypted(null)).toBeNull();
            expect(LeaderHall.getCachedDecrypted('')).toBeNull();
            expect(LeaderHall.getCachedDecrypted('nonexistent-id')).toBeNull();

            LeaderHall.setCachedDecrypted('', 'Some text');
            LeaderHall.setCachedDecrypted('valid-id', '');
            expect(LeaderHall.getCachedDecrypted('valid-id')).toBeNull();
        });
    });

    describe('3. Legacy E2EE Cache Purge Routine (purgeLegacyE2EECache)', () => {
        it('purges all residual gm_e2ee_cache_ keys from localStorage while preserving legitimate keys', () => {
            // Seed localStorage with legacy plaintext leaks and legitimate session state
            localStorage.setItem('gm_e2ee_cache_msg_001', 'Leaked message 1');
            localStorage.setItem('gm_e2ee_cache_msg_002', 'Leaked message 2');
            localStorage.setItem('gm_e2ee_cache_important_intel', 'Top secret battle plan');
            localStorage.setItem('gm_user', 'HawkEye');
            localStorage.setItem('gm_role', 'R5');
            localStorage.setItem('gm_current_guild', 'ALPHA');
            localStorage.setItem('gm_account', JSON.stringify({ id: 'acc-1', guild: 'ALPHA' }));

            expect(localStorage.length).toBe(7);

            // Execute the purge routine
            LeaderHall.purgeLegacyE2EECache();

            // All residual E2EE cache keys must be eradicated
            expect(localStorage.getItem('gm_e2ee_cache_msg_001')).toBeNull();
            expect(localStorage.getItem('gm_e2ee_cache_msg_002')).toBeNull();
            expect(localStorage.getItem('gm_e2ee_cache_important_intel')).toBeNull();

            // Legitimate keys must remain intact
            expect(localStorage.getItem('gm_user')).toBe('HawkEye');
            expect(localStorage.getItem('gm_role')).toBe('R5');
            expect(localStorage.getItem('gm_current_guild')).toBe('ALPHA');
            expect(localStorage.getItem('gm_account')).toContain('ALPHA');
            expect(localStorage.length).toBe(4);
        });

        it('handles empty localStorage or missing localStorage without throwing exceptions', () => {
            expect(() => LeaderHall.purgeLegacyE2EECache()).not.toThrow();
        });

        it('triggers purgeLegacyE2EECache upon LeaderHall.load()', async () => {
            localStorage.setItem('gm_e2ee_cache_stale_1', 'old text');
            document.body.innerHTML = '<div id="tab-leader-hall"></div>';

            await LeaderHall.load();

            expect(localStorage.getItem('gm_e2ee_cache_stale_1')).toBeNull();
        });
    });

    describe('4. Non-Regression on Rich Messaging & Decryption Bridge', () => {
        it('parseMessagePayload works seamlessly with in-memory cached payloads', () => {
            const rawPayload = JSON.stringify({
                text: 'Defense squad assemble!',
                replyTo: { id: 'msg-42', sender: 'Ashke', guild: 'BABE', snippet: 'Base alert' }
            });

            LeaderHall.setCachedDecrypted('msg-100', rawPayload);
            const cached = LeaderHall.getCachedDecrypted('msg-100');
            const parsed = LeaderHall.parseMessagePayload(cached);

            expect(parsed.text).toBe('Defense squad assemble!');
            expect(parsed.replyTo.sender).toBe('Ashke');
        });
    });
});
