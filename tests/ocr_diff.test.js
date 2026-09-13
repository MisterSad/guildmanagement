import { describe, it, expect, beforeEach } from 'vitest';

const GM = window.GM;
expect(GM).toBeTruthy();

describe('calculateStringSimilarity & levenshteinDistance', () => {
    it('computes exact distance and similarity for identical strings', () => {
        expect(GM.levenshteinDistance('HawkEye', 'HawkEye')).toBe(0);
        expect(GM.calculateStringSimilarity('HawkEye', 'HawkEye')).toBe(1.0);
    });

    it('computes expected distance for minor typos', () => {
        expect(GM.levenshteinDistance('HawkEye', 'HawkEy')).toBe(1);
        expect(GM.levenshteinDistance('Commander', 'Commandr')).toBe(1);
    });

    it('computes high similarity for OCR typos (>= 0.75)', () => {
        const sim = GM.calculateStringSimilarity('HawkEye', 'HawkEy');
        expect(sim).toBeGreaterThanOrEqual(0.75);
    });

    it('computes low similarity for completely different names', () => {
        const sim = GM.calculateStringSimilarity('HawkEye', 'VanguardLeader');
        expect(sim).toBeLessThan(0.5);
    });

    it('handles empty or null strings safely without throwing', () => {
        expect(GM.calculateStringSimilarity('', 'HawkEye')).toBe(0);
        expect(GM.calculateStringSimilarity(null, 'HawkEye')).toBe(0);
        expect(GM.levenshteinDistance('', '')).toBe(0);
        expect(GM.levenshteinDistance(null, 'abc')).toBe(3);
    });
});

describe('findBestMatchingMember', () => {
    const sampleRoster = [
        { pseudo: 'HawkEye', uid: '1001', role: 'R5', overall_power: 150000000 },
        { pseudo: 'StarWarrior', uid: '1002', role: 'R4', overall_power: 120000000 },
        { pseudo: 'Shadow_Ninja', uid: '1003', role: 'R3', overall_power: 90000000 },
        { pseudo: 'AcePilot', uid: '1004', role: 'R2', overall_power: 80000000 },
    ];

    it('matches exact username with 1.0 score', () => {
        const match = GM.findBestMatchingMember('HawkEye', sampleRoster, '[PR1M]');
        expect(match).toBeTruthy();
        expect(match.matchType).toBe('exact');
        expect(match.score).toBe(1.0);
        expect(match.member.pseudo).toBe('HawkEye');
    });

    it('matches username stripped of guild tag with clean_tag', () => {
        const match = GM.findBestMatchingMember('[PR1M] StarWarrior', sampleRoster, '[PR1M]');
        expect(match).toBeTruthy();
        expect(match.member.pseudo).toBe('StarWarrior');
        expect(match.score).toBeGreaterThanOrEqual(0.95);
    });

    it('matches normalized alphanumeric strings (symbols stripped)', () => {
        const match = GM.findBestMatchingMember('Shadow-Ninja', sampleRoster, '[PR1M]');
        expect(match).toBeTruthy();
        expect(match.member.pseudo).toBe('Shadow_Ninja');
    });

    it('matches fuzzy OCR typo (>= 0.75)', () => {
        const match = GM.findBestMatchingMember('AcePil0t', sampleRoster, '[PR1M]');
        expect(match).toBeTruthy();
        expect(match.member.pseudo).toBe('AcePilot');
        expect(match.matchType).toBe('fuzzy');
    });

    it('returns null when no member matches threshold', () => {
        const match = GM.findBestMatchingMember('UnrelatedNewPlayer', sampleRoster, '[PR1M]');
        expect(match).toBeNull();
    });

    it('returns null on empty inputs', () => {
        expect(GM.findBestMatchingMember('', sampleRoster)).toBeNull();
        expect(GM.findBestMatchingMember('HawkEye', [])).toBeNull();
        expect(GM.findBestMatchingMember('HawkEye', null)).toBeNull();
    });
});

