import { describe, it, expect } from 'vitest';

const GM = window.GM;

describe('Player Game UID Validation and Status Detection', () => {
    describe('GM.getUidStatus()', () => {
        it('identifies valid 6 to 10 digit in-game UIDs', () => {
            expect(GM.getUidStatus('123456')).toEqual({
                valid: true,
                status: 'valid',
                label: 'Valid Game UID',
                reason: null
            });
            expect(GM.getUidStatus('1917131')).toEqual({
                valid: true,
                status: 'valid',
                label: 'Valid Game UID',
                reason: null
            });
            expect(GM.getUidStatus('90000002')).toEqual({
                valid: true,
                status: 'valid',
                label: 'Valid Game UID',
                reason: null
            });
            expect(GM.getUidStatus('1234567890')).toEqual({
                valid: true,
                status: 'valid',
                label: 'Valid Game UID',
                reason: null
            });
        });

        it('identifies temporary import UIDs (TEMP-*, TMP-*)', () => {
            const res1 = GM.getUidStatus('TEMP-abc12345');
            expect(res1.valid).toBe(false);
            expect(res1.status).toBe('temp');
            expect(res1.label).toBe('Temporary UID');

            const res2 = GM.getUidStatus('temp_998877');
            expect(res2.valid).toBe(false);
            expect(res2.status).toBe('temp');

            const res3 = GM.getUidStatus('TMP-123456');
            expect(res3.valid).toBe(false);
            expect(res3.status).toBe('temp');

            const res4 = GM.getUidStatus('TEMP');
            expect(res4.valid).toBe(false);
            expect(res4.status).toBe('temp');
        });

        it('identifies missing or placeholder UIDs', () => {
            expect(GM.getUidStatus(null)).toEqual({
                valid: false,
                status: 'missing',
                label: 'Missing UID',
                reason: 'UID is not set'
            });
            expect(GM.getUidStatus(undefined).status).toBe('missing');
            expect(GM.getUidStatus('').status).toBe('missing');
            expect(GM.getUidStatus('   ').status).toBe('missing');
            expect(GM.getUidStatus('-').status).toBe('missing');
        });

        it('identifies non-numeric invalid formats', () => {
            const res = GM.getUidStatus('player_123');
            expect(res.valid).toBe(false);
            expect(res.status).toBe('nan');
            expect(res.label).toBe('Invalid Format');
        });

        it('identifies out-of-range lengths (less than 6 or greater than 10 digits)', () => {
            const tooShort = GM.getUidStatus('12345');
            expect(tooShort.valid).toBe(false);
            expect(tooShort.status).toBe('length');

            const tooLong = GM.getUidStatus('12345678901');
            expect(tooLong.valid).toBe(false);
            expect(tooLong.status).toBe('length');
        });
    });

    describe('GM.isInvalidOrTempUid()', () => {
        it('returns false for valid UIDs', () => {
            expect(GM.isInvalidOrTempUid('1917131')).toBe(false);
            expect(GM.isInvalidOrTempUid('123456')).toBe(false);
        });

        it('returns true for temp, missing, or invalid UIDs', () => {
            expect(GM.isInvalidOrTempUid('TEMP-x7y8z9')).toBe(true);
            expect(GM.isInvalidOrTempUid(null)).toBe(true);
            expect(GM.isInvalidOrTempUid('')).toBe(true);
            expect(GM.isInvalidOrTempUid('abc')).toBe(true);
            expect(GM.isInvalidOrTempUid('123')).toBe(true);
        });
    });

    describe('Roster Sorting by Temp/Invalid UID First', () => {
        it('sorts members with temporary or invalid UIDs to the top', () => {
            const members = [
                { pseudo: 'PlayerA', uid: '1917131', overall_power: 100000000 },
                { pseudo: 'PlayerB', uid: 'TEMP-abc123', overall_power: 50000000 },
                { pseudo: 'PlayerC', uid: '90000002', overall_power: 80000000 },
                { pseudo: 'PlayerD', uid: null, overall_power: 70000000 }
            ];

            const sorted = members.slice().sort((a, b) => {
                const aInv = GM.isInvalidOrTempUid(a.uid);
                const bInv = GM.isInvalidOrTempUid(b.uid);
                if (aInv && !bInv) return -1;
                if (!aInv && bInv) return 1;
                return (b.overall_power || 0) - (a.overall_power || 0);
            });

            // PlayerD (70M, null UID) and PlayerB (50M, TEMP UID) must be first (ordered by power desc among invalids)
            expect(sorted[0].pseudo).toBe('PlayerD');
            expect(sorted[1].pseudo).toBe('PlayerB');
            // Then valid UIDs by power desc: PlayerA (100M), PlayerC (80M)
            expect(sorted[2].pseudo).toBe('PlayerA');
            expect(sorted[3].pseudo).toBe('PlayerC');
        });
    });

    describe('Roster Filtering by TEMP_UID', () => {
        it('filters only members with temporary or missing UIDs', () => {
            const members = [
                { pseudo: 'PlayerA', uid: '1917131' },
                { pseudo: 'PlayerB', uid: 'TEMP-abc123' },
                { pseudo: 'PlayerC', uid: '90000002' },
                { pseudo: 'PlayerD', uid: '' }
            ];

            const filtered = members.filter(m => GM.isInvalidOrTempUid(m.uid));
            expect(filtered.map(m => m.pseudo)).toEqual(['PlayerB', 'PlayerD']);
        });
    });
});
