import { describe, it, expect } from 'vitest';
import '../gm-utils.js';

const GM = window.GM;
expect(GM).toBeTruthy();

describe('parseGeminiJson', () => {
    it('parses raw JSON objects correctly', () => {
        const input = '{"players":[{"pseudo":"HawkEye","overall_power":150000000}]}';
        const res = GM.parseGeminiJson(input);
        expect(res).toEqual({ players: [{ pseudo: 'HawkEye', overall_power: 150000000 }] });
    });

    it('parses JSON wrapped in markdown code blocks', () => {
        const input = '```json\n{\n  "players": [\n    {"pseudo": "StarWarrior99", "overall_power": 120000000}\n  ]\n}\n```';
        const res = GM.parseGeminiJson(input);
        expect(res).toEqual({ players: [{ pseudo: 'StarWarrior99', overall_power: 120000000 }] });
    });

    it('parses JSON wrapped in generic markdown code blocks', () => {
        const input = '```\n[{"pseudo": "AlphaOne", "overall_power": 90000000}]\n```';
        const res = GM.parseGeminiJson(input);
        expect(res).toEqual([{ pseudo: 'AlphaOne', overall_power: 90000000 }]);
    });

    it('extracts JSON substring when leading or trailing text is present', () => {
        const input = 'Here are the extracted roster members from the screenshot:\n{\n  "roster": [{"pseudo": "Shadow", "overall_power": 45000000}]\n}\nHope this helps!';
        const res = GM.parseGeminiJson(input);
        expect(res).toEqual({ roster: [{ pseudo: 'Shadow', overall_power: 45000000 }] });
    });

    it('returns null for empty or invalid input', () => {
        expect(GM.parseGeminiJson('')).toBeNull();
        expect(GM.parseGeminiJson(null)).toBeNull();
        expect(() => GM.parseGeminiJson('Not JSON at all')).toThrow();
    });

    it('parses specialized 7-metric OCR JSON schemas (Fleet, Tech, Glory, etc.)', () => {
        const fleetJson = '```json\n{\n  "metric": "fleet",\n  "players": [\n    {"pseudo": "Vanguard99", "score": 2160000, "uid": "1001"},\n    {"pseudo": "AdmiralZ", "score": 1850000, "uid": null}\n  ]\n}\n```';
        const resFleet = GM.parseGeminiJson(fleetJson);
        expect(resFleet.metric).toBe('fleet');
        expect(resFleet.players).toHaveLength(2);
        expect(resFleet.players[0].score).toBe(2160000);

        const techJson = '{"metric":"tech","players":[{"pseudo":"TechMaster","score":15400000}]}';
        const resTech = GM.parseGeminiJson(techJson);
        expect(resTech.metric).toBe('tech');
        expect(resTech.players[0].score).toBe(15400000);

        const gloryJson = '{"metric":"glory","players":[{"pseudo":"GloryKing","score":240000000}]}';
        const resGlory = GM.parseGeminiJson(gloryJson);
        expect(resGlory.metric).toBe('glory');
        expect(resGlory.players[0].score).toBe(240000000);
    });
});

describe('cleanPlayerPseudo and getGuildTag', () => {
    it('strips configured guild tag brackets and prefixes cleanly', () => {
        expect(GM.cleanPlayerPseudo('[PR1M] StarWarrior99', '[PR1M]')).toBe('StarWarrior99');
        expect(GM.cleanPlayerPseudo('PR1M StarWarrior99', 'PR1M')).toBe('StarWarrior99');
        expect(GM.cleanPlayerPseudo('[PR1M] - StarWarrior99', '[PR1M]')).toBe('StarWarrior99');
        expect(GM.cleanPlayerPseudo('[PR1M]_StarWarrior99', 'PR1M')).toBe('StarWarrior99');
        expect(GM.cleanPlayerPseudo('[ALPHA] HawkEye', '[ALPHA]')).toBe('HawkEye');
    });

    it('strips generic bracketed tags from foreign guild members', () => {
        expect(GM.cleanPlayerPseudo('[BABE] OtherPlayer', '[PR1M]')).toBe('OtherPlayer');
        expect(GM.cleanPlayerPseudo('[CLAW] RandomUser', '')).toBe('RandomUser');
    });

    it('preserves clean player names without tags', () => {
        expect(GM.cleanPlayerPseudo('HawkEye', '[PR1M]')).toBe('HawkEye');
        expect(GM.cleanPlayerPseudo('Admiral_99', '[ALPHA]')).toBe('Admiral_99');
    });

    it('returns valid default guild tags for standard tenants', async () => {
        expect(await GM.getGuildTag('ALPHA')).toBe('[PR1M]');
        expect(await GM.getGuildTag('OMEGA')).toBe('[OMG]');
        expect(await GM.getGuildTag('BABE')).toBe('[BABE]');
    });
});
