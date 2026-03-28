import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _setFetchImplForTests, getGlmUsageData } from '../dist/glm-usage.js';

delete process.env.ANTHROPIC_BASE_URL;
delete process.env.ANTHROPIC_AUTH_TOKEN;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.CLAUDE_CONFIG_DIR;

function restoreEnvVar(name, value) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

test('getGlmUsageData derives five-hour and weekly usage from quota limit windows', async () => {
  const savedBaseUrl = process.env.ANTHROPIC_BASE_URL;
  const savedAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const configDir = await mkdtemp(path.join(tmpdir(), 'claude-hud-glm-'));
  const fiveHourResetAt = new Date(Date.now() + (2 * 60 * 60 * 1000));
  const sevenDayResetAt = new Date(Date.now() + (5 * 24 * 60 * 60 * 1000));

  try {
    process.env.ANTHROPIC_BASE_URL = 'https://api.z.ai/api/anthropic';
    process.env.ANTHROPIC_AUTH_TOKEN = 'test-token';
    process.env.CLAUDE_CONFIG_DIR = configDir;

    _setFetchImplForTests(async (input, init) => {
      const url = String(input);
      assert.ok(url.includes('/api/monitor/usage/quota/limit'), `unexpected URL: ${url}`);
      assert.equal(init?.headers?.Authorization, 'test-token');

      return new Response(JSON.stringify({
        data: {
          limits: [
            {
              type: 'TOKENS_LIMIT',
              unit: 3,
              percentage: 23,
              nextResetTime: fiveHourResetAt.getTime(),
            },
            {
              type: 'TOKENS_LIMIT',
              unit: 6,
              percentage: 61,
              nextResetTime: sevenDayResetAt.getTime(),
            },
          ],
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const usage = await getGlmUsageData();

    assert.deepEqual(usage, {
      source: 'glm',
      label: 'GLM',
      fiveHour: 23,
      sevenDay: 61,
      fiveHourResetAt,
      sevenDayResetAt,
    });
  } finally {
    _setFetchImplForTests(null);
    restoreEnvVar('ANTHROPIC_BASE_URL', savedBaseUrl);
    restoreEnvVar('ANTHROPIC_AUTH_TOKEN', savedAuthToken);
    restoreEnvVar('CLAUDE_CONFIG_DIR', savedConfigDir);
    await rm(configDir, { recursive: true, force: true });
  }
});

test('getGlmUsageData keeps five-hour usage when weekly quota window is missing', async () => {
  const savedBaseUrl = process.env.ANTHROPIC_BASE_URL;
  const savedAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const configDir = await mkdtemp(path.join(tmpdir(), 'claude-hud-glm-'));
  const fiveHourResetAt = new Date(Date.now() + (3 * 60 * 60 * 1000));

  try {
    process.env.ANTHROPIC_BASE_URL = 'https://api.z.ai/api/anthropic';
    process.env.ANTHROPIC_AUTH_TOKEN = 'test-token';
    process.env.CLAUDE_CONFIG_DIR = configDir;

    _setFetchImplForTests(async () => new Response(JSON.stringify({
      limits: [
        {
          type: 'TOKENS_LIMIT',
          unit: 3,
          percentage: 45,
          nextResetTime: fiveHourResetAt.getTime(),
        },
      ],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const usage = await getGlmUsageData();

    assert.deepEqual(usage, {
      source: 'glm',
      label: 'GLM',
      fiveHour: 45,
      sevenDay: null,
      fiveHourResetAt,
      sevenDayResetAt: null,
    });
  } finally {
    _setFetchImplForTests(null);
    restoreEnvVar('ANTHROPIC_BASE_URL', savedBaseUrl);
    restoreEnvVar('ANTHROPIC_AUTH_TOKEN', savedAuthToken);
    restoreEnvVar('CLAUDE_CONFIG_DIR', savedConfigDir);
    await rm(configDir, { recursive: true, force: true });
  }
});

test('getGlmUsageData restores Date values when reading cached quota windows', async () => {
  const savedBaseUrl = process.env.ANTHROPIC_BASE_URL;
  const savedAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const configDir = await mkdtemp(path.join(tmpdir(), 'claude-hud-glm-'));
  const fiveHourResetAt = new Date(Date.now() + (90 * 60 * 1000));
  const sevenDayResetAt = new Date(Date.now() + (4 * 24 * 60 * 60 * 1000));

  try {
    process.env.ANTHROPIC_BASE_URL = 'https://api.z.ai/api/anthropic';
    process.env.ANTHROPIC_AUTH_TOKEN = 'test-token';
    process.env.CLAUDE_CONFIG_DIR = configDir;

    _setFetchImplForTests(async () => new Response(JSON.stringify({
      data: {
        limits: [
          {
            type: 'TOKENS_LIMIT',
            unit: 3,
            percentage: 12,
            nextResetTime: fiveHourResetAt.getTime(),
          },
          {
            type: 'TOKENS_LIMIT',
            unit: 6,
            percentage: 34,
            nextResetTime: sevenDayResetAt.getTime(),
          },
        ],
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const firstUsage = await getGlmUsageData();

    _setFetchImplForTests(async () => {
      throw new Error('cache should have been used');
    });

    const cachedUsage = await getGlmUsageData();

    assert.deepEqual(firstUsage, {
      source: 'glm',
      label: 'GLM',
      fiveHour: 12,
      sevenDay: 34,
      fiveHourResetAt,
      sevenDayResetAt,
    });
    assert.deepEqual(cachedUsage, firstUsage);
    assert.ok(cachedUsage?.fiveHourResetAt instanceof Date);
    assert.ok(cachedUsage?.sevenDayResetAt instanceof Date);
  } finally {
    _setFetchImplForTests(null);
    restoreEnvVar('ANTHROPIC_BASE_URL', savedBaseUrl);
    restoreEnvVar('ANTHROPIC_AUTH_TOKEN', savedAuthToken);
    restoreEnvVar('CLAUDE_CONFIG_DIR', savedConfigDir);
    await rm(configDir, { recursive: true, force: true });
  }
});
