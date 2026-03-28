import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getHudPluginDir } from './claude-config-dir.js';
import type { UsageData } from './types.js';

type CachedGlmUsage = {
  fetchedAt: number;
  usageData: UsageData | null;
};

type UsageLimit = {
  type?: string;
  percentage?: unknown;
};

type GlmTokenAccountRow = {
  tokenBalance?: unknown;
  totalAmount?: unknown;
  expirationTime?: unknown;
  validDate?: unknown;
  resourcePackageName?: unknown;
};

type FetchImpl = typeof fetch;

const CACHE_FILENAME = '.glm-usage-cache.json';
const SUCCESS_TTL_MS = 60_000;
const FAILURE_TTL_MS = 15_000;
const GLM_TOKEN_ACCOUNTS_URL = 'https://bigmodel.cn/api/biz/tokenAccounts/list/my';
const SEVEN_DAY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

let fetchImpl: FetchImpl = (...args) => fetch(...args);

export async function getGlmUsageData(): Promise<UsageData | null> {
  const baseUrl = process.env.ANTHROPIC_BASE_URL?.trim();
  if (!baseUrl?.includes('api.z.ai')) {
    return null;
  }

  const authToken = process.env.ANTHROPIC_AUTH_TOKEN?.trim() || process.env.ANTHROPIC_API_KEY?.trim();
  if (!authToken) {
    return null;
  }

  const homeDir = os.homedir();
  const now = Date.now();
  const cached = readCache(homeDir);
  if (cached && now - cached.fetchedAt <= getCacheTtlMs(cached.usageData)) {
    return cached.usageData;
  }

  const usageData = await fetchGlmUsageData(baseUrl, authToken);
  writeCache(homeDir, { fetchedAt: now, usageData });
  return usageData;
}

async function fetchGlmUsageData(baseUrl: string, authToken: string): Promise<UsageData | null> {
  const tokenAccountUsage = await fetchTokenAccountUsageData(authToken);
  if (tokenAccountUsage) {
    return tokenAccountUsage;
  }

  return fetchQuotaLimitUsageData(baseUrl, authToken);
}

async function fetchTokenAccountUsageData(authToken: string): Promise<UsageData | null> {
  try {
    const response = await fetchImpl(GLM_TOKEN_ACCOUNTS_URL, {
      headers: {
        Authorization: toBearerToken(authToken),
      },
    });

    if (!response.ok) {
      return null;
    }

    const payload = await response.json() as Record<string, unknown>;
    const rows = extractTokenAccountRows(payload);
    if (!rows || rows.length === 0) {
      return null;
    }

    const now = Date.now();
    let totalGranted = 0;
    let remainingBalance = 0;
    let earliestExpiry: Date | null = null;
    let weeklyTotalGranted = 0;
    let weeklyRemainingBalance = 0;
    let earliestWeeklyExpiry: Date | null = null;

    for (const row of rows) {
      const totalAmount = readTotalAmount(row);
      const tokenBalance = readTokenBalance(row.tokenBalance);
      const expiry = readExpiry(row);

      if (totalAmount === null || tokenBalance === null) {
        continue;
      }

      totalGranted += totalAmount;
      remainingBalance += tokenBalance;
      earliestExpiry = pickEarlierDate(earliestExpiry, expiry);

      if (expiry && isWithinSevenDays(expiry, now)) {
        weeklyTotalGranted += totalAmount;
        weeklyRemainingBalance += tokenBalance;
        earliestWeeklyExpiry = pickEarlierDate(earliestWeeklyExpiry, expiry);
      }
    }

    const overallUsage = computeUsagePercentage(totalGranted, remainingBalance);
    if (overallUsage === null) {
      return null;
    }

    return {
      source: 'glm',
      label: 'GLM',
      fiveHour: overallUsage,
      sevenDay: computeUsagePercentage(weeklyTotalGranted, weeklyRemainingBalance),
      fiveHourResetAt: earliestExpiry,
      sevenDayResetAt: earliestWeeklyExpiry,
    };
  } catch {
    return null;
  }
}

async function fetchQuotaLimitUsageData(baseUrl: string, authToken: string): Promise<UsageData | null> {
  try {
    const quotaUrl = new URL('/api/monitor/usage/quota/limit', baseUrl);
    const response = await fetchImpl(quotaUrl, {
      headers: {
        Authorization: authToken,
      },
    });

    if (!response.ok) {
      return null;
    }

    const payload = await response.json() as Record<string, unknown>;
    const limits = extractLimits(payload);
    if (!limits) {
      return null;
    }

    const tokenPercent = readLimitPercentage(limits, 'TOKENS_LIMIT');
    const fallbackPercent = readFirstPercentage(limits);
    const usagePercent = tokenPercent ?? fallbackPercent;
    if (usagePercent === null) {
      return null;
    }

    return {
      source: 'glm',
      label: 'GLM',
      fiveHour: usagePercent,
      sevenDay: null,
      fiveHourResetAt: null,
      sevenDayResetAt: null,
    };
  } catch {
    return null;
  }
}

