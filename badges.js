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
        { id: 'tenure_1m', category: 'tenure', name: 'Newcomer',  desc: 'Stay 1 month in the guild',      icon: 'ph-hourglass',   color: '#34d399', target: 30 },
        { id: 'tenure_3m', category: 'tenure', name: 'Member',    desc: 'Stay 3 months in the guild',     icon: 'ph-user-clock',  color: '#34d399', target: 90 },
        { id: 'tenure_6m', category: 'tenure', name: 'Seasoned',  desc: 'Stay 6 months in the guild',     icon: 'ph-users',       color: '#34d399', target: 180 },
        { id: 'tenure_1y', category: 'tenure', name: 'Alumnus',   desc: 'Stay 1 year in the guild',       icon: 'ph-trophy',      color: '#34d399', target: 365 },
        { id: 'tenure_2y', category: 'tenure', name: 'Legend',    desc: 'Stay 2 years in the guild',      icon: 'ph-crown',       color: '#34d399', target: 730 },
        // Power: current overall_power in the guild roster.
        { id: 'power_10m',  category: 'power', name: 'Fighter',   desc: 'Reach 10M combat power',   icon: 'ph-sword',     color: '#a78bfa', target: 10000000 },
        { id: 'power_50m',  category: 'power', name: 'Brawler',   desc: 'Reach 50M combat power',   icon: 'ph-crosshair', color: '#a78bfa', target: 50000000 },
        { id: 'power_100m', category: 'power', name: 'Titan',     desc: 'Reach 100M combat power',  icon: 'ph-barbell',   color: '#a78bfa', target: 100000000 },
        { id: 'power_500m', category: 'power', name: 'Colossus',  desc: 'Reach 500M combat power',  icon: 'ph-lightning', color: '#a78bfa', target: 500000000 },
        { id: 'power_1b',   category: 'power', name: 'Overlord',  desc: 'Reach 1B combat power',    icon: 'ph-fire',      color: '#a78bfa', target: 1000000000 },
        // Participation: events attended (participated or sub-present).
        { id: 'part_10',  category: 'part', name: 'Active',    desc: 'Attend 10 events',     icon: 'ph-check-circle',  color: '#22d3ee', target: 10 },
        { id: 'part_25',  category: 'part', name: 'Reliable',  desc: 'Attend 25 events',     icon: 'ph-calendar-check', color: '#22d3ee', target: 25 },
        { id: 'part_50',  category: 'part', name: 'Dedicated', desc: 'Attend 50 events',     icon: 'ph-flame',          color: '#22d3ee', target: 50 },
        { id: 'part_100', category: 'part', name: 'Iron Will', desc: 'Attend 100 events',    icon: 'ph-star',           color: '#22d3ee', target: 100 }
    ];

    // ── Category metadata (order + labels) ─────────────────────────────────────
    var CATEGORIES = [
        { id: 'rank',   label: 'Ranks',         icon: 'ph-shield',        color: '#fbbf24' },
        { id: 'tenure', label: 'Seniority',     icon: 'ph-hourglass',     color: '#34d399' },
        { id: 'power',  label: 'Power',         icon: 'ph-sword',         color: '#a78bfa' },
        { id: 'part',   label: 'Participation', icon: 'ph-calendar-check', color: '#22d3ee' }
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

        var byCategory = {};
        var earnedCount = 0;

        CATALOG.forEach(function (def) {
            var current = 0;
            if (def.category === 'rank') current = rank;
            else if (def.category === 'tenure') current = days;
            else if (def.category === 'power') current = power;
            else if (def.category === 'part') current = attended;

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