describe('categorizeOcrDiff (Three-Section Diff Logic)', () => {
    const sampleRoster = [
        { pseudo: 'HawkEye', uid: '1001', role: 'R5', overall_power: 150000000, tech_power: 20000000 },
        { pseudo: 'StarWarrior', uid: '1002', role: 'R4', overall_power: 120000000, tech_power: 18000000 },
        { pseudo: 'OldMemberLeaving', uid: '1003', role: 'R1', overall_power: 50000000, tech_power: 5000000 },
        { pseudo: 'SteadyPilot', uid: '1004', role: 'R2', overall_power: 80000000, tech_power: 10000000 }
    ];

    it('categorizes exact updates, unchanged, new recruits, and removed members', () => {
        const ocrPlayers = [
            { pseudo: 'HawkEye', score: 160000000 },                 // existing -> update
            { pseudo: 'StarWarrior', score: 120000000 },             // existing -> unchanged
            { pseudo: 'NewRecruitAlpha', score: 95000000, uid: '2001' } // new
            // SteadyPilot is omitted from OCR screenshots -> removed
            // OldMemberLeaving is omitted -> removed
        ];

        const diff = GM.categorizeOcrDiff(ocrPlayers, sampleRoster, '[PR1M]', 'overall_power', false);

        expect(diff.existing).toHaveLength(2);
        expect(diff.existing[0].status).toBe('update');
        expect(diff.existing[0].currentVal).toBe(150000000);
        expect(diff.existing[0].newVal).toBe(160000000);
        expect(diff.existing[1].status).toBe('unchanged');

        expect(diff.new).toHaveLength(1);
        expect(diff.new[0].status).toBe('new');
        expect(diff.new[0].effectivePseudo).toBe('NewRecruitAlpha');
        expect(diff.new[0].uid).toBe('2001');

        expect(diff.removed).toHaveLength(2);
        const removedPseudos = diff.removed.map(r => r.pseudo);
        expect(removedPseudos).toContain('OldMemberLeaving');
        expect(removedPseudos).toContain('SteadyPilot');
    });

    it('handles fuzzy matching so OCR typos reconcile to existing members without false removals', () => {
        const ocrPlayers = [
            { pseudo: 'HawkEy', score: 155000000 }, // Typo for HawkEye -> reconciled
            { pseudo: 'StarWarrior', score: 120000000 },
            { pseudo: 'SteadyPilot', score: 80000000 }
        ];

        const diff = GM.categorizeOcrDiff(ocrPlayers, sampleRoster, '[PR1M]', 'overall_power', false);

        expect(diff.existing).toHaveLength(3);
        const hawkItem = diff.existing.find(e => e.member.pseudo === 'HawkEye');
        expect(hawkItem).toBeTruthy();
        expect(hawkItem.status).toBe('reconciled');
        expect(hawkItem.effectivePseudo).toBe('HawkEye');

        // HawkEye must NOT be in removed
        const removedPseudos = diff.removed.map(r => r.pseudo);
        expect(removedPseudos).not.toContain('HawkEye');
        expect(removedPseudos).toEqual(['OldMemberLeaving']);
    });

    it('marks other-guild players in multi-guild scan with status other_guild and does not mark matched roster as removed', () => {
        const ocrPlayers = [
            { pseudo: '[ENEMY] UnknownPlayer', score: 200000000 }, // other guild / no match
            { pseudo: 'HawkEye', score: 150000000 }
        ];

        const diff = GM.categorizeOcrDiff(ocrPlayers, sampleRoster, '[PR1M]', 'fleet_rating', true);

        expect(diff.new).toHaveLength(1);
        expect(diff.new[0].status).toBe('other_guild');

        expect(diff.existing).toHaveLength(1);
        expect(diff.existing[0].member.pseudo).toBe('HawkEye');

        // HawkEye is seen, others are removed
        expect(diff.removed.map(r => r.pseudo)).not.toContain('HawkEye');
    });

    it('handles empty roster cleanly (cold-start path: everything in new, removed empty)', () => {
        const ocrPlayers = [
            { pseudo: 'FoundingLeader', score: 100000000, uid: '1001' },
            { pseudo: 'FoundingOfficer', score: 80000000, uid: '1002' }
        ];

        const diff = GM.categorizeOcrDiff(ocrPlayers, [], '[PR1M]', 'overall_power', false);

        expect(diff.existing).toEqual([]);
        expect(diff.removed).toEqual([]);
        expect(diff.new).toHaveLength(2);
        expect(diff.new[0].status).toBe('new');
        expect(diff.new[1].status).toBe('new');
    });

    it('guards safely on null or empty OCR players', () => {
        expect(GM.categorizeOcrDiff([], sampleRoster)).toEqual({ existing: [], new: [], removed: [], unknown: [] });
        expect(GM.categorizeOcrDiff(null, sampleRoster)).toEqual({ existing: [], new: [], removed: [], unknown: [] });
        expect(GM.categorizeOcrDiff(undefined, sampleRoster)).toEqual({ existing: [], new: [], removed: [], unknown: [] });
    });
});

