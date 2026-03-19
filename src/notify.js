const { formatMoney, formatSignedNumber, truncate } = require('./utils');

function initializeFeishuNotifier(config) {
  if (!config.feishuBotWebhookUrl) {
    console.warn('⚠️ Feishu webhook not configured, inventory alerts disabled.');
    return { webhookUrl: null };
  }

  try {
    // Validate early so startup fails fast on malformed webhook configuration.
    new URL(config.feishuBotWebhookUrl);
  } catch (error) {
    throw new Error(`Invalid FEISHU_BOT_WEBHOOK_URL: ${error.message}`);
  }

  console.log('✅ Feishu webhook configured');
  return {
    webhookUrl: config.feishuBotWebhookUrl,
  };
}

function buildSummaryField(snapshot, diff) {
  const currency = snapshot.summary.currency;
  const minPriceDelta = diff.summaryChanges.minPriceDelta;
  const minPriceLine =
    snapshot.summary.minPrice == null
      ? '最低价: 暂无'
      : `最低价: ${formatMoney(snapshot.summary.minPrice, currency)}${
          typeof minPriceDelta === 'number' ? ` (${formatSignedNumber(minPriceDelta, 2)})` : ''
        }`;

  return [
    `有票行数: ${snapshot.summary.rowsWithStock} (${formatSignedNumber(diff.summaryChanges.rowsWithStockDelta)})`,
    `有票分区数: ${snapshot.summary.sectionsWithStock} (${formatSignedNumber(diff.summaryChanges.sectionsWithStockDelta)})`,
    `挂单总数: ${snapshot.summary.totalListingCount} (${formatSignedNumber(diff.summaryChanges.totalListingCountDelta)})`,
    `票数总计: ${snapshot.summary.totalTicketCount} (${formatSignedNumber(diff.summaryChanges.totalTicketCountDelta)})`,
    minPriceLine,
  ];
}

function formatLocation(change) {
  const locationParts = [change.sectionName];
  if (change.rowId) {
    locationParts.push(`行 ${change.rowId}`);
  }
  if (change.seat) {
    locationParts.push(`座位 ${change.seat}`);
  }
  if (change.listingId) {
    locationParts.push(`挂单 ${change.listingId}`);
  }

  return locationParts.filter(Boolean).join(' / ');
}

function describeComparisonMode(mode) {
  if (mode === 'listing') {
    return '挂单级';
  }
  if (mode === 'row') {
    return '行级';
  }
  return mode || '未知';
}

function describeChange(change, currency) {
  const location = formatLocation(change);

  switch (change.type) {
    case 'new_row_available':
      return `新增行库存: ${location} | 票数 ${change.newTicketCount} | 价格 ${formatMoney(change.newPrice, currency)}`;
    case 'stock_appeared':
      return `行库存出现: ${location} | 0 -> ${change.newTicketCount} | 价格 ${formatMoney(change.newPrice, currency)}`;
    case 'stock_sold_out':
      return `行库存售罄: ${location} | ${change.oldTicketCount} -> 0`;
    case 'row_removed':
      return `行已移除: ${location} | 原票数 ${change.oldTicketCount}`;
    case 'ticket_count_increased':
      return `行票数增加: ${location} | ${change.oldTicketCount} -> ${change.newTicketCount}`;
    case 'ticket_count_decreased':
      return `行票数减少: ${location} | ${change.oldTicketCount} -> ${change.newTicketCount}`;
    case 'price_decreased':
      return `行价格下降: ${location} | ${formatMoney(change.oldPrice, currency)} -> ${formatMoney(change.newPrice, currency)}`;
    case 'price_increased':
      return `行价格上涨: ${location} | ${formatMoney(change.oldPrice, currency)} -> ${formatMoney(change.newPrice, currency)}`;
    case 'new_listing_available':
      return `新增挂单: ${location} | 票数 ${change.newTicketCount} | 价格 ${formatMoney(change.newPrice, currency)}`;
    case 'listing_removed':
      return `挂单移除: ${location} | 原票数 ${change.oldTicketCount}`;
    case 'listing_stock_appeared':
      return `挂单库存出现: ${location} | 0 -> ${change.newTicketCount} | 价格 ${formatMoney(change.newPrice, currency)}`;
    case 'listing_sold_out':
      return `挂单售罄: ${location} | ${change.oldTicketCount} -> 0`;
    case 'listing_ticket_count_increased':
      return `挂单票数增加: ${location} | ${change.oldTicketCount} -> ${change.newTicketCount}`;
    case 'listing_ticket_count_decreased':
      return `挂单票数减少: ${location} | ${change.oldTicketCount} -> ${change.newTicketCount}`;
    case 'listing_price_decreased':
      return `挂单价格下降: ${location} | ${formatMoney(change.oldPrice, currency)} -> ${formatMoney(change.newPrice, currency)}`;
    case 'listing_price_increased':
      return `挂单价格上涨: ${location} | ${formatMoney(change.oldPrice, currency)} -> ${formatMoney(change.newPrice, currency)}`;
    default:
      return `变更(${change.type}): ${location}`;
  }
}

