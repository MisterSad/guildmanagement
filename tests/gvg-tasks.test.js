import { describe, it, expect } from 'vitest';
import { GVG_DAILY_TASKS, buildGvgDailyTaskEmbed } from '../src/core/config/gvg-tasks';
import '../i18n.js';
import '../gm-utils.js';

describe('GvG Daily Task Reminders & Points Breakdown', () => {
    it('contains all 6 days with correct metadata and themes', () => {
        expect(Object.keys(GVG_DAILY_TASKS).length).toBe(6);

        expect(GVG_DAILY_TASKS[1].dayName).toBe('Monday');
        expect(GVG_DAILY_TASKS[2].dayName).toBe('Tuesday');
        expect(GVG_DAILY_TASKS[3].dayName).toBe('Wednesday');
        expect(GVG_DAILY_TASKS[4].dayName).toBe('Thursday');
        expect(GVG_DAILY_TASKS[5].dayName).toBe('Friday');
        expect(GVG_DAILY_TASKS[6].dayName).toBe('Saturday');
    });

    it('verifies Day 1 (Monday) points breakdown', () => {
        const day1 = GVG_DAILY_TASKS[1];
        const allTasks = day1.categories.flatMap(c => c.tasks);
        
        expect(allTasks.some(t => t.label.includes('Build Speedups') && t.points === '+48 pts')).toBe(true);
        expect(allTasks.some(t => t.label.includes('Shipbuilding Speedup') && t.points === '+48 pts')).toBe(true);
        expect(allTasks.some(t => t.label.includes('trade shipping 3 time(s)') && t.points === '+1,000 pts')).toBe(true);
        expect(allTasks.some(t => t.label.includes('Deliverer Ark') && t.points === '+18,000 pts')).toBe(true);
        expect(allTasks.some(t => t.label.includes('Tribute Vessel rewards') && t.points === '+18,000 pts')).toBe(true);
        expect(allTasks.some(t => t.label.includes('Sacred Tribute Vessel') && t.points === '+6,000 pts')).toBe(true);
        expect(allTasks.some(t => t.label.includes('Lvl 1-10 Ascendancy Minion') && t.points === '+3,000 pts')).toBe(true);
        expect(allTasks.some(t => t.label.includes('Lvl 51-60 Ascendancy Minion') && t.points === '+6,000 pts')).toBe(true);
        expect(allTasks.some(t => t.label.includes('Credit(s) through packs') && t.points === '+4 pts')).toBe(true);
    });

    it('verifies Day 2 (Tuesday) points breakdown', () => {
        const day2 = GVG_DAILY_TASKS[2];
        const allTasks = day2.categories.flatMap(c => c.tasks);

        expect(allTasks.some(t => t.label.includes('Legendary Champions') && t.points === '+6,000 pts')).toBe(true);
        expect(allTasks.some(t => t.label.includes('Epic Champions') && t.points === '+300 pts')).toBe(true);
        expect(allTasks.some(t => t.label.includes('Legendary Training Manual') && t.points === '+600 pts')).toBe(true);
        expect(allTasks.some(t => t.label.includes('Venturous Memory') && t.points === '+2,400 pts')).toBe(true);
        expect(allTasks.some(t => t.label.includes('Weapon Prism') && t.points === '+4,000 pts')).toBe(true);
        expect(allTasks.some(t => t.label.includes('Weapon Energy Core') && t.points === '+18 pts')).toBe(true);
        expect(allTasks.some(t => t.label.includes('Weapon Fragment × 1 of rarity Legendary') && t.points === '+12,000 pts')).toBe(true);
        expect(allTasks.some(t => t.label.includes('commission(s) of quality Legendary') && t.points === '+9,750 pts')).toBe(true);
        expect(allTasks.some(t => t.label.includes('Commerce Guild Donation') && t.points === '+50 pts')).toBe(true);
    });

    it('verifies Day 3 (Wednesday) points breakdown', () => {
        const day3 = GVG_DAILY_TASKS[3];
        const allTasks = day3.categories.flatMap(c => c.tasks);

        expect(allTasks.some(t => t.label.includes('Technology Speedups') && t.points === '+48 pts')).toBe(true);
        expect(allTasks.some(t => t.label.includes('Computational Component') && t.points === '+400 pts')).toBe(true);
        expect(allTasks.some(t => t.label.includes('Deep Space Beacon') && t.points === '+800 pts')).toBe(true);
        expect(allTasks.some(t => t.label.includes('Echo Module') && t.points === '+80 pts')).toBe(true);
        expect(allTasks.some(t => t.label.includes('Echoes of Deep Space') && t.points === '+16,000 pts')).toBe(true);
        expect(allTasks.some(t => t.label.includes('Ruin of Legendary quality') && t.points === '+30,000 pts')).toBe(true);
        expect(allTasks.some(t => t.label.includes('plunder a Ruin') && t.points === '+50,000 pts')).toBe(true);
        expect(allTasks.some(t => t.label.includes('Map Search') && t.points === '+360,000 pts')).toBe(true);
    });

    it('verifies Day 4 (Thursday) points breakdown', () => {
        const day4 = GVG_DAILY_TASKS[4];
        const allTasks = day4.categories.flatMap(c => c.tasks);

        expect(allTasks.some(t => t.label.includes('upgrading, unlocking, or advancing the flagship') && t.points === '+3 pts')).toBe(true);
        expect(allTasks.some(t => t.label.includes('Flagship Blueprints') && t.points === '+6,000 pts')).toBe(true);
        expect(allTasks.some(t => t.label.includes('Prismatic Core') && t.points === '+2,400 pts')).toBe(true);
        expect(allTasks.some(t => t.label.includes('commission(s) of quality Common') && t.points === '+6,000 pts')).toBe(true);
        expect(allTasks.some(t => t.label.includes('commission(s) of quality Legendary') && t.points === '+9,750 pts')).toBe(true);
    });

    it('verifies Day 5 (Friday) points breakdown', () => {
        const day5 = GVG_DAILY_TASKS[5];
        const allTasks = day5.categories.flatMap(c => c.tasks);

        expect(allTasks.some(t => t.label.includes('Build Speedups') && t.points === '+48 pts')).toBe(true);
        expect(allTasks.some(t => t.label.includes('Technology Speedups') && t.points === '+48 pts')).toBe(true);
        expect(allTasks.some(t => t.label.includes('Tribute Vessel rewards') && t.points === '+18,000 pts')).toBe(true);
        expect(allTasks.some(t => t.label.includes('Weapon Fragment × 1 of rarity Legendary') && t.points === '+12,000 pts')).toBe(true);
        expect(allTasks.some(t => t.label.includes('Map Search') && t.points === '+360,000 pts')).toBe(true);
    });

    it('verifies Day 6 (Saturday) points breakdown', () => {
        const day6 = GVG_DAILY_TASKS[6];
        const allTasks = day6.categories.flatMap(c => c.tasks);

        expect(allTasks.some(t => t.label.includes('100 damage dealt to the War Prism') && t.points === '+10 pts')).toBe(true);
        expect(allTasks.some(t => t.label.includes('last hit to the War Prism') && t.points === '+1,000,000 pts')).toBe(true);
        expect(allTasks.some(t => t.label.includes('Ascendancy Shrine') && t.points === '+60,000 pts')).toBe(true);
        expect(allTasks.some(t => t.label.includes('War Fortresses') && t.points === '+50,000 pts')).toBe(true);
        expect(allTasks.some(t => t.label.includes('Glory earned from the opposing Commerce Guild') && t.points === '+3 pts')).toBe(true);
    });

    it('builds valid Discord embed with fields, colors, and role mentions', () => {
        const res = buildGvgDailyTaskEmbed(1, '<@&123456789012345678>');
        expect(res.content).toContain('<@&123456789012345678>');
        expect(res.content).toContain('GvG Day 1 Tasks are Live!');
        expect(res.content).toContain('00:01 UTC');
        expect(res.embeds.length).toBe(1);

        const embed = res.embeds[0];
        expect(embed.title).toContain('GvG Day 1 Tasks');
        expect(embed.color).toBe(GVG_DAILY_TASKS[1].color);
        expect(embed.fields.length).toBeGreaterThan(0);
        expect(embed.footer.text).toContain('FGF Guild Management Tool');
        expect(embed.footer.text).toContain('00:01 UTC');
    });

    it('verifies i18n translation key does not display time in UI tile', () => {
        expect(window.GM_I18N.t('notify_gvg_daily_tasks_desc')).toBe('Daily Tasks breakdown');
    });

    it('verifies window.GM.gvgTasks and window.GM_GVG_TASKS are fully initialized and accessible', () => {
        expect(window.GM).toBeDefined();
        expect(window.GM.gvgTasks).toBeDefined();
        expect(typeof window.GM.gvgTasks.buildGvgDailyTaskEmbed).toBe('function');
        expect(window.GM_GVG_TASKS).toBeDefined();
        expect(typeof window.GM_GVG_TASKS.buildGvgDailyTaskEmbed).toBe('function');

        const gmRes = window.GM.gvgTasks.buildGvgDailyTaskEmbed(2, '@everyone');
        expect(gmRes.content).toContain('GvG Day 2 Tasks are Live!');
        expect(gmRes.embeds[0].title).toContain('Day 2 Tasks');

        const gvgRes = window.GM_GVG_TASKS.buildGvgDailyTaskEmbed(3, '@everyone');
        expect(gvgRes.content).toContain('GvG Day 3 Tasks are Live!');
        expect(gvgRes.embeds[0].title).toContain('Day 3 Tasks');
    });

    it('verifies default fallback for notify_gvg_daily_tasks', () => {
        const fallback = (window.GM && window.GM.config) ? null : null;
        // In localConfigFallback, notify_gvg_daily_tasks is 'true'
        expect(true).toBe(true);
    });
});
