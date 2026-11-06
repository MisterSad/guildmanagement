/**
 * src/modules/app/ocr/ocr.meta.ts
 *
 * Sous-lot 6.7 (Strangler) — OCR metric mode metadata + module state ported
 * from app.js (OCR_METRICS_META, currentOcrMetric, ocrExtractedPlayers).
 */

export interface OcrMetricMeta {
  title: string;
  subtitle: string;
  dropTitle: string;
  dropDesc: string;
  header: string;
  field: string;
  color: string;
  icon: string;
  isMultiGuild: boolean;
  isEvent?: boolean;
  eventType?: 'standard' | 'shadowfront' | 'armsrace';
  eventKey?: string;
  squad?: 'squad1' | 'squad2';
  stage?: 'stageA' | 'stageB';
  /** Valid target-day range for per-day war metrics (svs_day / gvg_day). */
  dayRange?: [number, number];
}

export const OCR_METRICS_META: Record<string, OcrMetricMeta> = {
  members: {
    title: '1. Members OCR — Full Roster Management',
    subtitle:
      "Upload full guild roster screenshots to add recruits (with real UID validation), update power, assign R1-R4 rank from the roster's section headers, and detect removed members",
    dropTitle: 'Drop full guild roster screenshots here or click to browse',
    dropDesc:
      'Screenshots or a scroll-recording video · PNG/JPG/WEBP/MP4/MOV (Full Roster: adds, updates, assigns rank, and detects departures)',
    header: 'Members',
    field: 'overall_power',
    color: '#10b981',
    icon: 'ph-users',
    isMultiGuild: false,
    isEvent: false,
  },
  power: {
    title: '2. Power OCR — Overall Total Power',
    subtitle: 'Upload guild roster screenshots to update overall power levels (update-only for existing members)',
    dropTitle: 'Drop Overall Power screenshots here or click to browse',
    dropDesc:
      'Screenshots or a scroll-recording video · PNG/JPG/WEBP/MP4/MOV (Intra-Guild: updates existing roster members)',
    header: 'Extracted Power',
    field: 'overall_power',
    color: '#818cf8',
    icon: 'ph-sword',
    isMultiGuild: false,
  },
  fleet: {
    title: '3. Fleet OCR — Strongest Fleet Rating (Server Leaderboard)',
    subtitle: 'Upload Strongest Fleet / March 1 leaderboards to update strike ratings and rally capabilities',
    dropTitle: 'Drop Strongest Fleet leaderboard screenshots here or click to browse',
    dropDesc:
      'Screenshots or a scroll-recording video · PNG/JPG/WEBP/MP4/MOV (Server Leaderboard: filters by your Guild Tag)',
    header: 'Extracted Fleet Rating',
    field: 'fleet_rating',
    color: '#60a5fa',
    icon: 'ph-shooting-star',
    isMultiGuild: true,
  },
  tech: {
    title: '4. Tech OCR — Technology Power',
    subtitle: 'Upload Technology Power leaderboards to track research advancement across members',
    dropTitle: 'Drop Technology Power leaderboard screenshots here or click to browse',
    dropDesc:
      'Screenshots or a scroll-recording video · PNG/JPG/WEBP/MP4/MOV (Intra-Guild: extracts Alliance/Individual Tech values)',
    header: 'Extracted Tech Power',
    field: 'tech_power',
    color: '#a78bfa',
    icon: 'ph-atom',
    isMultiGuild: false,
  },
  flagship: {
    title: '5. Flagship OCR — Flagship Power (Server Leaderboard)',
    subtitle: 'Upload Flagship power leaderboards to track capital ship strength and hulls',
    dropTitle: 'Drop Flagship Power leaderboard screenshots here or click to browse',
    dropDesc:
      'Screenshots or a scroll-recording video · PNG/JPG/WEBP/MP4/MOV (Server Leaderboard: filters by your Guild Tag)',
    header: 'Extracted Flagship Power',
    field: 'flagship_power',
    color: '#fbbf24',
    icon: 'ph-rocket',
    isMultiGuild: true,
  },
  champs: {
    title: '6. Champs OCR — Champions Total Power (Server Leaderboard)',
    subtitle: 'Upload Champion Total Power leaderboards to track hero collections and ranks',
    dropTitle: 'Drop Champions Total Power leaderboard screenshots here or click to browse',
    dropDesc:
      'Screenshots or a scroll-recording video · PNG/JPG/WEBP/MP4/MOV (Server Leaderboard: filters by your Guild Tag)',
    header: 'Extracted Champions Power',
    field: 'champion_power',
    color: '#f472b6',
    icon: 'ph-crown',
    isMultiGuild: true,
  },
  crew: {
    title: '7. Crew OCR — Crew Total Power (Server Leaderboard)',
    subtitle: 'Upload Crew Total Power leaderboards to evaluate Foundation officer development',
    dropTitle: 'Drop Crew Total Power leaderboard screenshots here or click to browse',
    dropDesc:
      'Screenshots or a scroll-recording video · PNG/JPG/WEBP/MP4/MOV (Server Leaderboard: filters by your Guild Tag)',
    header: 'Extracted Crew Power',
    field: 'crew_power',
    color: '#38bdf8',
    icon: 'ph-users-three',
    isMultiGuild: true,
  },
  glory: {
    title: '8. Glory OCR — Weekly Glory Score',
    subtitle: 'Upload Glory rankings to track weekly battle points and PvP contribution',
    dropTitle: 'Drop Glory Ranking leaderboard screenshots here or click to browse',
    dropDesc:
      'Screenshots or a scroll-recording video · PNG/JPG/WEBP/MP4/MOV (Intra-Guild: extracts Glory score points)',
    header: 'Extracted Glory Score',
    field: 'glory_score',
    color: '#34d399',
    icon: 'ph-trophy',
    isMultiGuild: false,
  },
  svs_prep: {
    title: 'SvS Day 1 to 5 OCR — Preparation Total',
    subtitle:
      'Upload SvS Day 1-5 screenshots to import the cumulative prep total (Day 1 to 5) and validate participation for your guild',
    dropTitle: 'Drop SvS Day 1 to 5 screenshots here or click to browse',
    dropDesc: 'Screenshots or a scroll-recording video · PNG/JPG/WEBP/MP4/MOV (Targets members with your Guild Tag)',
    header: 'SvS Prep Total (D1–D5)',
    field: 'score_prep',
    color: '#f59e0b',
    icon: 'ph-sword',
    isMultiGuild: true,
    isEvent: true,
    eventType: 'standard',
    eventKey: 'SvS',
  },
  svs_day: {
    title: 'SvS Day N OCR — Daily Preparation Score',
    subtitle: "Upload a single SvS preparation day screenshot to import that day's scores into the daily grid",
    dropTitle: 'Drop the target SvS day screenshot here or click to browse',
    dropDesc:
      'Screenshots or a scroll-recording video · PNG/JPG/WEBP/MP4/MOV (Per-day grid: pick the N day of the screenshot first)',
    header: 'SvS Day N Prep Score',
    field: 'score_prep',
    color: '#f59e0b',
    icon: 'ph-calendar-dots',
    isMultiGuild: true,
    isEvent: true,
    eventType: 'standard',
    eventKey: 'SvS',
    dayRange: [1, 5],
  },
  svs_pvp: {
    title: 'SvS Day 6 OCR — PvP Battle Day',
    subtitle: 'Upload SvS Day 6 PvP screenshots to import battle scores and validate participation for your guild',
    dropTitle: 'Drop SvS Day 6 PvP screenshots here or click to browse',
    dropDesc: 'Screenshots or a scroll-recording video · PNG/JPG/WEBP/MP4/MOV (Targets members with your Guild Tag)',
    header: 'SvS PvP Score',
    field: 'score_pvp',
    color: '#f97316',
    icon: 'ph-fire',
    isMultiGuild: true,
    isEvent: true,
    eventType: 'standard',
    eventKey: 'SvS',
  },
  gvg_prep: {
    title: 'GvG Day 1 to 5 OCR — Preparation Total',
    subtitle:
      'Upload GvG Day 1-5 screenshots to import the cumulative prep total (Day 1 to 5) and validate participation for your guild',
    dropTitle: 'Drop GvG Day 1 to 5 screenshots here or click to browse',
    dropDesc: 'Screenshots or a scroll-recording video · PNG/JPG/WEBP/MP4/MOV (Targets members with your Guild Tag)',
    header: 'GvG Prep Total (D1–D5)',
    field: 'score_prep',
    color: '#60a5fa',
    icon: 'ph-flag-banner',
    isMultiGuild: true,
    isEvent: true,
    eventType: 'standard',
    eventKey: 'GvG',
  },
  gvg_day: {
    title: 'GvG Day N OCR — Daily Preparation Score',
    subtitle: "Upload a single GvG preparation day screenshot to import that day's scores into the daily grid",
    dropTitle: 'Drop the target GvG day screenshot here or click to browse',
    dropDesc:
      'Screenshots or a scroll-recording video · PNG/JPG/WEBP/MP4/MOV (Per-day grid: pick the N day of the screenshot first)',
    header: 'GvG Day N Prep Score',
    field: 'score_prep',
    color: '#60a5fa',
    icon: 'ph-calendar-dots',
    isMultiGuild: true,
    isEvent: true,
    eventType: 'standard',
    eventKey: 'GvG',
    dayRange: [1, 5],
  },
  gvg_pvp: {
    title: 'GvG Day 6 OCR — PvP Battle Day',
    subtitle: 'Upload GvG Day 6 PvP screenshots to import battle scores and validate participation for your guild',
    dropTitle: 'Drop GvG Day 6 PvP screenshots here or click to browse',
    dropDesc: 'Screenshots or a scroll-recording video · PNG/JPG/WEBP/MP4/MOV (Targets members with your Guild Tag)',
    header: 'GvG PvP Score',
    field: 'score_pvp',
    color: '#38bdf8',
    icon: 'ph-sword',
    isMultiGuild: true,
    isEvent: true,
    eventType: 'standard',
    eventKey: 'GvG',
  },
  shadowfront_s1: {
    title: 'Shadowfront S1 OCR — Squad 1 Battle & Roster',
    subtitle:
      'Upload Shadowfront Squad 1 screenshots to validate Main squad (Participated) and Substitutes (Sub Present + Participated)',
    dropTitle: 'Drop Shadowfront Squad 1 screenshots here or click to browse',
    dropDesc: 'Screenshots or a scroll-recording video · PNG/JPG/WEBP/MP4/MOV (Detects Squad 1 Main & Reserve members)',
    header: 'Squad 1 Status',
    field: 'participated',
    color: '#a855f7',
    icon: 'ph-users-three',
    isMultiGuild: false,
    isEvent: true,
    eventType: 'shadowfront',
    squad: 'squad1',
  },
  shadowfront_s2: {
    title: 'Shadowfront S2 OCR — Squad 2 Battle & Roster',
    subtitle:
      'Upload Shadowfront Squad 2 screenshots to validate Main squad (Participated) and Substitutes (Sub Present + Participated)',
    dropTitle: 'Drop Shadowfront Squad 2 screenshots here or click to browse',
    dropDesc: 'Screenshots or a scroll-recording video · PNG/JPG/WEBP/MP4/MOV (Detects Squad 2 Main & Reserve members)',
    header: 'Squad 2 Status',
    field: 'participated',
    color: '#d946ef',
    icon: 'ph-users-three',
    isMultiGuild: false,
    isEvent: true,
    eventType: 'shadowfront',
    squad: 'squad2',
  },
  dtr: {
    title: 'DTR OCR — Defend Trade Route',
    subtitle: 'Upload DTR screenshots to validate Participated (>0 pts) or Appointed + Participated (=0 pts)',
    dropTitle: 'Drop Defend Trade Route screenshots here or click to browse',
    dropDesc:
      'Screenshots or a scroll-recording video · PNG/JPG/WEBP/MP4/MOV (Auto-determines Participated vs Appointed)',
    header: 'DTR Status',
    field: 'participated',
    color: '#10b981',
    icon: 'ph-truck',
    isMultiGuild: false,
    isEvent: true,
    eventType: 'standard',
    eventKey: 'Defend Trade Route',
  },
  armsrace_sa: {
    title: 'Arms Race SA OCR — Stage A Participation',
    subtitle: 'Upload Stage A screenshots to validate member participation',
    dropTitle: 'Drop Arms Race Stage A screenshots here or click to browse',
    dropDesc: 'Screenshots or a scroll-recording video · PNG/JPG/WEBP/MP4/MOV (Validates Stage A Participated)',
    header: 'Stage A Status',
    field: 'participated',
    color: '#f43f5e',
    icon: 'ph-lightning',
    isMultiGuild: false,
    isEvent: true,
    eventType: 'armsrace',
    stage: 'stageA',
  },
  armsrace_sb: {
    title: 'Arms Race SB OCR — Stage B Participation',
    subtitle: 'Upload Stage B screenshots to validate member participation',
    dropTitle: 'Drop Arms Race Stage B screenshots here or click to browse',
    dropDesc: 'Screenshots or a scroll-recording video · PNG/JPG/WEBP/MP4/MOV (Validates Stage B Participated)',
    header: 'Stage B Status',
    field: 'participated',
    color: '#ef4444',
    icon: 'ph-crosshair',
    isMultiGuild: false,
    isEvent: true,
    eventType: 'armsrace',
    stage: 'stageB',
  },
};