function buildInventoryMessageText({ snapshot, diff, config }) {
  const visibleChanges = (diff.changes || []).slice(0, config.maxDiffItemsInAlert);
  const overflowCount = Math.max(0, (diff.changes || []).length - visibleChanges.length);
  const currency = snapshot.summary.currency;
  const lines = [
    'Viagogo 库存告警',
    `事件: ${snapshot.event.name || '未知活动'}`,
  ];

  if (snapshot.event.date) {
    lines.push(`日期: ${snapshot.event.date}`);
  }
  if (snapshot.event.location) {
    lines.push(`地点: ${snapshot.event.location}`);
  }

  lines.push(`告警变更数: ${diff.changeCount}`);
  lines.push(`对比模式: ${describeComparisonMode(diff.comparisonMode || 'row')}`);
  lines.push('快照摘要:');
  lines.push(...buildSummaryField(snapshot, diff));

  if (visibleChanges.length > 0) {
    lines.push('主要库存变更:');
    visibleChanges.forEach((change, index) => {
      lines.push(`${index + 1}. ${describeChange(change, currency)}`);
    });
  }

  if (overflowCount > 0) {
    lines.push(`...... 还有 ${overflowCount} 条变更`);
  }

  lines.push(`活动链接: ${snapshot.eventUrl}`);

  return truncate(lines.join('\n'), 3000);
}

function buildFeishuMessagePayload(payload) {
  return {
    msg_type: 'text',
    content: {
      text: buildInventoryMessageText(payload),
    },
  };
}

async function sendInventoryNotification(feishuWebhookUrl, payload) {
  if (!feishuWebhookUrl) {
    return false;
  }

  const messagePayload = buildFeishuMessagePayload(payload);
  const response = await fetch(feishuWebhookUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(messagePayload),
  });

  const rawResponseText = await response.text();
  let parsedBody = null;
  try {
    parsedBody = rawResponseText ? JSON.parse(rawResponseText) : null;
  } catch (error) {
    parsedBody = null;
  }

  if (!response.ok) {
    throw new Error(`Feishu webhook HTTP ${response.status}: ${rawResponseText}`);
  }

  const businessCode = parsedBody?.code ?? parsedBody?.StatusCode ?? 0;
  if (businessCode && businessCode !== 0) {
    throw new Error(`Feishu webhook rejected message: ${rawResponseText}`);
  }

  console.log(`   ✅ Feishu inventory notification sent (${payload.diff.changeCount} change(s))`);
  return true;
}

module.exports = {
  buildFeishuMessagePayload,
  buildInventoryMessageText,
  initializeFeishuNotifier,
  sendInventoryNotification,
};
