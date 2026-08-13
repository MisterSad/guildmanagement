import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../gm-utils.js';
import '../i18n.js';
import '../shadowfront.js';

const GM = window.GM;
const SF = window.GM_SHADOWFRONT;

const MEMBERS = [
    { pseudo: 'Alpha', guild: 'ALPHA', uid: 'uid1', overall_power: 100000000 },
    { pseudo: 'Bravo', guild: 'ALPHA', uid: 'uid2', overall_power: 50000000 },
    { pseudo: 'Charlie', guild: 'ALPHA', uid: 'uid3', overall_power: 10000000 },
    { pseudo: 'Delta', guild: 'ALPHA', uid: 'uid4', overall_power: 75000000 },
];

let tables = {};

function chained(value) {
    const filters = [];
    const chain = {
        select: () => chain,
        order: () => chain,
        eq: (field, val) => { filters.push(r => r[field] === val); return chain; },
        in: (field, list) => { filters.push(r => list.indexOf(r[field]) !== -1); return chain; },
        limit: () => chain,
        single: () => chain,
        maybeSingle: () => ({
            then: (resolve) => {
                let res = (value || []).slice();
                filters.forEach(f => { res = res.filter(f); });
                return Promise.resolve({ data: res[0] || null, error: null }).then(resolve);
            }
        }),
        then: (resolve) => {
            let res = (value || []).slice();
            filters.forEach(f => { res = res.filter(f); });
            return Promise.resolve({ data: res, error: null }).then(resolve);
        }
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
            { event_name: 'Shadowfront Squad 1', guild: 'ALPHA', is_active: true, session_id: 'S1', start_at: '2026-08-02T12:00:00Z' },
            { event_name: 'Shadowfront Squad 2', guild: 'ALPHA', is_active: false, session_id: null, start_at: null },
        ],
        guild_members: MEMBERS,
        shadowfront_squads: [
            { pseudo: 'Alpha', guild: 'ALPHA', session_id: 'S1', squad: 'squad1', role: 'participant', is_commander: true, week_start: '2026-08-02' },
        ],
        event_participants: [
            { pseudo: 'Alpha', guild: 'ALPHA', event_name: 'Shadowfront', session_id: 'S1', participated: 0, late: false, excused: false, sub_present: false, week_start: '2026-08-02' },
        ],
        shadowfront_signups: [
            { pseudo: 'Alpha', guild: 'ALPHA', availability: 'squad1', week_start: '2026-08-02' },
            { pseudo: 'Bravo', guild: 'ALPHA', availability: 'squad2', week_start: '2026-08-02' },
            { pseudo: 'Delta', guild: 'ALPHA', availability: 'squad1', week_start: '2026-08-02' },
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
    it('renders a 2-step stepper without availability step or approve flow', async () => {
        await SF.load();
        const text = area().textContent;
        expect(text).toContain('1. Squad Composition');
        expect(text).toContain('2. Participation Tracking');
        expect(text).not.toContain('Availability');
        expect(text).not.toContain('Running Tab');
        expect(text).not.toContain('Approve');
    });

    it('composition step shows member pool, confirmed squads and sorting controls', async () => {
        await SF.load();
        const text = area().textContent;
        expect(text).toContain('Member Pool');
        expect(text).toContain('Main Participants');
        expect(text).toContain('Substitutes');
        expect(text).toContain('Bravo');   // unassigned member in pool
        expect(text).toContain('Alpha');   // confirmed participant
        expect(text).toContain('Avg rate');
        expect(text).toContain('Rate');
        expect(text).toContain('Power');
        expect(text).toContain('Share on Discord');

        // Check that Alpha (assigned to Squad 1) is NOT listed in the Member Pool (Column 1)
        const poolCol = area().querySelector('.sf-unassigned');
        expect(poolCol.textContent).not.toContain('Alpha');
        expect(poolCol.textContent).toContain('Bravo');
    });

    it('excludes members assigned to Squad 1 from Squad 2 member pool', async () => {
        await SF.load();
        area().querySelector('.sf-main-tab.squad2').click();
        const poolCol = area().querySelector('.sf-unassigned');
        expect(poolCol.textContent).not.toContain('Alpha'); // Alpha is assigned to Squad 1, so excluded from Squad 2 pool
        expect(poolCol.textContent).toContain('Bravo');
        area().querySelector('.sf-main-tab.squad1').click();
    });

    it('unlocks tracking when a squad is active and offers bulk actions', async () => {
        await SF.load();
        stepByLabel('2. Participation Tracking').click();
        const text = area().textContent;
        expect(text).toContain('All present');
        expect(text).toContain('All absent');
        expect(text).toContain('Alpha');
        expect(text).not.toContain('Approve');
    });

    it('shares the composition on Discord through the shadowfront webhook via Edge Function proxy', async () => {
        tables.guild_config = [{ key: 'webhook_shadowfront', guild: 'ALPHA', value: 'https://discord.test/hook' }];
        const invokeMock = vi.fn().mockResolvedValue({ data: { ok: true } });
        GM.db.functions.invoke = invokeMock;

        await SF.load();
        stepByLabel('1. Squad Composition').click();
        area().querySelector('.sf-share-discord-btn').click();
        await new Promise((r) => setTimeout(r, 0));

        expect(invokeMock).toHaveBeenCalledTimes(1);
        expect(invokeMock).toHaveBeenCalledWith('discord-webhook-proxy', expect.objectContaining({
            body: expect.objectContaining({
                webhookUrl: 'https://discord.test/hook',
                payload: expect.objectContaining({
                    content: expect.stringContaining('Shadowfront'),
                })
            })
        }));
        expect(GM.showToast).toHaveBeenCalledWith('Composition sent to Discord.', 'success');
    });

    it('falls back to general guild event webhook when webhook_shadowfront is empty and cleans angle brackets', async () => {
        tables.guild_config = [{ key: 'webhook_armsrace', guild: 'ALPHA', value: '<https://canary.discord.com/api/webhooks/123/abc>' }];
        const invokeMock = vi.fn().mockResolvedValue({ data: { ok: true } });
        GM.db.functions.invoke = invokeMock;

        await SF.load();
        stepByLabel('1. Squad Composition').click();
        area().querySelector('.sf-share-discord-btn').click();
        await new Promise((r) => setTimeout(r, 0));

        expect(invokeMock).toHaveBeenCalledTimes(1);
        expect(invokeMock).toHaveBeenCalledWith('discord-webhook-proxy', expect.objectContaining({
            body: expect.objectContaining({
                webhookUrl: 'https://canary.discord.com/api/webhooks/123/abc',
            })
        }));
        expect(GM.showToast).toHaveBeenCalledWith('Composition sent to Discord.', 'success');
    });

    it('shares the composition on Discord through the shadowfront webhook fallback fetch', async () => {
        tables.guild_config = [{ key: 'webhook_shadowfront', guild: 'ALPHA', value: 'https://discord.test/hook' }];
        GM.db.functions.invoke = vi.fn().mockResolvedValue({ data: { ok: false } });
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
        vi.stubGlobal('fetch', fetchMock);

        await SF.load();
        stepByLabel('1. Squad Composition').click();
        area().querySelector('.sf-share-discord-btn').click();
        await new Promise((r) => setTimeout(r, 0));

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(GM.showToast).toHaveBeenCalledWith('Composition sent to Discord.', 'success');
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.embeds[0].title).toContain('Squad One');
        expect(body.embeds[0].fields).toHaveLength(2);
        expect(body.embeds[0].fields[0].value).toContain('👑 Alpha');
        expect(body.embeds[0].fields[1].value).toBe('None yet');
    });

    it('resets the UI for an ended squad instead of keeping composition', async () => {
        tables.event_status = [
            { event_name: 'Shadowfront Squad 1', guild: 'ALPHA', is_active: false, session_id: 'S1', start_at: null },
            { event_name: 'Shadowfront Squad 2', guild: 'ALPHA', is_active: true, session_id: 'S2', start_at: '2026-08-05T12:00:00Z' },
        ];
        tables.event_participants = [
            { pseudo: 'Alpha', guild: 'ALPHA', event_name: 'Shadowfront', session_id: 'S1', participated: 0, late: false, excused: false, sub_present: false, week_start: '2026-08-02' },
            { pseudo: 'Bravo', guild: 'ALPHA', event_name: 'Shadowfront', session_id: 'S2', participated: 0, late: false, excused: false, sub_present: false, week_start: '2026-08-02' },
        ];
        tables.shadowfront_squads = [
            { pseudo: 'Alpha', guild: 'ALPHA', session_id: 'S1', squad: 'squad1', role: 'participant', is_commander: true, week_start: '2026-08-02' },
        ];

        await SF.load();
        const text = area().textContent;
        expect(text).toContain('No active session');
        expect(text).toContain('Start');
        expect(text).not.toContain('1. Squad Composition');
        expect(text).not.toContain('2. Participation Tracking');
    });

    it('correctly calculates participation percentage for past ended sessions across all members', async () => {
        // Mock past ended session S0 with Bravo participating
        tables.event_status = [
            { event_name: 'Shadowfront Squad 1', guild: 'ALPHA', is_active: true, session_id: 'S1', start_at: '2026-08-05T12:00:00Z' },
            { event_name: 'Shadowfront Squad 2', guild: 'ALPHA', is_active: false, session_id: null, start_at: null },
        ];
        tables.shadowfront_squads = [
            { pseudo: 'Bravo', guild: 'ALPHA', session_id: 'S0_PAST', squad: 'squad1', role: 'participant', week_start: '2026-07-27' },
        ];
        tables.event_participants = [
            { pseudo: 'Bravo', guild: 'ALPHA', event_name: 'Shadowfront', session_id: 'S0_PAST', participated: 1, late: false, excused: false, sub_present: false, week_start: '2026-07-27' },
        ];

        await SF.load();
        // Bravo's participation badge in pool should show 100%
        const poolCol = area().querySelector('.sf-unassigned');
        expect(poolCol.textContent).toContain('100%');
    });

    it('exports window.GM.formatDiscordRoleMention and safely pings role ID on Shadowfront share', async () => {
        expect(typeof GM.formatDiscordRoleMention).toBe('function');
        expect(GM.formatDiscordRoleMention('1465165299648303282')).toBe('<@&1465165299648303282>');

        tables.guild_config = [
            { key: 'discord_role_id_shadowfront', value: '1465165299648303282', guild: 'ALPHA' },
            { key: 'webhook_shadowfront', value: 'https://discord.test/hook', guild: 'ALPHA' }
        ];

        tables.event_status = [
            { event_name: 'Shadowfront Squad 1', guild: 'ALPHA', is_active: true, session_id: 'S1', start_at: '2026-08-05T12:00:00Z' },
        ];
        tables.shadowfront_squads = [
            { pseudo: 'Alpha', guild: 'ALPHA', session_id: 'S1', squad: 'squad1', role: 'participant', is_commander: true, week_start: '2026-08-02' }
        ];

        const invokeMock = vi.fn().mockResolvedValue({ data: { ok: true } });
        GM.db.functions.invoke = invokeMock;

        await SF.load();

        const shareBtn = area().querySelector('.sf-share-discord-btn');
        expect(shareBtn).not.toBeNull();
        shareBtn.click();
        await new Promise((r) => setTimeout(r, 0));

        expect(GM.showToast).toHaveBeenCalledWith('Composition sent to Discord.', 'success');
        expect(invokeMock).toHaveBeenCalledTimes(1);
        expect(invokeMock).toHaveBeenCalledWith('discord-webhook-proxy', expect.objectContaining({
            body: expect.objectContaining({
                content: expect.stringContaining('<@&1465165299648303282>')
            })
        }));
    });

    it('translates sf_subtitle correctly without returning raw key', () => {
        expect(GM.t('sf_subtitle')).toBe('Squad 1 & Squad 2 - 20 participants + 10 reserves');
    });
});
