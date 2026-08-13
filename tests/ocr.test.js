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
});
