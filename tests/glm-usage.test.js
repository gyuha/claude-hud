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

test('getGlmUsageData derives overall and weekly usage from token bundles', async () => {
  const savedBaseUrl = process.env.ANTHROPIC_BASE_URL;
  const savedAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const configDir = await mkdtemp(path.join(tmpdir(), 'claude-hud-glm-'));
  const weeklyExpiry = new Date(Date.now() + (2 * 24 * 60 * 60 * 1000));
  const laterExpiry = new Date(Date.now() + (10 * 24 * 60 * 60 * 1000));

  try {
    process.env.ANTHROPIC_BASE_URL = 'https://api.z.ai/api/anthropic';
    process.env.ANTHROPIC_AUTH_TOKEN = 'test-token';
    process.env.CLAUDE_CONFIG_DIR = configDir;

    _setFetchImplForTests(async (input) => {
      const url = String(input);
      assert.ok(url.includes('bigmodel.cn/api/biz/tokenAccounts/list/my'), `unexpected URL: ${url}`);

      return new Response(JSON.stringify({
        success: true,
        rows: [
          {
            tokenBalance: 200,
            totalAmount: 1000,
            expirationTime: weeklyExpiry.toISOString(),
          },
          {
            tokenBalance: 500,
            totalAmount: 2000,
            expirationTime: laterExpiry.toISOString(),
          },
        ],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const usage = await getGlmUsageData();

    assert.deepEqual(usage, {
      source: 'glm',
      label: 'GLM',
      fiveHour: 77,
      sevenDay: 80,
      fiveHourResetAt: weeklyExpiry,
      sevenDayResetAt: weeklyExpiry,
    });
  } finally {
    _setFetchImplForTests(null);
    restoreEnvVar('ANTHROPIC_BASE_URL', savedBaseUrl);
    restoreEnvVar('ANTHROPIC_AUTH_TOKEN', savedAuthToken);
    restoreEnvVar('CLAUDE_CONFIG_DIR', savedConfigDir);
    await rm(configDir, { recursive: true, force: true });
  }
});
