// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import LeaderHall from '../gm-leader-hall.js';

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
});
