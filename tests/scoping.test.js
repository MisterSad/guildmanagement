import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import '../gm-utils.js';

const GM = window.GM;

// ── Contrat sandbox (SaaS) ────────────────────────────────────────────────
// Chaque tenant est une sandbox de données : toute lecture/écriture sur les
// tables tenant doit être scopée par la guilde active, et la clé de scoring
// regroupe les événements hebdomadaires (Arms, Shadowfront) une fois par
// semaine quel que soit le nombre de sessions.

function setStorage(map) {
    Object.keys(map).forEach((k) => localStorage.setItem(k, map[k]));
}

beforeEach(() => {
    localStorage.clear();
    delete window.currentGuildRestriction;
});

afterEach(() => {
    localStorage.clear();
    delete window.currentGuildRestriction;
});

describe('tenancy sandbox contract', () => {
    it('guild_admin can write only to their own guild', () => {
        setStorage({ gm_role: 'guild_admin' });
        window.currentGuildRestriction = 'OMEGA';
        expect(GM.canWriteGuild('OMEGA')).toBe(true);
        expect(GM.canWriteGuild('ALPHA')).toBe(false);
        expect(GM.canWriteGuild('YARR')).toBe(false);
        expect(GM.canWriteGuild('DEMO')).toBe(false);
    });

    it('super_admin can write to every guild', () => {
        setStorage({ gm_role: 'super_admin' });
        window.currentGuildRestriction = null;
        expect(GM.canWriteGuild('ALPHA')).toBe(true);
        expect(GM.canWriteGuild('OMEGA')).toBe(true);
        expect(GM.canWriteGuild('YARR')).toBe(true);
        expect(GM.canWriteGuild('DEMO')).toBe(true);
    });

    it('member can never write tenant data', () => {
        setStorage({ gm_role: 'member' });
        expect(GM.canWriteGuild('ALPHA')).toBe(false);
        expect(GM.canWriteGuild('OMEGA')).toBe(false);
    });

    it('guildsList defaults to empty, never a stale hard-coded list', () => {
        expect(Array.isArray(window.guildsList)).toBe(true);
        expect(window.guildsList).toHaveLength(0);
    });
});

describe('scoring key sandbox (once per week for weekly events)', () => {
    it('Arms Race Stage A and B are separate events keyed by session', () => {
        const a = GM.eventScoringKey('ARMS RACE STAGE A', 'ARA-20260805', '2026-08-03');
        const b = GM.eventScoringKey('ARMS RACE STAGE B', 'ARB-20260805', '2026-08-03');
        const a2 = GM.eventScoringKey('ARMS RACE STAGE A', 'ARA-20260808', '2026-08-03');
        // Each stage session counts once, so 2 A + 2 B in a week = 4 events.
        expect(a).toBe('Arms Race|ARA-20260805');
        expect(b).toBe('Arms Race|ARB-20260805');
        expect(a2).toBe('Arms Race|ARA-20260808');
        expect(a).not.toBe(b);
        expect(b).not.toBe(a2);
    });

    it('Shadowfront squad 1 and 2 of the same week collapse into one key', () => {
        expect(GM.eventScoringKey('Shadowfront', 'SF1-20260802', '2026-07-27'))
            .toBe('Shadowfront|2026-07-27');
        expect(GM.eventScoringKey('Shadowfront', 'SF2-20260802', '2026-07-27'))
            .toBe('Shadowfront|2026-07-27');
    });

    it('each DTR session is its own scoring unit', () => {
        expect(GM.eventScoringKey('Defend Trade Route', 'DTR-20260804', '2026-08-03'))
            .toBe('DTR|DTR-20260804');
        expect(GM.eventScoringKey('Defend Trade Route', 'DTR-20260812', '2026-08-10'))
            .toBe('DTR|DTR-20260812');
    });

    it('sessionDateFromId extracts the battle date from a readable id', () => {
        const d = GM.sessionDateFromId('SF1-20260802');
        expect(d).not.toBeNull();
        expect(d.toISOString().slice(0, 10)).toBe('2026-08-02');
        expect(GM.sessionDateFromId('SVS-2026-W32')).toBeNull();
        expect(GM.sessionDateFromId(null)).toBeNull();
    });
});
