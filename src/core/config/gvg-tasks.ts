/**
 * src/core/config/gvg-tasks.ts
 *
 * Guild vs Guild (GvG) Daily Task Reminders & Points Breakdown.
 * Exact point values for Day 1 (Monday) through Day 6 (Saturday).
 */

export interface GvgTaskCategory {
  title: string;
  emoji: string;
  tasks: Array<{ label: string; points: string }>;
}

export interface GvgDailyTaskDay {
  dayNumber: number;
  dayName: string;
  theme: string;
  color: number;
  categories: GvgTaskCategory[];
}

export const GVG_DAILY_TASKS: Record<number, GvgDailyTaskDay> = {
  1: {
    dayNumber: 1,
    dayName: "Monday",
    theme: "Speedups, Trade, Rallies & Ascendancy Minions",
    color: 436900, // #06b6d4 Cyan
    categories: [
      {
        title: "Speedups & Trade",
        emoji: "⚡",
        tasks: [
          { label: "Every 1m Build Speedups consumed", points: "+48 pts" },
          { label: "Consume 1 min(s) of Shipbuilding Speedup", points: "+48 pts" },
          { label: "Complete trade shipping 3 time(s)", points: "+1,000 pts" },
        ],
      },
      {
        title: "Rallies",
        emoji: "🎯",
        tasks: [
          { label: "Launch a rally and defeat 1 Deliverer Ark", points: "+18,000 pts" },
          { label: "Launch a rally and earn Tribute Vessel rewards 1 time(s) by defeating Lvl 1-60 Tribute Vessels", points: "+18,000 pts" },
          { label: "Launch a rally and defeat the Sacred Tribute Vessel once", points: "+6,000 pts" },
        ],
      },
      {
        title: "Ascendancy Minions",
        emoji: "👾",
        tasks: [
          { label: "Defeat 1 Lvl 1-10 Ascendancy Minion(s)", points: "+3,000 pts" },
          { label: "Defeat 1 Lvl 11-20 Ascendancy Minion(s)", points: "+3,600 pts" },
          { label: "Defeat 1 Lvl 21-30 Ascendancy Minion(s)", points: "+4,200 pts" },
          { label: "Defeat 1 Lvl 31-40 Ascendancy Minion(s)", points: "+4,800 pts" },
          { label: "Defeat 1 Lvl 41-50 Ascendancy Minion(s)", points: "+5,400 pts" },
          { label: "Defeat 1 Lvl 51-60 Ascendancy Minion(s)", points: "+6,000 pts" },
        ],
      },
      {
        title: "Packs",
        emoji: "💎",
        tasks: [
          { label: "Earn 1 Credit(s) through packs", points: "+4 pts" },
        ],
      },
    ],
  },
  2: {
    dayNumber: 2,
    dayName: "Tuesday",
    theme: "Champions, Weapons, Commissions & Commerce",
    color: 9133302, // #8b5cf6 Violet
    categories: [
      {
        title: "Champions & Power",
        emoji: "👑",
        tasks: [
          { label: "Consume 1 Champion Fragments to unlock Champions, activate the Wall of Honor, or promote Legendary Champions", points: "+6,000 pts" },
          { label: "Consume 1 Champion Fragments to unlock Champions, activate the Wall of Honor, or promote Epic Champions", points: "+300 pts" },
          { label: "Increase Power by 1 through leveling up/unlocking/promoting Champions", points: "+3 pts" },
          { label: "Spend Legendary Training Manual × 1 during the event", points: "+600 pts" },
          { label: "Spend Venturous Memory × 1 during the event", points: "+2,400 pts" },
        ],
      },
      {
        title: "Weapons",
        emoji: "⚔️",
        tasks: [
          { label: "Spend Weapon Prism × 1 during the event", points: "+4,000 pts" },
          { label: "Consume 1 Weapon Energy Core(s)", points: "+18 pts" },
          { label: "Consume Weapon Fragment × 1 of rarity Epic", points: "+2,400 pts" },
          { label: "Consume Weapon Fragment × 1 of rarity Legendary", points: "+12,000 pts" },
        ],
      },
      {
        title: "Commissions",
        emoji: "📜",
        tasks: [
          { label: "Complete 1 commission(s) of quality Common", points: "+6,000 pts" },
          { label: "Complete 1 commission(s) of quality Uncommon", points: "+7,500 pts" },
          { label: "Complete 1 commission(s) of quality Rare", points: "+8,250 pts" },
          { label: "Complete 1 commission(s) of quality Epic", points: "+9,000 pts" },
          { label: "Complete 1 commission(s) of quality Legendary", points: "+9,750 pts" },
        ],
      },
      {
        title: "Commerce Guild & Packs",
        emoji: "🏛️",
        tasks: [
          { label: "Complete 1 Commerce Guild Assist(s)", points: "+20 pts" },
          { label: "Perform Commerce Guild Donation 1 time(s)", points: "+50 pts" },
          { label: "Earn 1 Credit(s) through packs", points: "+4 pts" },
        ],
      },
    ],
  },
  3: {
    dayNumber: 3,
    dayName: "Wednesday",
    theme: "Technology, Research, Ruins & Exploration",
    color: 3899894, // #3b82f6 Blue
    categories: [
      {
        title: "Technology & Research",
        emoji: "🔬",
        tasks: [
          { label: "Every 1m Technology Speedups consumed", points: "+48 pts" },
          { label: "Spend Computational Component × 1 during the event", points: "+400 pts" },
          { label: "Spend Deep Space Beacon × 1 during the event", points: "+800 pts" },
          { label: "Spend Echo Module × 1 during the event", points: "+80 pts" },
          { label: "Spend Echoes of Deep Space × 1 during the event", points: "+16,000 pts" },
        ],
      },
      {
        title: "Ruins & Exploration",
        emoji: "🌌",
        tasks: [
          { label: "Excavate a Ruin of Legendary quality once", points: "+30,000 pts" },
          { label: "Successfully plunder a Ruin 1 time(s)", points: "+50,000 pts" },
          { label: "Perform 1 Map Search(es)", points: "+360,000 pts" },
        ],
      },
      {
        title: "Packs",
        emoji: "💎",
        tasks: [
          { label: "Earn 1 Credit(s) through packs", points: "+4 pts" },
        ],
      },
    ],
  },
  4: {
    dayNumber: 4,
    dayName: "Thursday",
    theme: "Flagship, Commissions & Packs",
    color: 16096779, // #f59e0b Amber
    categories: [
      {
        title: "Flagship",
        emoji: "🛸",
        tasks: [
          { label: "Boost Power by 1 through upgrading, unlocking, or advancing the flagship, or developing flagship components", points: "+3 pts" },
          { label: "Consume 1 Flagship Blueprints", points: "+6,000 pts" },
          { label: "Spend Prismatic Core × 1 during the event", points: "+2,400 pts" },
        ],
      },
      {
        title: "Commissions",
        emoji: "📜",
        tasks: [
          { label: "Complete 1 commission(s) of quality Common", points: "+6,000 pts" },
          { label: "Complete 1 commission(s) of quality Uncommon", points: "+7,500 pts" },
          { label: "Complete 1 commission(s) of quality Rare", points: "+8,250 pts" },
          { label: "Complete 1 commission(s) of quality Epic", points: "+9,000 pts" },
          { label: "Complete 1 commission(s) of quality Legendary", points: "+9,750 pts" },
        ],
      },
      {
        title: "Packs",
        emoji: "💎",
        tasks: [
          { label: "Earn 1 Credit(s) through packs", points: "+4 pts" },
        ],
      },
    ],
  },
  5: {
    dayNumber: 5,
    dayName: "Friday",
    theme: "All-Out Preparation: Speedups, Champions, Flagship, Rallies & Weapons",
    color: 16007006, // #f43f5e Rose
    categories: [
      {
        title: "Speedups & Trade",
        emoji: "⚡",
        tasks: [
          { label: "Every 1m Build Speedups consumed", points: "+48 pts" },
          { label: "Every 1m Technology Speedups consumed", points: "+48 pts" },
          { label: "Consume 1 min(s) of Shipbuilding Speedup", points: "+48 pts" },
          { label: "Complete trade shipping 3 time(s)", points: "+1,000 pts" },
        ],
      },
      {
        title: "Champions & Flagship",
        emoji: "👑",
        tasks: [
          { label: "Consume 1 Champion Fragments to unlock Champions, activate the Wall of Honor, or promote Legendary Champions", points: "+6,000 pts" },
          { label: "Consume 1 Champion Fragments to unlock Champions, activate the Wall of Honor, or promote Epic Champions", points: "+300 pts" },
          { label: "Increase Power by 1 through leveling up/unlocking/promoting Champions", points: "+3 pts" },
          { label: "Spend Legendary Training Manual × 1 during the event", points: "+600 pts" },
          { label: "Spend Venturous Memory × 1 during the event", points: "+2,400 pts" },
          { label: "Boost Power by 1 through upgrading, unlocking, or advancing the flagship, or developing flagship components", points: "+3 pts" },
          { label: "Consume 1 Flagship Blueprints", points: "+6,000 pts" },
          { label: "Spend Prismatic Core × 1 during the event", points: "+2,400 pts" },
        ],
      },
      {
        title: "Rallies & Technology",
        emoji: "🎯",
        tasks: [
          { label: "Launch a rally and earn Tribute Vessel rewards 1 time(s) by defeating Lvl 1-60 Tribute Vessels", points: "+18,000 pts" },
          { label: "Spend Computational Component × 1 during the event", points: "+400 pts" },
          { label: "Spend Deep Space Beacon × 1 during the event", points: "+800 pts" },
          { label: "Spend Echo Module × 1 during the event", points: "+80 pts" },
          { label: "Spend Echoes of Deep Space × 1 during the event", points: "+16,000 pts" },
        ],
      },
      {
        title: "Weapons & Exploration",
        emoji: "⚔️",
        tasks: [
          { label: "Spend Weapon Prism × 1 during the event", points: "+4,000 pts" },
          { label: "Consume 1 Weapon Energy Core(s)", points: "+18 pts" },
          { label: "Consume Weapon Fragment × 1 of rarity Epic", points: "+2,400 pts" },
          { label: "Consume Weapon Fragment × 1 of rarity Legendary", points: "+12,000 pts" },
          { label: "Excavate a Ruin of Legendary quality once", points: "+30,000 pts" },
          { label: "Successfully plunder a Ruin 1 time(s)", points: "+50,000 pts" },
          { label: "Perform 1 Map Search(es)", points: "+360,000 pts" },
        ],
      },
      {
        title: "Commissions & Packs",
        emoji: "📜",
        tasks: [
          { label: "Complete 1 commission(s) (Common: +6k | Uncommon: +7.5k | Rare: +8.25k | Epic: +9k | Leg: +9.75k)", points: "+6k to +9.75k pts" },
          { label: "Earn 1 Credit(s) through packs", points: "+4 pts" },
        ],
      },
    ],
  },
  6: {
    dayNumber: 6,
    dayName: "Saturday",
    theme: "Total War: War Prism, Fortresses, Glory & PvP Fleet Battles",
    color: 15680580, // #ef4444 Red
    categories: [
      {
        title: "War Prism, Shrine & Fortresses",
        emoji: "🏰",
        tasks: [
          { label: "Every 100 damage dealt to the War Prism", points: "+10 pts" },
          { label: "Deliver the last hit to the War Prism", points: "+1,000,000 pts" },
          { label: "Seize 1 Legendary quality Flagship Component Fragment(s) by defeating the Ascendancy Shrine", points: "+60,000 pts" },
          { label: "Station 2 min in War Fortresses to earn points", points: "+50,000 pts" },
        ],
      },
      {
        title: "Shipbuilding & Glory",
        emoji: "🚢",
        tasks: [
          { label: "Consume 1 min(s) of Shipbuilding Speedup", points: "+48 pts" },
          { label: "For every 1 Glory earned from the opposing Commerce Guild", points: "+3 pts" },
        ],
      },
      {
        title: "Defeating Enemy Craft (PvP)",
        emoji: "💥",
        tasks: [
          { label: "T1: +1,500 pts | T2: +9,000 pts | T3: +24,000 pts | T4: +45,000 pts", points: "Tier 1-4" },
          { label: "T5: +75,000 pts | T6: +120,000 pts | T7: +180,000 pts", points: "Tier 5-7" },
        ],
      },
      {
        title: "Losing Craft in Battle (PvP)",
        emoji: "🛡️",
        tasks: [
          { label: "T1: +1,500 pts | T2: +9,000 pts | T3: +24,000 pts | T4: +45,000 pts", points: "Tier 1-4" },
          { label: "T5: +75,000 pts | T6: +120,000 pts | T7: +180,000 pts", points: "Tier 5-7" },
        ],
      },
    ],
  },
};

