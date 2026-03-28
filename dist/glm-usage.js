import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getHudPluginDir } from './claude-config-dir.js';
const CACHE_FILENAME = '.glm-usage-cache.json';
const SUCCESS_TTL_MS = 60_000;
const FAILURE_TTL_MS = 15_000;
const FIVE_HOUR_WINDOW_UNIT = 3;
const WEEKLY_WINDOW_UNIT = 6;
let fetchImpl = (...args) => fetch(...args);
export async function getGlmUsageData() {
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
async function fetchGlmUsageData(baseUrl, authToken) {
    return fetchQuotaLimitUsageData(baseUrl, authToken);
}
async function fetchQuotaLimitUsageData(baseUrl, authToken) {
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
        const payload = await response.json();
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
    }
    catch {
        return null;
    }
}
function extractLimits(payload) {
    const directLimits = payload.limits;
    if (Array.isArray(directLimits)) {
        return directLimits;
    }
    const data = payload.data;
    if (!data || typeof data !== 'object') {
        return null;
    }
    const nestedLimits = data.limits;
    return Array.isArray(nestedLimits) ? nestedLimits : null;
}
function readTokenLimitWindow(limits, unit) {
    const target = limits.find((limit) => limit.type === 'TOKENS_LIMIT' && limit.unit === unit);
    return target ?? null;
}
function readFirstTokenLimitWindow(limits) {
    for (const limit of limits) {
        if (limit.type === 'TOKENS_LIMIT' && parsePercent(limit.percentage) !== null) {
            return limit;
        }
    }
    return null;
}
function parsePercent(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return null;
    }
    return Math.round(Math.min(100, Math.max(0, value)));
}
function readResetTime(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return null;
    }
    const resetAt = new Date(value);
    return Number.isNaN(resetAt.getTime()) ? null : resetAt;
}
function getCachePath(homeDir) {
    return path.join(getHudPluginDir(homeDir), CACHE_FILENAME);
}
function getCacheTtlMs(usageData) {
    return usageData ? SUCCESS_TTL_MS : FAILURE_TTL_MS;
}
function readCache(homeDir) {
    try {
        const cachePath = getCachePath(homeDir);
        if (!fs.existsSync(cachePath)) {
            return null;
        }
        const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
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
    }
    catch {
        return null;
    }
}
function normalizeCachedUsageData(usageData) {
    if (!usageData || typeof usageData !== 'object') {
        return null;
    }
    const usageRecord = usageData;
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
function normalizeCachedPercent(value) {
    if (value === null) {
        return null;
    }
    return parsePercent(value) ?? undefined;
}
function normalizeCachedDate(value) {
    if (value === null) {
        return null;
    }
    if (typeof value !== 'string') {
        return undefined;
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
}
function writeCache(homeDir, cache) {
    try {
        const cachePath = getCachePath(homeDir);
        const cacheDir = path.dirname(cachePath);
        if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
        }
        fs.writeFileSync(cachePath, JSON.stringify(cache), 'utf8');
    }
    catch {
        return;
    }
}
export function _setFetchImplForTests(impl) {
    fetchImpl = impl ?? ((...args) => fetch(...args));
}
//# sourceMappingURL=glm-usage.js.map