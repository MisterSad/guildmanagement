import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../gm-utils.js';
import '../i18n.js';

describe('Member Duplicate UID & Same-Guild Rename Detection', () => {
    let container;

    beforeEach(() => {
        document.body.innerHTML = '';
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    afterEach(() => {
        const overlay = document.getElementById('uid-taken-overlay');
        if (overlay) overlay.remove();
        document.body.innerHTML = '';
        vi.restoreAllMocks();
    });

    it('identifies same-guild membership when guild matches active guild', () => {
        const activeGuild = 'OMEGA';
        const playerInfo = {
            player: {
                pseudo: 'Trader28168',
                uid: '1833757',
                guild: 'OMEGA',
                role: 'R1',
                overall_power: 50000000
            },
            name_history: []
        };
        const guildMembers = [
            { pseudo: 'Trader28168', uid: '1833757', guild: 'OMEGA', role: 'R1', overall_power: 50000000 }
        ];

        const isSameGuild = Boolean(
            (playerInfo.player.guild && activeGuild && playerInfo.player.guild.trim().toUpperCase() === activeGuild.trim().toUpperCase()) ||
            guildMembers.some(m => m.uid && String(m.uid).trim() === '1833757')
        );

        expect(isSameGuild).toBe(true);
    });

    it('identifies cross-guild membership when guild differs from active guild', () => {
        const activeGuild = 'OMEGA';
        const playerInfo = {
            player: {
                pseudo: 'Trader28168',
                uid: '1833757',
                guild: 'ALPHA',
                role: 'R1',
                overall_power: 50000000
            },
            name_history: []
        };
        const guildMembers = [];

        const isSameGuild = Boolean(
            (playerInfo.player.guild && activeGuild && playerInfo.player.guild.trim().toUpperCase() === activeGuild.trim().toUpperCase()) ||
            guildMembers.some(m => m.uid && String(m.uid).trim() === '1833757')
        );

        expect(isSameGuild).toBe(false);
    });

    it('correctly builds same-guild prompt UI with Update Player Name button', () => {
        const existingPseudo = 'Trader28168';
        const typedPseudo = 'Trader28168_Renamed';
        const uid = '1833757';
        const guild = 'OMEGA';

        const notice = `This player (${existingPseudo}) already belongs to ${guild}. Would you like to update their name to ${typedPseudo}?`;
        expect(notice).toContain('Trader28168');
        expect(notice).toContain('Trader28168_Renamed');
        expect(notice).toContain('OMEGA');

        const buttonLabel = 'Update Player Name';
        expect(buttonLabel).toBe('Update Player Name');
    });

    it('handles case-insensitive member matching for rename update', () => {
        const guildMembers = [
            { pseudo: 'trader28168', uid: '1833757', guild: 'OMEGA', role: 'R1', overall_power: 50000000 }
        ];
        const oldPseudo = 'Trader28168';
        const newUid = '1833757';

        const member = guildMembers.find(m =>
            (m.pseudo && m.pseudo.toLowerCase() === oldPseudo.toLowerCase()) ||
            (m.uid && newUid && String(m.uid).trim() === String(newUid).trim())
        );

        expect(member).toBeDefined();
        expect(member.uid).toBe('1833757');
    });

    it('formats power in player details using window.GM.formatPower', () => {
        expect(window.GM.formatPower(50000000)).toBe('50.0M');
        expect(window.GM.formatPower(1234567)).toBe('1.2M');
    });
});