describe('computeOcrRosterDelta', () => {
    it('computes delta with new additions only', () => {
        const delta = GM.computeOcrRosterDelta(60, 3, 0);
        expect(delta).toEqual({
            before: 60,
            after: 63,
            added: 3,
            removed: 0
        });
    });

    it('computes delta with additions and removals', () => {
        const delta = GM.computeOcrRosterDelta(60, 2, 5);
        expect(delta).toEqual({
            before: 60,
            after: 57,
            added: 2,
            removed: 5
        });
    });

    it('computes delta with zero selections (unchanged)', () => {
        const delta = GM.computeOcrRosterDelta(60, 0, 0);
        expect(delta).toEqual({
            before: 60,
            after: 60,
            added: 0,
            removed: 0
        });
    });

    it('computes delta from empty roster cold-start', () => {
        const delta = GM.computeOcrRosterDelta(0, 45, 0);
        expect(delta).toEqual({
            before: 0,
            after: 45,
            added: 45,
            removed: 0
        });
    });

    it('clamps negative after values to 0 defensively', () => {
        const delta = GM.computeOcrRosterDelta(5, 0, 10);
        expect(delta.after).toBe(0);
        expect(delta.removed).toBe(10);
    });
});

describe('validateUid Interplay', () => {
    it('accepts numeric strings within the 6-10 digit FGF UID range', () => {
        expect(GM.validateUid('123456')).toBeNull();
        expect(GM.validateUid('9999999999')).toBeNull();
        expect(GM.validateUid('999999999')).toBeNull();
    });

    it('rejects numeric strings outside the 6-10 digit range', () => {
        expect(GM.validateUid('12345')).toBe('validation_uid_too_short');
        expect(GM.validateUid('12345678901234567890')).toBe('validation_uid_too_long');
    });

    it('rejects TEMP-style generated UIDs', () => {
        expect(GM.validateUid('TEMP-abc12345')).toBe('validation_uid_not_numeric');
        expect(GM.validateUid('TEMP-998877')).toBe('validation_uid_not_numeric');
    });

    it('rejects non-numeric characters and spaces', () => {
        expect(GM.validateUid('user123')).toBe('validation_uid_not_numeric');
        expect(GM.validateUid('123 456')).toBe('validation_uid_not_numeric');
        expect(GM.validateUid('12-34')).toBe('validation_uid_not_numeric');
    });

    it('rejects strings longer than 20 digits', () => {
        expect(GM.validateUid('123456789012345678901')).toBe('validation_uid_too_long');
    });

    it('accepts empty or null as valid (optional)', () => {
        expect(GM.validateUid('')).toBeNull();
        expect(GM.validateUid(null)).toBeNull();
        expect(GM.validateUid(undefined)).toBeNull();
    });
});

describe('upsertPlayerMetrics Bridge Definition', () => {
    it('is exported as a function on window.GM', () => {
        expect(typeof GM.upsertPlayerMetrics).toBe('function');
    });
});

describe('Cold-Start i18n Keys', () => {
    it('provides valid English translations for empty roster cold-start CTA', () => {
        const t = window.GM_I18N.t;
        expect(t('empty_members_roster_title')).toBe('Your roster is empty');
        expect(t('empty_members_roster_desc')).toContain('Import all members in one step');
        expect(t('empty_members_roster_cta')).toBe('Members OCR');
        expect(t('empty_members')).toBe('No members registered');
    });
});