function extractTokenAccountRows(payload: Record<string, unknown>): GlmTokenAccountRow[] | null {
  const directRows = payload.rows;
  if (Array.isArray(directRows)) {
    return directRows as GlmTokenAccountRow[];
  }

  const data = payload.data;
  if (!data || typeof data !== 'object') {
    return null;
  }

  const nestedRows = (data as Record<string, unknown>).rows;
  return Array.isArray(nestedRows) ? nestedRows as GlmTokenAccountRow[] : null;
}

function extractLimits(payload: Record<string, unknown>): UsageLimit[] | null {
  const directLimits = payload.limits;
  if (Array.isArray(directLimits)) {
    return directLimits as UsageLimit[];
  }

  const data = payload.data;
  if (!data || typeof data !== 'object') {
    return null;
  }

  const nestedLimits = (data as Record<string, unknown>).limits;
  return Array.isArray(nestedLimits) ? nestedLimits as UsageLimit[] : null;
}

function readLimitPercentage(limits: UsageLimit[], type: string): number | null {
  const target = limits.find((limit) => limit.type === type);
  return parsePercent(target?.percentage);
}

function readFirstPercentage(limits: UsageLimit[]): number | null {
  for (const limit of limits) {
    const percent = parsePercent(limit.percentage);
    if (percent !== null) {
      return percent;
    }
  }

  return null;
}

function parsePercent(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  return Math.round(Math.min(100, Math.max(0, value)));
}

function computeUsagePercentage(totalGranted: number, remainingBalance: number): number | null {
  if (!Number.isFinite(totalGranted) || totalGranted <= 0) {
    return null;
  }

  const usedBalance = totalGranted - remainingBalance;
  return parsePercent((usedBalance / totalGranted) * 100);
}

function readTokenBalance(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function readTotalAmount(row: GlmTokenAccountRow): number | null {
  if (typeof row.totalAmount === 'number' && Number.isFinite(row.totalAmount) && row.totalAmount > 0) {
    return row.totalAmount;
  }

  if (typeof row.resourcePackageName !== 'string') {
    return null;
  }

  return inferTotalAmountFromPackageName(row.resourcePackageName);
}

function inferTotalAmountFromPackageName(packageName: string): number | null {
  const normalized = packageName.replace(/,/g, '').trim();
  const match = normalized.match(/(\d+(?:\.\d+)?)\s*(万|亿|k|m|b)?\s*tokens?/i)
    ?? normalized.match(/(\d+(?:\.\d+)?)\s*(万|亿)/);

  if (!match) {
    return null;
  }

  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }

  const unit = match[2]?.toLowerCase();
  if (unit === '万') {
    return Math.round(value * 10_000);
  }
  if (unit === '亿') {
    return Math.round(value * 100_000_000);
  }
  if (unit === 'k') {
    return Math.round(value * 1_000);
  }
  if (unit === 'm') {
    return Math.round(value * 1_000_000);
  }
  if (unit === 'b') {
    return Math.round(value * 1_000_000_000);
  }

  return Math.round(value);
}

function readExpiry(row: GlmTokenAccountRow): Date | null {
  const rawExpiry = typeof row.expirationTime === 'string'
    ? row.expirationTime
    : typeof row.validDate === 'string'
      ? row.validDate
      : null;

  if (!rawExpiry) {
    return null;
  }

  const expiry = new Date(rawExpiry);
  return Number.isNaN(expiry.getTime()) ? null : expiry;
}

function pickEarlierDate(current: Date | null, candidate: Date | null): Date | null {
  if (!candidate) {
    return current;
  }

  if (!current || candidate.getTime() < current.getTime()) {
    return candidate;
  }

  return current;
}

function isWithinSevenDays(expiry: Date, now: number): boolean {
  const diffMs = expiry.getTime() - now;
  return diffMs > 0 && diffMs <= SEVEN_DAY_WINDOW_MS;
}

function toBearerToken(authToken: string): string {
  return authToken.startsWith('Bearer ') ? authToken : `Bearer ${authToken}`;
}

function getCachePath(homeDir: string): string {
  return path.join(getHudPluginDir(homeDir), CACHE_FILENAME);
}

function getCacheTtlMs(usageData: UsageData | null): number {
  return usageData ? SUCCESS_TTL_MS : FAILURE_TTL_MS;
}

function readCache(homeDir: string): CachedGlmUsage | null {
  try {
    const cachePath = getCachePath(homeDir);
    if (!fs.existsSync(cachePath)) {
      return null;
    }

    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as CachedGlmUsage;
    if (typeof parsed.fetchedAt !== 'number') {
      return null;
    }

    if (parsed.usageData === null) {
      return parsed;
    }

    if (typeof parsed.usageData !== 'object') {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function writeCache(homeDir: string, cache: CachedGlmUsage): void {
  try {
    const cachePath = getCachePath(homeDir);
    const cacheDir = path.dirname(cachePath);
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }

    fs.writeFileSync(cachePath, JSON.stringify(cache), 'utf8');
  } catch {
    return;
  }
}

export function _setFetchImplForTests(impl: FetchImpl | null): void {
  fetchImpl = impl ?? ((...args) => fetch(...args));
}
