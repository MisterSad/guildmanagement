/**
 * badges.js — Gamification badge engine for the Player Portal.
 * Pure computation: takes raw player data (rank, join date, power,
 * attendance) and returns the full badge catalog with earned / locked
 * state, progress and the objective to reach for locked badges.
 * No DOM access; unit-testable in isolation.
 */
(function () {
    'use strict';

    var DAY_MS = 86400000;

    // ── Badge catalog ───────────────────────────────────────────────────────────
    // Each badge: id, category, name, desc (short objective shown when locked),
    // icon (Phosphor), color, target and a format used to render progress.
    var CATALOG = [
        // Ranks: cumulative, unlocked when the current in-game rank >= target rank.
        { id: 'rank_r1', category: 'rank',  name: 'Initiate',  desc: 'Reach rank R1',      icon: 'ph-shield',       color: '#fbbf24', target: 1 },
        { id: 'rank_r2', category: 'rank',  name: 'Soldier',   desc: 'Reach rank R2',      icon: 'ph-shield-check', color: '#fbbf24', target: 2 },
        { id: 'rank_r3', category: 'rank',  name: 'Veteran',   desc: 'Reach rank R3',      icon: 'ph-shield-star',  color: '#fbbf24', target: 3 },
        { id: 'rank_r4', category: 'rank',  name: 'Elite',     desc: 'Reach rank R4',      icon: 'ph-shield-crown', color: '#fbbf24', target: 4 },
        { id: 'rank_r5', category: 'rank',  name: 'Commander', desc: 'Reach rank R5',      icon: 'ph-crown',        color: '#fbbf24', target: 5 },
        // Seniority: days spent in the guild since the member row was created.
        // Max 2 years, with fine intermediate steps.
        { id: 'tenure_1m',  category: 'tenure', name: 'Newcomer',  desc: 'Stay 1 month in the guild',       icon: 'ph-hourglass',     color: '#34d399', target: 30 },
        { id: 'tenure_2m',  category: 'tenure', name: 'Rookie',     desc: 'Stay 2 months in the guild',      icon: 'ph-user-plus',     color: '#34d399', target: 60 },
        { id: 'tenure_3m',  category: 'tenure', name: 'Member',     desc: 'Stay 3 months in the guild',      icon: 'ph-user-clock',    color: '#34d399', target: 90 },
        { id: 'tenure_6m',  category: 'tenure', name: 'Seasoned',   desc: 'Stay 6 months in the guild',      icon: 'ph-users',         color: '#34d399', target: 180 },
        { id: 'tenure_9m',  category: 'tenure', name: 'Loyal',      desc: 'Stay 9 months in the guild',      icon: 'ph-users-three',   color: '#34d399', target: 270 },
        { id: 'tenure_1y',  category: 'tenure', name: 'Veteran',    desc: 'Stay 1 year in the guild',        icon: 'ph-trophy',        color: '#34d399', target: 365 },
        { id: 'tenure_18m', category: 'tenure', name: 'Alumnus',    desc: 'Stay 18 months in the guild',     icon: 'ph-graduation-cap', color: '#34d399', target: 545 },
        { id: 'tenure_2y',  category: 'tenure', name: 'Legend',     desc: 'Stay 2 years in the guild',       icon: 'ph-crown',         color: '#34d399', target: 730 },
        // Power: current overall_power in the guild roster. Max 300M.
        { id: 'power_10m',  category: 'power', name: 'Fighter',    desc: 'Reach 10M combat power',   icon: 'ph-sword',       color: '#a78bfa', target: 10000000 },
        { id: 'power_25m',  category: 'power', name: 'Brawler',    desc: 'Reach 25M combat power',   icon: 'ph-axe',         color: '#a78bfa', target: 25000000 },
        { id: 'power_50m',  category: 'power', name: 'Warrior',    desc: 'Reach 50M combat power',   icon: 'ph-crosshair',   color: '#a78bfa', target: 50000000 },
        { id: 'power_75m',  category: 'power', name: 'Elite',      desc: 'Reach 75M combat power',   icon: 'ph-lightning',   color: '#a78bfa', target: 75000000 },
        { id: 'power_100m', category: 'power', name: 'Titan',      desc: 'Reach 100M combat power',  icon: 'ph-barbell',     color: '#a78bfa', target: 100000000 },
        { id: 'power_125m', category: 'power', name: 'Champion',   desc: 'Reach 125M combat power',  icon: 'ph-fire',        color: '#a78bfa', target: 125000000 },
        { id: 'power_150m', category: 'power', name: 'Colossus',   desc: 'Reach 150M combat power',  icon: 'ph-planet',      color: '#a78bfa', target: 150000000 },
        { id: 'power_200m', category: 'power', name: 'Warlord',    desc: 'Reach 200M combat power',  icon: 'ph-crown-simple', color: '#a78bfa', target: 200000000 },
        { id: 'power_250m', category: 'power', name: 'Overlord',   desc: 'Reach 250M combat power',  icon: 'ph-star-four',   color: '#a78bfa', target: 250000000 },
        { id: 'power_300m', category: 'power', name: 'Godslayer',  desc: 'Reach 300M combat power',  icon: 'ph-sparkle',     color: '#a78bfa', target: 300000000 },
        // Participation: events attended (participated or sub-present). Up to 1500.
        { id: 'part_10',    category: 'part', name: 'Active',       desc: 'Attend 10 events',     icon: 'ph-check-circle',   color: '#22d3ee', target: 10 },
        { id: 'part_25',    category: 'part', name: 'Reliable',     desc: 'Attend 25 events',     icon: 'ph-calendar-check', color: '#22d3ee', target: 25 },
        { id: 'part_50',    category: 'part', name: 'Dedicated',    desc: 'Attend 50 events',     icon: 'ph-flame',          color: '#22d3ee', target: 50 },
        { id: 'part_100',   category: 'part', name: 'Iron Will',    desc: 'Attend 100 events',    icon: 'ph-star',           color: '#22d3ee', target: 100 },
        { id: 'part_200',   category: 'part', name: 'Vanguard',     desc: 'Attend 200 events',    icon: 'ph-shield-star',    color: '#22d3ee', target: 200 },
        { id: 'part_300',   category: 'part', name: 'Commando',     desc: 'Attend 300 events',    icon: 'ph-crosshair',      color: '#22d3ee', target: 300 },
        { id: 'part_400',   category: 'part', name: 'Unbreakable',  desc: 'Attend 400 events',    icon: 'ph-crown',          color: '#22d3ee', target: 400 },
        { id: 'part_500',   category: 'part', name: 'Legendary',    desc: 'Attend 500 events',    icon: 'ph-shield-crown',   color: '#22d3ee', target: 500 },
        { id: 'part_750',   category: 'part', name: 'Mythic',       desc: 'Attend 750 events',    icon: 'ph-sparkle',        color: '#22d3ee', target: 750 },
        { id: 'part_1000',  category: 'part', name: 'Eternal',      desc: 'Attend 1000 events',   icon: 'ph-infinity',       color: '#22d3ee', target: 1000 },
        { id: 'part_1250',  category: 'part', name: 'Transcendent', desc: 'Attend 1250 events',   icon: 'ph-broadcast',      color: '#22d3ee', target: 1250 },
        { id: 'part_1500',  category: 'part', name: 'Immortal',     desc: 'Attend 1500 events',   icon: 'ph-asterisk',       color: '#22d3ee', target: 1500 },
        // Glory: highest single Glory week ever recorded for the player.
        { id: 'glory_1k',   category: 'glory', name: 'Spark',     desc: 'Reach 1K Glory in a week',    icon: 'ph-sparkle',       color: '#fbbf24', target: 1000 },
        { id: 'glory_10k',  category: 'glory', name: 'Radiant',   desc: 'Reach 10K Glory in a week',   icon: 'ph-sun',           color: '#fbbf24', target: 10000 },
        { id: 'glory_50k',  category: 'glory', name: 'Luminous',  desc: 'Reach 50K Glory in a week',   icon: 'ph-brightness-high', color: '#fbbf24', target: 50000 },
        { id: 'glory_100k', category: 'glory', name: 'Dazzling',  desc: 'Reach 100K Glory in a week',  icon: 'ph-crown',         color: '#fbbf24', target: 100000 },
        { id: 'glory_500k', category: 'glory', name: 'Supernova', desc: 'Reach 500K Glory in a week',  icon: 'ph-broadcast',     color: '#fbbf24', target: 500000 },
        { id: 'glory_1m',   category: 'glory', name: 'Divine',    desc: 'Reach 1M Glory in a week',    icon: 'ph-asterisk',      color: '#fbbf24', target: 1000000 }
    ];

    // ── Category metadata (order + labels) ─────────────────────────────────────
    var CATEGORIES = [
        { id: 'rank',   label: 'Ranks',         icon: 'ph-shield',        color: '#fbbf24' },
        { id: 'tenure', label: 'Seniority',     icon: 'ph-hourglass',     color: '#34d399' },
        { id: 'power',  label: 'Power',         icon: 'ph-sword',         color: '#a78bfa' },
        { id: 'part',   label: 'Participation', icon: 'ph-calendar-check', color: '#22d3ee' },
        { id: 'glory',  label: 'Glory',         icon: 'ph-trophy',        color: '#fbbf24' }
    ];

    function parseRank(role) {
        var m = /^R(\d+)/i.exec(String(role || ''));
        return m ? parseInt(m[1], 10) : 1;
    }

    function daysSince(dateStr) {
        var d = new Date(dateStr);
        if (!dateStr || isNaN(d.getTime())) return 0;
        return Math.max(0, Math.floor((Date.now() - d.getTime()) / DAY_MS));
    }

    function clampPct(n) {
        if (!isFinite(n)) return 0;
        return Math.max(0, Math.min(100, Math.round(n)));
    }

    // ── Core: turn raw player data into the badge catalog ─────────────────────
    // player: { role, created_at, overall_power, attended }
    // Returns: { earned, total, categories: [{ id, label, icon, color, badges: [] }] }
    function computeBadges(player) {
        player = player || {};
        var rank = parseRank(player.role);
        var days = daysSince(player.created_at);
        var power = parseInt(player.overall_power, 10) || 0;
        var attended = parseInt(player.attended, 10) || 0;
        var glory = parseInt(player.glory_best, 10) || 0;

        var byCategory = {};
        var earnedCount = 0;

        CATALOG.forEach(function (def) {
            var current = 0;
            if (def.category === 'rank') current = rank;
            else if (def.category === 'tenure') current = days;
            else if (def.category === 'power') current = power;
            else if (def.category === 'part') current = attended;
            else if (def.category === 'glory') current = glory;

            var earned = current >= def.target;
            if (earned) earnedCount++;

            var progress = earned ? 100 : clampPct((current / def.target) * 100);

            var badge = {
                id: def.id,
                category: def.category,
                name: def.name,
                desc: def.desc,
                icon: def.icon,
                color: def.color,
                target: def.target,
                current: current,
                earned: earned,
                progress: progress
            };

            if (!byCategory[def.category]) byCategory[def.category] = [];
            byCategory[def.category].push(badge);
        });

        var categories = CATEGORIES.map(function (cat) {
            var badges = byCategory[cat.id] || [];
            var catEarned = badges.filter(function (b) { return b.earned; }).length;
            return {
                id: cat.id,
                label: cat.label,
                icon: cat.icon,
                color: cat.color,
                earned: catEarned,
                total: badges.length,
                badges: badges
            };
        });

        return {
            earned: earnedCount,
            total: CATALOG.length,
            categories: categories
        };
    }

    window.GM_BADGES = {
        computeBadges: computeBadges,
        parseRank: parseRank,
        daysSince: daysSince
    };
})();