export function buildGvgDailyTaskEmbed(dayNumber: number, roleMention = "@everyone"): { content: string; embeds: any[] } {
  const day = GVG_DAILY_TASKS[dayNumber] || GVG_DAILY_TASKS[1];

  const fields = day.categories.map((cat) => {
    const lines = cat.tasks.map((t) => `• ${t.label}: **\`${t.points}\`**`).join("\n");
    return {
      name: `${cat.emoji} ${cat.title}`,
      value: lines,
      inline: false,
    };
  });

  const content = `📢 **GvG Day ${day.dayNumber} Tasks are Live!** (${day.dayName} · 00:01 UTC) ${roleMention}`;

  const embed = {
    title: `⚔️ GvG Day ${day.dayNumber} Tasks: ${day.theme}`,
    description: `Daily point breakdown & scoring priorities for **Guild vs Guild — Day ${day.dayNumber} (${day.dayName})**.\nCoordinate with your guild members and maximize points!`,
    color: day.color,
    fields,
    timestamp: new Date().toISOString(),
    footer: {
      text: "FGF Guild Management Tool • GvG Daily Reminders (00:01 UTC)",
    },
  };

  return {
    content,
    embeds: [embed],
  };
}

if (typeof window !== "undefined") {
  (window as any).GM_GVG_TASKS = {
    GVG_DAILY_TASKS,
    buildGvgDailyTaskEmbed,
  };
}
