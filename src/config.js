const {
  parseBoolean,
  parseNumber,
  splitList,
  stripWrappingQuotes,
} = require('./utils');

function parseCliArgs(argv = []) {
  const urls = [];
  let monitorMode = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--url' || arg === '-u') {
      const nextValue = argv[index + 1];
      if (nextValue) {
        urls.push(stripWrappingQuotes(nextValue));
        index += 1;
      }
      continue;
    }

    if (arg.startsWith('--url=')) {
      urls.push(...splitList(stripWrappingQuotes(arg.slice('--url='.length))));
      continue;
    }

    if (arg === '--mode') {
      const nextValue = argv[index + 1];
      if (nextValue) {
        monitorMode = stripWrappingQuotes(nextValue);
        index += 1;
      }
      continue;
    }

    if (arg.startsWith('--mode=')) {
      monitorMode = stripWrappingQuotes(arg.slice('--mode='.length));
    }
  }

  return {
    urls,
    monitorMode,
  };
}

function loadConfig(argv = []) {
  const cli = parseCliArgs(argv);
  const supabaseServiceRoleKey = stripWrappingQuotes(process.env.SUPABASE_SERVICE_ROLE_KEY) || null;
  const supabaseAnonKey = stripWrappingQuotes(process.env.SUPABASE_ANON_KEY) || null;

  return {
    supabaseUrl: stripWrappingQuotes(process.env.SUPABASE_URL) || null,
    supabaseAnonKey: supabaseServiceRoleKey || supabaseAnonKey,
    supabaseCredentialSource: supabaseServiceRoleKey ? 'service_role' : (supabaseAnonKey ? 'anon' : null),
    feishuBotWebhookUrl: stripWrappingQuotes(process.env.FEISHU_BOT_WEBHOOK_URL || process.env.FEISHU_WEBHOOK_URL) || null,
    artistFilter: stripWrappingQuotes(process.env.ARTIST_FILTER) || null,
    countryFilter: stripWrappingQuotes(process.env.COUNTRY_FILTER) || null,
    projectName: stripWrappingQuotes(process.env.PROJECT_NAME) || 'viagogo-monitor',
    monitorMode: stripWrappingQuotes(cli.monitorMode || process.env.MONITOR_MODE || 'inventory').trim().toLowerCase(),
    eventUrls: [...new Set([...splitList(process.env.EVENT_URLS), ...cli.urls])],
    alertOnStockAppear: parseBoolean(process.env.ALERT_ON_STOCK_APPEAR, true),
    alertOnStockDrop: parseBoolean(process.env.ALERT_ON_STOCK_DROP, true),
    alertOnPriceChange: parseBoolean(process.env.ALERT_ON_PRICE_CHANGE, false),
    minTicketDelta: Math.max(1, parseNumber(process.env.MIN_TICKET_DELTA, 1)),
    maxDiffItemsInAlert: Math.max(1, parseNumber(process.env.MAX_DIFF_ITEMS_IN_ALERT, 10)),
    navigationTimeoutMs: Math.max(1000, parseNumber(process.env.NAVIGATION_TIMEOUT_MS, 80000)),
    jsonInterceptTimeoutMs: Math.max(1000, parseNumber(process.env.JSON_INTERCEPT_TIMEOUT_MS, 15000)),
    pageSettleDelayMinMs: Math.max(0, parseNumber(process.env.PAGE_SETTLE_DELAY_MIN_MS, 10000)),
    pageSettleDelayMaxMs: Math.max(0, parseNumber(process.env.PAGE_SETTLE_DELAY_MAX_MS, 12000)),
    postInterceptDelayMinMs: Math.max(0, parseNumber(process.env.POST_INTERCEPT_DELAY_MIN_MS, 2000)),
    postInterceptDelayMaxMs: Math.max(0, parseNumber(process.env.POST_INTERCEPT_DELAY_MAX_MS, 4000)),
    sectionMapTimeoutMs: Math.max(1000, parseNumber(process.env.SECTION_MAP_TIMEOUT_MS, 15000)),
    betweenTargetDelayMinMs: Math.max(0, parseNumber(process.env.BETWEEN_TARGET_DELAY_MIN_MS, 10000)),
    betweenTargetDelayMaxMs: Math.max(0, parseNumber(process.env.BETWEEN_TARGET_DELAY_MAX_MS, 20000)),
    historyTable: stripWrappingQuotes(process.env.INVENTORY_SNAPSHOTS_TABLE) || 'vgg_inventory_snapshots',
    diffTable: stripWrappingQuotes(process.env.INVENTORY_DIFFS_TABLE) || 'vgg_inventory_diffs',
    writeCompatibilityCache: parseBoolean(process.env.WRITE_PREVIOUSPRICES_CACHE, true),
    persistDiffs: parseBoolean(process.env.PERSIST_DIFFS, false),
    dumpRawPayloadOnFailure: parseBoolean(process.env.DUMP_RAW_PAYLOAD_ON_FAILURE, false),
    rawPayloadDumpDir: stripWrappingQuotes(process.env.RAW_PAYLOAD_DUMP_DIR) || 'debug-payloads',
  };
}

function validateRuntimeConfig(config) {
  const missing = [];
  if (!config.supabaseUrl) {
    missing.push('SUPABASE_URL');
  }
  if (!config.supabaseAnonKey) {
    missing.push('SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY');
  }

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  if (config.monitorMode !== 'inventory') {
    console.warn(`⚠️ Unsupported MONITOR_MODE="${config.monitorMode}", falling back to "inventory".`);
    config.monitorMode = 'inventory';
  }

  return config;
}

module.exports = {
  loadConfig,
  validateRuntimeConfig,
};