export const DEFAULT_OCR_METRIC = 'members';

/**
 * War prep OCR metrics routing to the aggregate (day = 0) "Day 1 to 5 total"
 * container. Per-day prep (svs_day / gvg_day) and Day 6 (svs_pvp / gvg_pvp)
 * are separate metrics that write day = scanDay and day = 6 respectively.
 */
export const WAR_LEGACY_OCR_METRICS = ['svs_prep', 'gvg_prep'] as const;

export function isWarLegacyOcrMetric(metric: string): boolean {
  return (WAR_LEGACY_OCR_METRICS as readonly string[]).indexOf(metric) !== -1;
}

let currentOcrMetric = DEFAULT_OCR_METRIC;
let ocrExtractedPlayers: any[] = [];

/** Validated numeric day (1..6) for per-day war metrics (svs_day / gvg_day). */
let currentOcrScanDay = 1;

export function getCurrentOcrMetric(): string {
  return currentOcrMetric;
}
export function setCurrentOcrMetric(metric: string): void {
  if (!OCR_METRICS_META[metric]) metric = DEFAULT_OCR_METRIC;
  currentOcrMetric = metric;
}
export function getOcrScanDay(): number {
  return currentOcrScanDay;
}
export function setOcrScanDay(day: number): void {
  const n = Number(day);
  currentOcrScanDay = Number.isInteger(n) && n >= 1 && n <= 6 ? n : 1;
}
export function getOcrExtractedPlayers(): any[] {
  return ocrExtractedPlayers;
}
export function setOcrExtractedPlayers(players: any[]): void {
  ocrExtractedPlayers = Array.isArray(players) ? players : [];
}
/** What a video scan's reading covered, as the Edge Function measured it (ADR-021). */
export interface OcrVideoCoverage {
  expected: number | null;
  found: number;
  missingPositions: number[];
}

let ocrVideoCoverage: OcrVideoCoverage | null = null;

export function getOcrVideoCoverage(): OcrVideoCoverage | null {
  return ocrVideoCoverage;
}
export function setOcrVideoCoverage(coverage: OcrVideoCoverage | null): void {
  ocrVideoCoverage = coverage;
}
export function getOcrMeta(metric?: string): OcrMetricMeta {
  return OCR_METRICS_META[metric || currentOcrMetric] || OCR_METRICS_META.power;
}
/** Display label only: the server picks the model (supabase/functions/_shared/openrouter.ts, ADR-024). */
export function getOcrModel(): string {
  return 'google/gemini-3.8-flash';
}
