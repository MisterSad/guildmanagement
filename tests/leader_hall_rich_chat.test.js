// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import LeaderHall from '../gm-leader-hall.js';

describe('Regression: guilds table has no `name` column', () => {
    // Found during the 2026-09 stabilization sweep: fetchEligibleLeaders()
    // queried .from('guilds').select('id, name, server_number') — `name`
    // doesn't exist on public.guilds (only `id`, which already IS the
    // guild's tag/display value), so every call returned HTTP 400 and
    // availableGuilds silently stayed []. The real-world impact: the
    // "Propose Treaty" modal's Target Guild dropdown fell back to its
    // single hardcoded placeholder option (OMEGA only) for every guild,
    // regardless of which one they actually wanted to treaty with — nobody
    // could have proposed a real treaty with any other guild. Confirmed live
    // via a securitypolicyviolation-style fetch interceptor catching the
    // actual 400 response, and by inspecting public.guilds' real columns.
    const src = fs.readFileSync(path.resolve(__dirname, '../gm-leader-hall.js'), 'utf-8');

    it('never re-introduces a select() referencing guilds.name', () => {
        expect(src).not.toContain("select('id, name, server_number')");
        expect(src).not.toMatch(/from\(['"]guilds['"]\)\.select\([^)]*\bname\b/);
    });
});

describe('Regression: eligible-leaders lookup must use the RPC, not a raw accounts select', () => {
    // Found during the 2026-09 stabilization sweep: fetchEligibleLeaders()
    // queried .from('accounts').select(...) directly, relying on RLS to scope
    // the result. accounts' real SELECT policy (gm_can_read_account) only
    // lets super_admin read every row -- every other admin role (guild_admin,
    // server_admin, R4, R5) silently got an empty leader list with no error,
    // so they could never start a new Leader Hall chat/group/treaty, only
    // reply to ones someone else started. Fixed via a dedicated
    // SECURITY DEFINER RPC (gm_list_eligible_leaders) rather than loosening
    // RLS, since accounts also holds password_hash/gotrue_secret_enc/
    // auth_user_id that a broader SELECT policy would expose.
    const src = fs.readFileSync(path.resolve(__dirname, '../gm-leader-hall.js'), 'utf-8');

    it('fetchEligibleLeaders calls the gm_list_eligible_leaders RPC', () => {
        expect(src).toContain("rpc('gm_list_eligible_leaders')");
    });

    it('never re-introduces a direct accounts select for the leader picker', () => {
        expect(src).not.toMatch(/from\(['"]accounts['"]\)\.select\(['"]id, guild, role, server_number['"]\)/);
    });
});

describe('Leader Hall Rich Messaging Unit Tests', () => {
    beforeEach(() => {
        window.GM = {
            escapeHTML: (s) => (s ? String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') : '')
        };
    });

    describe('1. parseMessagePayload', () => {
        it('returns empty text and null replyTo on empty or falsy inputs', () => {
            expect(LeaderHall.parseMessagePayload('')).toEqual({ text: '', replyTo: null });
            expect(LeaderHall.parseMessagePayload(null)).toEqual({ text: '', replyTo: null });
            expect(LeaderHall.parseMessagePayload(undefined)).toEqual({ text: '', replyTo: null });
        });

        it('handles legacy plain text messages without replyTo', () => {
            const raw = 'Hello leaders, SvS battle begins tonight!';
            const parsed = LeaderHall.parseMessagePayload(raw);
            expect(parsed.text).toBe(raw);
            expect(parsed.replyTo).toBeNull();
        });

        it('parses structured JSON payloads with quoted reply metadata', () => {
            const payload = {
                text: 'Agreed on coordinates 45:120',
                replyTo: {
                    id: '104',
                    sender: 'Ashke',
                    guild: 'BABE',
                    snippet: 'Where should we rally?'
                }
            };
            const parsed = LeaderHall.parseMessagePayload(JSON.stringify(payload));
            expect(parsed.text).toBe('Agreed on coordinates 45:120');
            expect(parsed.replyTo).toEqual({
                id: '104',
                sender: 'Ashke',
                guild: 'BABE',
                snippet: 'Where should we rally?'
            });
        });

        it('gracefully falls back to raw text if JSON is malformed or not standard payload', () => {
            const malformed = '{ invalid json message';
            const parsed = LeaderHall.parseMessagePayload(malformed);
            expect(parsed.text).toBe(malformed);
            expect(parsed.replyTo).toBeNull();
        });
    });

    describe('2. formatMessageBody', () => {
        it('safely escapes HTML injection attempts', () => {
            const unsafe = '<script>alert("hack")</script> & <b>bold</b>';
            const formatted = LeaderHall.formatMessageBody(unsafe, 'HawkEye');
            expect(formatted).not.toContain('<script>');
            expect(formatted).toContain('&lt;script&gt;');
            expect(formatted).toContain('&amp;');
        });

        it('converts @Username mentions into badge spans', () => {
            const text = 'Hello @Ashke and @Vortex, please check the gates!';
            const formatted = LeaderHall.formatMessageBody(text, 'HawkEye');
            expect(formatted).toContain('<span class="gm-mention-badge " data-mention="Ashke">@Ashke</span>');
            expect(formatted).toContain('<span class="gm-mention-badge " data-mention="Vortex">@Vortex</span>');
        });

        it('adds .is-me highlight when the current user is mentioned', () => {
            const text = 'Urgent: @HawkEye we need reinforcement in zone 4!';
            const formatted = LeaderHall.formatMessageBody(text, 'hawkeye');
            expect(formatted).toContain('<span class="gm-mention-badge is-me" data-mention="HawkEye">@HawkEye</span>');
        });

        it('replaces newlines with <br> tags', () => {
            const text = 'Line 1\nLine 2\nLine 3';
            const formatted = LeaderHall.formatMessageBody(text, 'HawkEye');
            expect(formatted).toBe('Line 1<br>Line 2<br>Line 3');
        });
    });

    describe('3. aggregateReactions', () => {
        it('returns empty array when reactions list is empty or undefined', () => {
            expect(LeaderHall.aggregateReactions([], 'HawkEye')).toEqual([]);
            expect(LeaderHall.aggregateReactions(null, 'HawkEye')).toEqual([]);
        });

        it('aggregates reactions by emoji, counts totals, and tracks user lists', () => {
            const reactions = [
                { emoji: '🔥', account_id: 'HawkEye' },
                { emoji: '🔥', account_id: 'Ashke' },
                { emoji: '⚔️', account_id: 'Vortex' },
                { emoji: '👍', account_id: 'HawkEye' }
            ];

            const agg = LeaderHall.aggregateReactions(reactions, 'HawkEye');
            expect(agg).toHaveLength(3);

            const fire = agg.find(r => r.emoji === '🔥');
            expect(fire.count).toBe(2);
            expect(fire.users).toEqual(['HawkEye', 'Ashke']);
            expect(fire.hasReacted).toBe(true);

            const sword = agg.find(r => r.emoji === '⚔️');
            expect(sword.count).toBe(1);
            expect(sword.users).toEqual(['Vortex']);
            expect(sword.hasReacted).toBe(false);

            const thumbs = agg.find(r => r.emoji === '👍');
            expect(thumbs.count).toBe(1);
            expect(thumbs.hasReacted).toBe(true);
        });
    });

    describe('4. Mobile Badges & Mention Detection', () => {
        it('correctly updates mobile bottom-nav more badge and drawer badge', () => {
            document.body.innerHTML = `
                <div id="nav-badge-leader-hall" class="hidden">0</div>
                <div id="bottom-nav-more-badge" class="hidden">0</div>
                <div id="drawer-badge-leader-hall" class="hidden">0</div>
            `;

            // Call updateAllUnreadBadges
            LeaderHall.updateAllUnreadBadges();

            const bMore = document.getElementById('bottom-nav-more-badge');
            const bDrawer = document.getElementById('drawer-badge-leader-hall');
            expect(bMore).not.toBeNull();
            expect(bDrawer).not.toBeNull();
        });

        it('detects user mentions accurately with regex boundaries', () => {
            const accId = 'HawkEye';
            const regex = new RegExp('@' + accId + '(?![a-zA-Z0-9_\\-])', 'i');

            expect(regex.test('Hello @HawkEye how are you?')).toBe(true);
            expect(regex.test('Hey @hawkeye check this out')).toBe(true);
            expect(regex.test('Message for @HawkEye_Shadow')).toBe(false);
            expect(regex.test('No mention here @Ashke')).toBe(false);
        });
    });

    describe('5. Leader Name & Server Tag Formatting ([Guild] Pseudo #Server)', () => {
        it('formatLeaderTag accurately formats [Guild] Pseudo #Server and avoids guild_admin', () => {
            const res = LeaderHall.formatLeaderTag('Ashke', 'BABE', '1089');
            expect(res).toBe('[BABE] Ashke #1089');
            expect(res).not.toContain('guild_admin');
        });

        it('formatLeaderTag handles empty guild gracefully', () => {
            const res = LeaderHall.formatLeaderTag('Gideon', '', '1058');
            expect(res).toBe('Gideon #1058');
        });

        it('formatLeaderHtml generates sanitized HTML with .gm-sender-guild and .gm-sender-server', () => {
            const html = LeaderHall.formatLeaderHtml('Sly', 'EXPO', '1089');
            expect(html).toContain('<span class="gm-sender-guild">[EXPO]</span>');
            expect(html).toContain('Sly');
            expect(html).toContain('<span class="gm-sender-server">#1089</span>');
            expect(html).not.toContain('guild_admin');
        });

        it('resolveLeaderServer resolves explicit, storage, or fallback servers', () => {
            expect(LeaderHall.resolveLeaderServer('Ashke', 'BABE', '1089')).toBe('1089');
            expect(LeaderHall.resolveLeaderServer('Ashke', 'BABE', '#1089')).toBe('1089');
            expect(LeaderHall.resolveLeaderServer('Ashke', 'BABE', 'S1089')).toBe('1089');
        });
    });

    describe('6. Timestamp Formatting (DD/MM/AAAA HH:MM) & Reactions Positioning', () => {
        it('formatMessageTimestamp formats valid dates as DD/MM/YYYY HH:MM without seconds', () => {
            const date = new Date(2026, 7, 26, 17, 36, 45); // 26 August 2026 17:36:45
            const res = LeaderHall.formatMessageTimestamp(date);
            expect(res).toBe('26/08/2026 17:36');
            expect(res).not.toContain(':45');
        });

        it('formatMessageTimestamp pads single digit days, months, and hours with leading zeros', () => {
            const date = new Date(2026, 0, 5, 9, 7, 0); // 5 Jan 2026 09:07:00
            const res = LeaderHall.formatMessageTimestamp(date);
            expect(res).toBe('05/01/2026 09:07');
        });

        it('formatMessageTimestamp returns empty string on null or invalid date', () => {
            expect(LeaderHall.formatMessageTimestamp(null)).toBe('');
            expect(LeaderHall.formatMessageTimestamp('')).toBe('');
            expect(LeaderHall.formatMessageTimestamp('invalid-date')).toBe('');
        });

        it('formatMessageBody formats mentions with data-mention attribute and is-me class', () => {
            const body = LeaderHall.formatMessageBody('Hello @Ashke and @HawkEye!', 'HawkEye');
            expect(body).toContain('data-mention="Ashke"');
            expect(body).toContain('data-mention="HawkEye"');
            expect(body).toContain('is-me');
        });
    });
});

