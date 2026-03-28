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

type FetchImpl = typeof fetch;

const CACHE_FILENAME = '.glm-usage-cache.json';
const SUCCESS_TTL_MS = 60_000;
const FAILURE_TTL_MS = 15_000;

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
