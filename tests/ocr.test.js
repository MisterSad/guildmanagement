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

describe('9 Dedicated AI Event OCR Schemas & Evaluation Logic', () => {
    it('parses SvS Day 1-5 and Day 6 OCR JSON payloads with prep/pvp scores', () => {
        const svsPrepRaw = '```json\n{\n  "metric": "svs_prep",\n  "guild_tag": "[PR1M]",\n  "players": [\n    {"pseudo": "[PR1M] CommanderAlpha", "score": 35000000},\n    {"pseudo": "EnemyPlayer", "score": 28000000}\n  ]\n}\n```';
        const resPrep = GM.parseGeminiJson(svsPrepRaw);
        expect(resPrep.metric).toBe('svs_prep');
        expect(resPrep.players).toHaveLength(2);
        expect(resPrep.players[0].score).toBe(35000000);
        expect(GM.cleanPlayerPseudo(resPrep.players[0].pseudo, resPrep.guild_tag)).toBe('CommanderAlpha');

        const svsPvpRaw = '{"metric":"svs_pvp","guild_tag":"[PR1M]","players":[{"pseudo":"[PR1M] FleetAdmiral","score":120000000}]}';
        const resPvp = GM.parseGeminiJson(svsPvpRaw);
        expect(resPvp.metric).toBe('svs_pvp');
        expect(resPvp.players[0].score).toBe(120000000);
        expect(GM.cleanPlayerPseudo(resPvp.players[0].pseudo, resPvp.guild_tag)).toBe('FleetAdmiral');
    });

    it('parses GvG Day 1-5 and Day 6 OCR JSON payloads', () => {
        const gvgPrepRaw = '{"metric":"gvg_prep","guild_tag":"[PR1M]","players":[{"pseudo":"[PR1M] ScoutOne","score":15000000}]}';
        const resPrep = GM.parseGeminiJson(gvgPrepRaw);
        expect(resPrep.metric).toBe('gvg_prep');
        expect(resPrep.players[0].score).toBe(15000000);

        const gvgPvpRaw = '{"metric":"gvg_pvp","guild_tag":"[PR1M]","players":[{"pseudo":"[PR1M] BattleLord","score":85000000}]}';
        const resPvp = GM.parseGeminiJson(gvgPvpRaw);
        expect(resPvp.metric).toBe('gvg_pvp');
        expect(resPvp.players[0].score).toBe(85000000);
    });

    it('evaluates Shadowfront S1 & S2 role evaluation: Main (participated) vs Reserve (sub_present + participated)', () => {
        const sfS1Raw = '{"metric":"shadowfront_s1","players":[{"pseudo":"LeaderOne","score":50000000},{"pseudo":"SubPilot99","score":30000000}]}';
        const resS1 = GM.parseGeminiJson(sfS1Raw);
        expect(resS1.metric).toBe('shadowfront_s1');
        expect(resS1.players).toHaveLength(2);

        // Simulate Shadowfront role evaluation
        const assignments = [
            { pseudo: 'LeaderOne', role: 'participant', squad: 'squad1' },
            { pseudo: 'SubPilot99', role: 'reserve', squad: 'squad1' }
        ];

        function evaluateSfToggles(playerPseudo, squadAssignments) {
            const assign = squadAssignments.find(a => a.pseudo.toLowerCase() === playerPseudo.toLowerCase());
            if (assign && assign.role === 'reserve') {
                return { participated: 1, sub_present: true };
            }
            return { participated: 1, sub_present: false };
        }

        const mainEval = evaluateSfToggles('LeaderOne', assignments);
        expect(mainEval.participated).toBe(1);
        expect(mainEval.sub_present).toBe(false);

        const subEval = evaluateSfToggles('SubPilot99', assignments);
        expect(subEval.participated).toBe(1);
        expect(subEval.sub_present).toBe(true);
    });

    it('evaluates DTR toggle rules: score > 0 -> participated, score === 0 -> appointed + participated', () => {
        const dtrRaw = '{"metric":"dtr","players":[{"pseudo":"DriverA","score":45000},{"pseudo":"EscortB","score":0}]}';
        const resDtr = GM.parseGeminiJson(dtrRaw);
        expect(resDtr.metric).toBe('dtr');

        function evaluateDtrToggles(score) {
            if (score > 0) {
                return { participated: 1, appointed: false };
            }
            return { participated: 1, appointed: true };
        }

        expect(evaluateDtrToggles(resDtr.players[0].score)).toEqual({ participated: 1, appointed: false });
        expect(evaluateDtrToggles(resDtr.players[1].score)).toEqual({ participated: 1, appointed: true });
    });

    it('evaluates Arms Race Stage A and Stage B participation', () => {
        const arSaRaw = '{"metric":"armsrace_sa","players":[{"pseudo":"RunnerA"},{"pseudo":"RunnerB"}]}';
        const resSa = GM.parseGeminiJson(arSaRaw);
        expect(resSa.metric).toBe('armsrace_sa');
        expect(resSa.players).toHaveLength(2);

        const arSbRaw = '{"metric":"armsrace_sb","players":[{"pseudo":"RunnerC"}]}';
        const resSb = GM.parseGeminiJson(arSbRaw);
        expect(resSb.metric).toBe('armsrace_sb');
        expect(resSb.players[0].pseudo).toBe('RunnerC');
    });

    it('accurately parses multiple players with identical prefixes (e.g. Trader99104, Trader99205)', () => {
        const traderRaw = '{"metric":"power","players":[{"pseudo":"Trader99104","overall_power":36409500},{"pseudo":"Trader99205","overall_power":13671300},{"pseudo":"Trader99306","overall_power":8922840}]}';
        const res = GM.parseGeminiJson(traderRaw);
        expect(res.players).toHaveLength(3);
        expect(res.players[0].pseudo).toBe('Trader99104');
        expect(res.players[1].pseudo).toBe('Trader99205');
        expect(res.players[2].pseudo).toBe('Trader99306');
    });

    it('filters OCR rows correctly when using search query', () => {
        const players = [
            { pseudo: 'Trader99104', score: 36409500 },
            { pseudo: 'Trader99205', score: 13671300 },
            { pseudo: 'Maeve', score: 19631990 },
            { pseudo: 'Антропов', score: 17264130 }
        ];

        function filterPlayers(list, query) {
            const q = (query || '').trim().toLowerCase();
            if (!q) return list;
            return list.filter(p => p.pseudo.toLowerCase().includes(q));
        }

        expect(filterPlayers(players, 'trader')).toHaveLength(2);
        expect(filterPlayers(players, 'maeve')).toHaveLength(1);
        expect(filterPlayers(players, 'антро')).toHaveLength(1);
        expect(filterPlayers(players, '99205')).toHaveLength(1);
        expect(filterPlayers(players, '')).toHaveLength(4);
    });
});