describe('categorizeOcrDiff Mode Semantics (v126.0 Members OCR vs Metric Scanners)', () => {
    const sampleRoster = [
        { pseudo: 'HawkEye', uid: '1001', role: 'R5', overall_power: 150000000 },
        { pseudo: 'StarWarrior', uid: '1002', role: 'R4', overall_power: 120000000 },
    ];

    it('members mode (default): categorizes into existing, new, and removed with empty unknown', () => {
        const ocrPlayers = [
            { pseudo: 'HawkEye', score: 160000000 },
            { pseudo: 'NewRecruit', score: 50000000 },
        ];
        const diff = GM.categorizeOcrDiff(ocrPlayers, sampleRoster, '', 'overall_power', false, 'members');
        expect(diff.existing).toHaveLength(1);
        expect(diff.existing[0].effectivePseudo).toBe('HawkEye');
        expect(diff.new).toHaveLength(1);
        expect(diff.new[0].effectivePseudo).toBe('NewRecruit');
        expect(diff.removed).toHaveLength(1);
        expect(diff.removed[0].pseudo).toBe('StarWarrior');
        expect(diff.unknown).toEqual([]);
    });

    it('metric mode: returns unknown bucket, empty new, and empty removed', () => {
        const ocrPlayers = [
            { pseudo: 'HawkEye', score: 160000000 },
            { pseudo: 'UnregisteredPlayer', score: 75000000 },
        ];
        const diff = GM.categorizeOcrDiff(ocrPlayers, sampleRoster, '', 'overall_power', false, 'metric');
        expect(diff.existing).toHaveLength(1);
        expect(diff.existing[0].effectivePseudo).toBe('HawkEye');
        expect(diff.new).toEqual([]);
        expect(diff.removed).toEqual([]); // Metric screenshots may be partial; never propose removals
        expect(diff.unknown).toHaveLength(1);
        expect(diff.unknown[0].status).toBe('not_in_roster');
        expect(diff.unknown[0].effectivePseudo).toBe('UnregisteredPlayer');
    });

    it('empty players input returns empty arrays for all 4 buckets', () => {
        const diff = GM.categorizeOcrDiff([], sampleRoster, '', 'overall_power', false, 'metric');
        expect(diff).toEqual({ existing: [], new: [], removed: [], unknown: [] });
    });

    it('carries a Members-OCR-detected rank through on both existing and new members (Video OCR rank assignment)', () => {
        const ocrPlayers = [
            { pseudo: 'HawkEye', score: 160000000, rank: 'R3' }, // detected rank differs from current R5 — commit-time logic must ignore this, protection is enforced by the caller, not this function
            { pseudo: 'StarWarrior', score: 120000000, rank: 'R4' },
            { pseudo: 'FreshRecruit', score: 20000000, rank: 'R2' },
            { pseudo: 'NoHeaderSeenYet', score: 5000000, rank: null },
        ];
        const diff = GM.categorizeOcrDiff(ocrPlayers, sampleRoster, '', 'overall_power', false, 'members');

        const hawkEye = diff.existing.find(e => e.effectivePseudo === 'HawkEye');
        expect(hawkEye.ocrPlayer.rank).toBe('R3');
        expect(hawkEye.member.role).toBe('R5'); // caller must check this before ever applying rank

        const starWarrior = diff.existing.find(e => e.effectivePseudo === 'StarWarrior');
        expect(starWarrior.ocrPlayer.rank).toBe('R4');
        expect(starWarrior.member.role).toBe('R4');

        const freshRecruit = diff.new.find(n => n.effectivePseudo === 'FreshRecruit');
        expect(freshRecruit.ocrPlayer.rank).toBe('R2');

        const noHeader = diff.new.find(n => n.effectivePseudo === 'NoHeaderSeenYet');
        expect(noHeader.ocrPlayer.rank).toBeNull();
    });
});
