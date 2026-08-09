import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import '../scouting.js';

const SCOUT = window.GM_SCOUTING;

describe('GM_SCOUTING roster parser', () => {
    it('parses "pseudo,power" lines', () => {
        const rows = SCOUT.parseRoster('Alpha, 1000000\nBeta, 2000000');
        expect(rows).toEqual([
            { pseudo: 'Alpha', power: 1000000 },
            { pseudo: 'Beta', power: 2000000 }
        ]);
    });

    it('parses "pseudo - power" and "pseudo: power" formats', () => {
        expect(SCOUT.parseRoster('Gamma - 5000\nDelta: 7500')).toEqual([
            { pseudo: 'Gamma', power: 5000 },
            { pseudo: 'Delta', power: 7500 }
        ]);
    });

    it('ignores blank lines and unparsable lines', () => {
        const rows = SCOUT.parseRoster('Alpha,1000000\n\nnot a roster line\nBeta,2000000');
        expect(rows).toHaveLength(2);
    });

    it('strips quotes around pseudos and thousand separators in power', () => {
        const rows = SCOUT.parseRoster('"Alpha", 1,000,000');
        expect(rows).toEqual([{ pseudo: 'Alpha', power: 1000000 }]);
    });

    it('returns empty for empty input', () => {
        expect(SCOUT.parseRoster('')).toEqual([]);
        expect(SCOUT.parseRoster('   ')).toEqual([]);
    });
});
