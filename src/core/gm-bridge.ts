/**
 * src/core/gm-bridge.ts
 *
 * Rebuilds the legacy `window.GM` surface (~108 members) from the typed /src
 * modules produced by the gm-utils Strangler sous-lots 5.2A/B/C. Uses a
 * non-destructive merge so test stubs and any already-set members win.
 *
 * Also exposes `window.GM_GVG_TASKS`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { APP_VERSION } from './config/constants';
import { initAppState } from './state/app-state';
import {
  escapeHTML, MAX_NUMERIC, formatNumber, parseNumber, formatPower, avatarInit,
  cleanPlayerPseudo, levenshteinDistance, calculateStringSimilarity, findBestMatchingMember,
  parseGeminiJson, normalizeRole, validatePseudo, validateUid
} from './utils/text';
import { parseSafeMetric, getPowerTier, getPowerTierMeta } from './utils/numbers';
import {
  getWeekStart, getPrevWeekStart, formatWeek, formatDateTimeUTC, newSessionId, formatChartDate
} from './utils/date';
import {
  isoWeekKey, dateKey, eventScoringKey, sessionDateFromId, buildEventSessionId,
  getEventIcon, getEventTheme, computeShadowfrontAttendanceRate, GVG_DAILY_TASKS, buildGvgDailyTaskEmbed
} from './config/events';
import { runInChunks, debounce } from './utils/async';
import {
  calculateCombatDensity, calculateRallyScore, calculateRallyGrade, calculateResidualPower,
  calculateCombativity, calculateWarScore, getRallyRoleMeta, getRoleInfo
} from './scoring/combat';
import { cache } from './cache/cache';
import { getGuildConfig, setGuildConfig, getGuildTag, config } from './config/guild-config';
import {
  parseFunctionsInvokeResult, ensureAuthSession, forceRefreshPortalSession, sessionInfo
} from './api/supabase';
import {
  roleFromStorage, isSuperAdmin, isServerAdmin, isGuildAdmin, getActiveGuild, getCurrentPseudo,
  canWriteGuild, ensureGuildRestriction, detectClientEnvironment,
  setVerifiedRole, getVerifiedRole, getVerifiedAccountId
} from './auth/roles';
import { showToast } from './dom/toast';
import { attachNumberFormatter, pickEventStart, openTermsModal, closeTermsModal, drawScoreTrendChart } from './dom/ui';
import {
  formatDiscordRoleMention, resolveDiscordWebhook, sendDiscordWebhook, sendDiscordWebhookDetailed, notifyDiscordEvent,
  testDiscordWebhook
} from './integrations/discord';
import { parseOcrScore } from '../modules/ocr/ocr.service';
import {
  login, logout, registerPlayer, submitGuildRequest, adminAccounts, generateJoinCode,
  loginWithDiscord, redeemDiscordTicket, redeemLinkCode, claimWithDiscord, onboardWithDiscord,
  loginWithBackupCodeDiscord,
  loginWithPasskey, loginWithBackupCode, startConditionalPasskeyLogin, abortConditionalPasskeyLogin
} from './auth/session';
import {
  getUidStatus, isInvalidOrTempUid, categorizeOcrDiff, computeOcrRosterDelta,
  ocrGridDiffRatio, ocrDownsampleEvenly, upsertPlayerMetrics, compressImageForUpload, exportGuildData,
  fuseOcrPlayers, ocrMeasureFrameSharpness
} from '../modules/ocr/ocr.service';
import {
  getAllowedBulkRoles, isRoleAllowedForBulk, filterBulkEligibleMembers,
  shareMatchupRosterToDiscord, formatTicketDescription
} from '../modules/members/members.service';

function winAny(): any {
  return (typeof window !== 'undefined' ? window : {}) as any;
}

/** Merges every ported member into window.GM (only where still undefined). */
export function installGmBridge(): void {
  const w = winAny();
  w.GM = w.GM || {};

  const members: Record<string, unknown> = {
    // Config / constants
    appVersion: APP_VERSION,
    MAX_NUMERIC: MAX_NUMERIC,

    // Utils: text
    escapeHTML, formatNumber, parseNumber, formatPower, avatarInit, cleanPlayerPseudo,
    levenshteinDistance, calculateStringSimilarity, findBestMatchingMember, parseGeminiJson,
    parseOcrScore, normalizeRole, validatePseudo, validateUid,

    // Utils: numbers / tiers
    parseSafeMetric, getPowerTier, getPowerTierMeta,

    // Utils: dates
    getWeekStart, getPrevWeekStart, formatWeek, formatDateTimeUTC, newSessionId, formatChartDate,

    // Utils: async
    runInChunks, debounce,

    // Events
    isoWeekKey, dateKey, eventScoringKey, sessionDateFromId, buildEventSessionId,
    getEventIcon, getEventTheme, computeShadowfrontAttendanceRate,

    // Scoring
    calculateCombatDensity, calculateRallyScore, calculateRallyGrade, calculateResidualPower,
    calculateCombativity, calculateWarScore, getRallyRoleMeta, getRoleInfo,

    // Cache / config
    cache, config, getGuildConfig, setGuildConfig, getGuildTag,

    // API
    parseFunctionsInvokeResult, ensureAuthSession, forceRefreshPortalSession, sessionInfo,

    // Roles / context
    roleFromStorage, isSuperAdmin, isServerAdmin, isGuildAdmin, getActiveGuild, getCurrentPseudo,
    canWriteGuild, ensureGuildRestriction,
    detectClientEnvironment, setVerifiedRole, getVerifiedRole, getVerifiedAccountId,

    // DOM / UI
    showToast, attachNumberFormatter, pickEventStart, openTermsModal, closeTermsModal, drawScoreTrendChart,

    // Discord
    formatDiscordRoleMention, resolveDiscordWebhook, sendDiscordWebhook, sendDiscordWebhookDetailed,
    notifyDiscordEvent, testDiscordWebhook,

    // Auth / sessions
    login, logout, registerPlayer, submitGuildRequest, adminAccounts, generateJoinCode,
  loginWithDiscord, redeemDiscordTicket, redeemLinkCode, claimWithDiscord, onboardWithDiscord,
  loginWithBackupCodeDiscord,
    loginWithPasskey, loginWithBackupCode, startConditionalPasskeyLogin, abortConditionalPasskeyLogin,

    // OCR
    getUidStatus, isInvalidOrTempUid, categorizeOcrDiff, computeOcrRosterDelta, ocrGridDiffRatio,
    ocrDownsampleEvenly, upsertPlayerMetrics, compressImageForUpload, exportGuildData,
    fuseOcrPlayers, ocrMeasureFrameSharpness,

    // Members / tickets
    getAllowedBulkRoles, isRoleAllowedForBulk, filterBulkEligibleMembers,
    shareMatchupRosterToDiscord, formatTicketDescription,

    // GvG daily tasks (legacy GM.gvgTasks shape)
    gvgTasks: { GVG_DAILY_TASKS, buildGvgDailyTaskEmbed }
  };

  Object.keys(members).forEach((key) => {
    if (w.GM[key] === undefined) w.GM[key] = members[key];
  });

  // The bridge installs before main.ts calls initAppState(), and several
  // consumers read `window.guildsList` in between. Establishing the whole
  // mirror here -- rather than patching this one global by hand -- means every
  // key exists from the first line that can observe it. initAppState() is
  // idempotent: it hydrates from `window` before writing back.
  initAppState();
  w.GM_GVG_TASKS = { GVG_DAILY_TASKS, buildGvgDailyTaskEmbed };
}
