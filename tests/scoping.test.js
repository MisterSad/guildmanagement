import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { canWriteGuild } from '../src/core/auth/roles';
import { eventScoringKey, sessionDateFromId } from '../src/core/config/events';
import { getAppState, patchAppState, resetAppState } from '../src/core/state/app-state';

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
    resetAppState();
});

afterEach(() => {
    localStorage.clear();
    resetAppState();
});

describe('tenancy sandbox contract', () => {
    it('guild_admin can write only to their own guild', () => {
        setStorage({ gm_role: 'guild_admin' });
        patchAppState({ currentGuildRestriction: 'OMEGA' });
        expect(canWriteGuild('OMEGA')).toBe(true);
        expect(canWriteGuild('ALPHA')).toBe(false);
        expect(canWriteGuild('YARR')).toBe(false);
        expect(canWriteGuild('DEMO')).toBe(false);
    });

    it('super_admin can write to every guild', () => {
        setStorage({ gm_role: 'super_admin' });
        patchAppState({ currentGuildRestriction: null });
        expect(canWriteGuild('ALPHA')).toBe(true);
        expect(canWriteGuild('OMEGA')).toBe(true);
        expect(canWriteGuild('YARR')).toBe(true);
        expect(canWriteGuild('DEMO')).toBe(true);
    });

    it('member can never write tenant data', () => {
        setStorage({ gm_role: 'member' });
        expect(canWriteGuild('ALPHA')).toBe(false);
        expect(canWriteGuild('OMEGA')).toBe(false);
    });

    it('guildsList defaults to empty, never a stale hard-coded list', () => {
        expect(Array.isArray(getAppState().guildsList)).toBe(true);
        expect(getAppState().guildsList).toHaveLength(0);
    });
});

describe('scoring key sandbox (once per week for weekly events)', () => {
    it('Arms Race Stage A and B are separate events keyed by session', () => {
        const a = eventScoringKey('ARMS RACE STAGE A', 'ARA-20260805', '2026-08-03');
        const b = eventScoringKey('ARMS RACE STAGE B', 'ARB-20260805', '2026-08-03');
        const a2 = eventScoringKey('ARMS RACE STAGE A', 'ARA-20260808', '2026-08-03');
        // Each stage session counts once, so 2 A + 2 B in a week = 4 events.
        expect(a).toBe('Arms Race|ARA-20260805');
        expect(b).toBe('Arms Race|ARB-20260805');
        expect(a2).toBe('Arms Race|ARA-20260808');
        expect(a).not.toBe(b);
        expect(b).not.toBe(a2);
    });

    it('Shadowfront squad 1 and 2 of the same week collapse into one key', () => {
        expect(eventScoringKey('Shadowfront', 'SF1-20260802', '2026-07-27'))
            .toBe('Shadowfront|2026-07-27');
        expect(eventScoringKey('Shadowfront', 'SF2-20260802', '2026-07-27'))
            .toBe('Shadowfront|2026-07-27');
    });

    it('each DTR session is its own scoring unit', () => {
        expect(eventScoringKey('Defend Trade Route', 'DTR-20260804', '2026-08-03'))
            .toBe('DTR|DTR-20260804');
        expect(eventScoringKey('Defend Trade Route', 'DTR-20260812', '2026-08-10'))
            .toBe('DTR|DTR-20260812');
    });

    it('sessionDateFromId extracts the battle date from a readable id', () => {
        const d = sessionDateFromId('SF1-20260802');
        expect(d).not.toBeNull();
        expect(d.toISOString().slice(0, 10)).toBe('2026-08-02');
        expect(sessionDateFromId('SVS-2026-W32')).toBeNull();
        expect(sessionDateFromId(null)).toBeNull();
    });
});
