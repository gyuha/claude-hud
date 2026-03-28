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
  unit?: unknown;
  number?: unknown;
  nextResetTime?: unknown;
};

type FetchImpl = typeof fetch;

const CACHE_FILENAME = '.glm-usage-cache.json';
const SUCCESS_TTL_MS = 60_000;
const FAILURE_TTL_MS = 15_000;
const FIVE_HOUR_WINDOW_UNIT = 3;
const WEEKLY_WINDOW_UNIT = 6;

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
  return fetchQuotaLimitUsageData(baseUrl, authToken);
}

async function fetchQuotaLimitUsageData(baseUrl: string, authToken: string): Promise<UsageData | null> {
  try {
    const quotaUrl = new URL('/api/monitor/usage/quota/limit', baseUrl);
    const response = await fetchImpl(quotaUrl, {
      headers: {
        Authorization: authToken,
        'Accept-Language': 'en-US,en',
        'Content-Type': 'application/json',
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

    const fiveHourLimit = readTokenLimitWindow(limits, FIVE_HOUR_WINDOW_UNIT) ?? readFirstTokenLimitWindow(limits);
    const weeklyLimit = readTokenLimitWindow(limits, WEEKLY_WINDOW_UNIT);
    const fiveHour = parsePercent(fiveHourLimit?.percentage);
    const sevenDay = parsePercent(weeklyLimit?.percentage);

    if (fiveHour === null && sevenDay === null) {
      return null;
    }

    return {
      source: 'glm',
      label: 'GLM',
      fiveHour,
      sevenDay,
      fiveHourResetAt: readResetTime(fiveHourLimit?.nextResetTime),
      sevenDayResetAt: readResetTime(weeklyLimit?.nextResetTime),
    };
  } catch {
    return null;
  }
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

function readTokenLimitWindow(limits: UsageLimit[], unit: number): UsageLimit | null {
  const target = limits.find((limit) => limit.type === 'TOKENS_LIMIT' && limit.unit === unit);
  return target ?? null;
}

function readFirstTokenLimitWindow(limits: UsageLimit[]): UsageLimit | null {
  for (const limit of limits) {
    if (limit.type === 'TOKENS_LIMIT' && parsePercent(limit.percentage) !== null) {
      return limit;
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

function readResetTime(value: unknown): Date | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  const resetAt = new Date(value);
  return Number.isNaN(resetAt.getTime()) ? null : resetAt;
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

    const usageData = normalizeCachedUsageData(parsed.usageData);
    if (!usageData) {
      return null;
    }

    return {
      fetchedAt: parsed.fetchedAt,
      usageData,
    };
  } catch {
    return null;
  }
}

function normalizeCachedUsageData(usageData: unknown): UsageData | null {
  if (!usageData || typeof usageData !== 'object') {
    return null;
  }

  const usageRecord = usageData as {
    fiveHour?: unknown;
    sevenDay?: unknown;
    fiveHourResetAt?: unknown;
    sevenDayResetAt?: unknown;
    source?: unknown;
    label?: unknown;
  };

  const fiveHour = normalizeCachedPercent(usageRecord.fiveHour);
  const sevenDay = normalizeCachedPercent(usageRecord.sevenDay);
  if (fiveHour === undefined || sevenDay === undefined) {
    return null;
  }

  const fiveHourResetAt = normalizeCachedDate(usageRecord.fiveHourResetAt);
  const sevenDayResetAt = normalizeCachedDate(usageRecord.sevenDayResetAt);
  if (fiveHourResetAt === undefined || sevenDayResetAt === undefined) {
    return null;
  }

  return {
    source: usageRecord.source === 'glm' ? 'glm' : undefined,
    label: typeof usageRecord.label === 'string' ? usageRecord.label : undefined,
    fiveHour,
    sevenDay,
    fiveHourResetAt,
    sevenDayResetAt,
  };
}

function normalizeCachedPercent(value: unknown): number | null | undefined {
  if (value === null) {
    return null;
  }

  return parsePercent(value) ?? undefined;
}

function normalizeCachedDate(value: unknown): Date | null | undefined {
  if (value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
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
