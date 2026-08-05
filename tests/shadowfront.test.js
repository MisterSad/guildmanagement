import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../gm-utils.js';
import '../i18n.js';
import '../shadowfront.js';

const GM = window.GM;
const SF = window.GM_SHADOWFRONT;

const MEMBERS = [
    { pseudo: 'Alpha', uid: 'uid1', overall_power: 100000000 },
    { pseudo: 'Bravo', uid: 'uid2', overall_power: 50000000 },
    { pseudo: 'Charlie', uid: 'uid3', overall_power: 10000000 },
    { pseudo: 'Delta', uid: 'uid4', overall_power: 75000000 },
];

let tables = {};

function chained(value) {
    const chain = {
        select: () => chain,
        order: () => chain,
        eq: () => chain,
        in: () => chain,
        limit: () => chain,
        single: () => chain,
        maybeSingle: () => chained(value && value[0] ? value[0] : null),
        then: (resolve) => resolve({ data: value, error: null })
    };
    return chain;
}

function fromMock(table) {
    return chained(tables[table] || []);
}

function area() {
    return document.getElementById('event-shadowfront').querySelector('.event-participants-area');
}

function stepByLabel(label) {
    return Array.prototype.find.call(
        area().querySelectorAll('.sf-step'),
        (el) => el.textContent.includes(label)
    );
}

beforeEach(() => {
    document.body.innerHTML = '<div id="event-shadowfront"><div class="event-participants-area"></div></div>';
    localStorage.setItem('gm_role', 'guild_admin');
    window.currentGuildRestriction = 'ALPHA';
    GM.showToast = vi.fn();
    tables = {
        event_status: [
            { event_name: 'Shadowfront Squad 1', is_active: true, session_id: 'S1', start_at: '2026-08-02T12:00:00Z' },
            { event_name: 'Shadowfront Squad 2', is_active: false, session_id: null, start_at: null },
        ],
        guild_members: MEMBERS,
        shadowfront_squads: [
            { pseudo: 'Alpha', session_id: 'S1', squad: 'squad1', role: 'participant', is_commander: true, week_start: '2026-08-02' },
        ],
        event_participants: [
            { pseudo: 'Alpha', event_name: 'Shadowfront', session_id: 'S1', participated: 0, late: false, excused: false, sub_present: false, week_start: '2026-08-02' },
        ],
        shadowfront_signups: [
            { pseudo: 'Alpha', availability: 'squad1', week_start: '2026-08-02' },
            { pseudo: 'Bravo', availability: 'squad2', week_start: '2026-08-02' },
            { pseudo: 'Delta', availability: 'squad1', week_start: '2026-08-02' },
        ],
    };
    GM.db = { from: fromMock, functions: { invoke: async () => ({ data: { ok: false, error: 'n/a' } }) } };
});

afterEach(() => {
    GM.db = null;
    document.body.innerHTML = '';
    delete window.currentGuildRestriction;
    vi.unstubAllGlobals();
});

describe('GM_SHADOWFRONT UI/UX', () => {
    it('renders a 3-step stepper without the running tab or approve flow', async () => {
        await SF.load();
        const text = area().textContent;
        expect(text).toContain('1. Availability');
        expect(text).toContain('2. Squad Composition');
        expect(text).toContain('3. Participation Tracking');
        expect(text).not.toContain('Running Tab');
        expect(text).not.toContain('Approve');
    });

    it('shows the availability step with both squad pools and bulk actions', async () => {
        await SF.load();
        const text = area().textContent;
        expect(text).toContain('Squad One — Available');
        expect(text).toContain('Squad Two — Available');
        expect(text).toContain('Add to Squad One');
        expect(text).toContain('Add to Squad Two');
        expect(text).toContain('0 selected');
        expect(text).toContain('Alpha');
        expect(text).toContain('Bravo');
        expect(text).toContain('Charlie');
    });

    it('composition step shows declared pool, confirmed squads and sorting controls', async () => {
        await SF.load();
        stepByLabel('2. Squad Composition').click();
        const text = area().textContent;
        expect(text).toContain('Available (unconfirmed)');
        expect(text).toContain('Main Participants');
        expect(text).toContain('Substitutes');
        expect(text).toContain('Delta');   // declared for squad1, not confirmed yet
        expect(text).toContain('Alpha');   // confirmed participant
        expect(text).toContain('Avg rate');
        expect(text).toContain('Rate');
        expect(text).toContain('Power');
        expect(text).toContain('Share on Discord');
    });

    it('unlocks tracking when a squad is active and offers bulk actions', async () => {
        await SF.load();
        stepByLabel('3. Participation Tracking').click();
        const text = area().textContent;
        expect(text).toContain('All present');
        expect(text).toContain('All absent');
        expect(text).toContain('Alpha');
        expect(text).not.toContain('Approve');
    });

    it('shares the composition on Discord through the shadowfront webhook', async () => {
        tables.guild_config = [{ value: 'https://discord.test/hook' }];
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock);

        await SF.load();
        stepByLabel('2. Squad Composition').click();
        area().querySelector('.sf-share-discord-btn').click();
        await new Promise((r) => setTimeout(r, 0));

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(GM.showToast).toHaveBeenCalledWith('Composition sent to Discord.', 'success');
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        // Only the active squad is shared: embed title carries the squad name,
        // with just two fields (participants + reserves).
        expect(body.embeds[0].title).toContain('Squad One');
        expect(body.embeds[0].fields).toHaveLength(2);
        expect(body.embeds[0].fields[0].value).toContain('👑 Alpha');
        expect(body.embeds[0].fields[1].value).toBe('None yet');
    });
});
