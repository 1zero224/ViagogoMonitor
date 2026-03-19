const test = require('node:test');
const assert = require('node:assert/strict');

const { loadConfig } = require('../src/config');

function withEnv(overrides, fn) {
  const keys = Object.keys(overrides);
  const previous = new Map(keys.map((key) => [key, process.env[key]]));

  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    return fn();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('loadConfig strips wrapping quotes from Railway-style env values', () => {
  withEnv(
    {
      SUPABASE_URL: '"https://example.supabase.co"',
      SUPABASE_ANON_KEY: '"quoted-anon-key"',
      FEISHU_BOT_WEBHOOK_URL: '"https://open.feishu.cn/open-apis/bot/v2/hook/token"',
      MONITOR_MODE: '"inventory"',
      EVENT_URLS: '"https://www.viagogo.com/Concert-Tickets/Other-Concerts/ZUTOMAYO-Tickets/E-159991465?backUrl=%2FConcert-Tickets%2FOther-Concerts%2FZUTOMAYO-Tickets&lt=40.7128&lg=-74.006"',
      ALERT_ON_STOCK_APPEAR: '"false"',
      DEBOUNCE_LISTING_AVAILABILITY_ALERTS: '"false"',
      LISTING_AVAILABILITY_CONFIRM_RUNS: '"3"',
      PERSIST_DIFFS: '"true"',
      NAVIGATION_TIMEOUT_MS: '"12345"',
    },
    () => {
      const config = loadConfig([]);

      assert.equal(config.supabaseUrl, 'https://example.supabase.co');
      assert.equal(config.supabaseAnonKey, 'quoted-anon-key');
      assert.equal(config.supabaseCredentialSource, 'anon');
      assert.equal(config.feishuBotWebhookUrl, 'https://open.feishu.cn/open-apis/bot/v2/hook/token');
      assert.equal(config.monitorMode, 'inventory');
      assert.deepEqual(config.eventUrls, [
        'https://www.viagogo.com/Concert-Tickets/Other-Concerts/ZUTOMAYO-Tickets/E-159991465?backUrl=%2FConcert-Tickets%2FOther-Concerts%2FZUTOMAYO-Tickets&lt=40.7128&lg=-74.006',
      ]);
      assert.equal(config.alertOnStockAppear, false);
      assert.equal(config.debounceListingAvailabilityAlerts, false);
      assert.equal(config.listingAvailabilityConfirmRuns, 3);
      assert.equal(config.persistDiffs, true);
      assert.equal(config.navigationTimeoutMs, 12345);
    },
  );
});

test('loadConfig prefers SUPABASE_SERVICE_ROLE_KEY over SUPABASE_ANON_KEY', () => {
  withEnv(
    {
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: '"service-role-key"',
      SUPABASE_ANON_KEY: '"anon-key"',
    },
    () => {
      const config = loadConfig([]);
      assert.equal(config.supabaseAnonKey, 'service-role-key');
      assert.equal(config.supabaseCredentialSource, 'service_role');
    },
  );
});
