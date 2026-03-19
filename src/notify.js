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
      ? 'Min price: n/a'
      : `Min price: ${formatMoney(snapshot.summary.minPrice, currency)}${
          typeof minPriceDelta === 'number' ? ` (${formatSignedNumber(minPriceDelta, 2)})` : ''
        }`;

  return [
    `Rows with stock: ${snapshot.summary.rowsWithStock} (${formatSignedNumber(diff.summaryChanges.rowsWithStockDelta)})`,
    `Sections with stock: ${snapshot.summary.sectionsWithStock} (${formatSignedNumber(diff.summaryChanges.sectionsWithStockDelta)})`,
    `Total listings: ${snapshot.summary.totalListingCount} (${formatSignedNumber(diff.summaryChanges.totalListingCountDelta)})`,
    `Total tickets: ${snapshot.summary.totalTicketCount} (${formatSignedNumber(diff.summaryChanges.totalTicketCountDelta)})`,
    minPriceLine,
  ];
}

function describeChange(change, currency) {
  const locationParts = [change.sectionName];
  if (change.rowId) {
    locationParts.push(`Row ${change.rowId}`);
  }
  if (change.seat) {
    locationParts.push(`Seat ${change.seat}`);
  }
  if (change.listingId) {
    locationParts.push(`Listing ${change.listingId}`);
  }

  const location = locationParts.filter(Boolean).join(' / ');

  switch (change.type) {
    case 'new_row_available':
      return `New row available: ${location} | tickets ${change.newTicketCount} | price ${formatMoney(change.newPrice, currency)}`;
    case 'stock_appeared':
      return `Stock appeared: ${location} | 0 -> ${change.newTicketCount} | price ${formatMoney(change.newPrice, currency)}`;
    case 'stock_sold_out':
      return `Sold out: ${location} | ${change.oldTicketCount} -> 0`;
    case 'row_removed':
      return `Row removed: ${location} | previous tickets ${change.oldTicketCount}`;
    case 'ticket_count_increased':
      return `Ticket count increased: ${location} | ${change.oldTicketCount} -> ${change.newTicketCount}`;
    case 'ticket_count_decreased':
      return `Ticket count decreased: ${location} | ${change.oldTicketCount} -> ${change.newTicketCount}`;
    case 'price_decreased':
      return `Price decreased: ${location} | ${formatMoney(change.oldPrice, currency)} -> ${formatMoney(change.newPrice, currency)}`;
    case 'price_increased':
      return `Price increased: ${location} | ${formatMoney(change.oldPrice, currency)} -> ${formatMoney(change.newPrice, currency)}`;
    case 'new_listing_available':
      return `New listing available: ${location} | tickets ${change.newTicketCount} | price ${formatMoney(change.newPrice, currency)}`;
    case 'listing_removed':
      return `Listing removed: ${location} | previous tickets ${change.oldTicketCount}`;
    case 'listing_stock_appeared':
      return `Listing stock appeared: ${location} | 0 -> ${change.newTicketCount} | price ${formatMoney(change.newPrice, currency)}`;
    case 'listing_sold_out':
      return `Listing sold out: ${location} | ${change.oldTicketCount} -> 0`;
    case 'listing_ticket_count_increased':
      return `Listing ticket count increased: ${location} | ${change.oldTicketCount} -> ${change.newTicketCount}`;
    case 'listing_ticket_count_decreased':
      return `Listing ticket count decreased: ${location} | ${change.oldTicketCount} -> ${change.newTicketCount}`;
    case 'listing_price_decreased':
      return `Listing price decreased: ${location} | ${formatMoney(change.oldPrice, currency)} -> ${formatMoney(change.newPrice, currency)}`;
    case 'listing_price_increased':
      return `Listing price increased: ${location} | ${formatMoney(change.oldPrice, currency)} -> ${formatMoney(change.newPrice, currency)}`;
    default:
      return `${change.type}: ${location}`;
  }
}

function buildInventoryMessageText({ snapshot, diff, config }) {
  const visibleChanges = (diff.changes || []).slice(0, config.maxDiffItemsInAlert);
  const overflowCount = Math.max(0, (diff.changes || []).length - visibleChanges.length);
  const currency = snapshot.summary.currency;
  const lines = [
    `Viagogo Inventory Alert`,
    `Event: ${snapshot.event.name || 'Unknown Event'}`,
  ];

  if (snapshot.event.date) {
    lines.push(`Date: ${snapshot.event.date}`);
  }
  if (snapshot.event.location) {
    lines.push(`Location: ${snapshot.event.location}`);
  }

  lines.push(`Alertable changes: ${diff.changeCount}`);
  lines.push(`Comparison mode: ${diff.comparisonMode || 'row'}`);
  lines.push('Snapshot Summary:');
  lines.push(...buildSummaryField(snapshot, diff));

  if (visibleChanges.length > 0) {
    lines.push('Top Inventory Changes:');
    visibleChanges.forEach((change, index) => {
      lines.push(`${index + 1}. ${describeChange(change, currency)}`);
    });
  }

  if (overflowCount > 0) {
    lines.push(`...and ${overflowCount} more change(s).`);
  }

  lines.push(`Event URL: ${snapshot.eventUrl}`);

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
