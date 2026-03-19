function cloneSummaryChanges(previous, current) {
  const previousSummary = previous?.summary || {};
  const currentSummary = current?.summary || {};

  return {
    totalTicketCountDelta: (currentSummary.totalTicketCount || 0) - (previousSummary.totalTicketCount || 0),
    rowsWithStockDelta: (currentSummary.rowsWithStock || 0) - (previousSummary.rowsWithStock || 0),
    sectionsWithStockDelta: (currentSummary.sectionsWithStock || 0) - (previousSummary.sectionsWithStock || 0),
    minPriceDelta:
      typeof previousSummary.minPrice === 'number' && typeof currentSummary.minPrice === 'number'
        ? currentSummary.minPrice - previousSummary.minPrice
        : null,
  };
}

function createBaseChange(type, rowKey, previousRow, currentRow) {
  const source = currentRow || previousRow || {};
  return {
    type,
    rowKey,
    sectionName: source.sectionName || 'Unknown Section',
    rowId: source.rowId || null,
    oldTicketCount: previousRow?.ticketCount ?? null,
    newTicketCount: currentRow?.ticketCount ?? null,
    oldPrice: previousRow?.rawMinPrice ?? null,
    newPrice: currentRow?.rawMinPrice ?? null,
  };
}

function compareRows(previousRows, currentRows, minTicketDelta) {
  const changes = [];
  const keys = new Set([...Object.keys(previousRows || {}), ...Object.keys(currentRows || {})]);

  for (const rowKey of [...keys].sort()) {
    const previousRow = previousRows[rowKey];
    const currentRow = currentRows[rowKey];
    const previousStock = (previousRow?.ticketCount || 0) > 0;
    const currentStock = (currentRow?.ticketCount || 0) > 0;

    if (!previousRow && currentRow && currentStock) {
      changes.push(createBaseChange('new_row_available', rowKey, previousRow, currentRow));
    }

    if (previousRow && !currentRow && previousStock) {
      changes.push(createBaseChange('row_removed', rowKey, previousRow, currentRow));
      continue;
    }

    if (!previousRow || !currentRow) {
      continue;
    }

    if (!previousStock && currentStock) {
      changes.push(createBaseChange('stock_appeared', rowKey, previousRow, currentRow));
    } else if (previousStock && !currentStock) {
      changes.push(createBaseChange('stock_sold_out', rowKey, previousRow, currentRow));
    }

    const ticketDelta = (currentRow.ticketCount || 0) - (previousRow.ticketCount || 0);
    if (previousStock && currentStock && Math.abs(ticketDelta) >= minTicketDelta) {
      if (ticketDelta > 0) {
        changes.push(createBaseChange('ticket_count_increased', rowKey, previousRow, currentRow));
      } else if (ticketDelta < 0) {
        changes.push(createBaseChange('ticket_count_decreased', rowKey, previousRow, currentRow));
      }
    }

    const previousPrice = previousRow.rawMinPrice;
    const currentPrice = currentRow.rawMinPrice;
    if (typeof previousPrice === 'number' && typeof currentPrice === 'number' && previousPrice !== currentPrice) {
      if (currentPrice > previousPrice) {
        changes.push(createBaseChange('price_increased', rowKey, previousRow, currentRow));
      } else {
        changes.push(createBaseChange('price_decreased', rowKey, previousRow, currentRow));
      }
    }
  }

  return changes;
}

function diffSnapshots(previousSnapshot, currentSnapshot, options = {}) {
  const minTicketDelta = Math.max(1, Number(options.minTicketDelta) || 1);

  if (!previousSnapshot) {
    return {
      eventId: currentSnapshot.eventId,
      eventUrl: currentSnapshot.eventUrl,
      capturedAt: currentSnapshot.capturedAt,
      previousCapturedAt: null,
      summaryChanges: cloneSummaryChanges(null, currentSnapshot),
      changes: [],
      changeCount: 0,
    };
  }

  const changes = compareRows(previousSnapshot.rows || {}, currentSnapshot.rows || {}, minTicketDelta);

  return {
    eventId: currentSnapshot.eventId,
    eventUrl: currentSnapshot.eventUrl,
    capturedAt: currentSnapshot.capturedAt,
    previousCapturedAt: previousSnapshot.capturedAt || null,
    summaryChanges: cloneSummaryChanges(previousSnapshot, currentSnapshot),
    changes,
    changeCount: changes.length,
  };
}

function filterDiffForAlerts(diff, config) {
  const filteredChanges = (diff.changes || []).filter((change) => {
    switch (change.type) {
      case 'new_row_available':
      case 'stock_appeared':
      case 'ticket_count_increased':
        return config.alertOnStockAppear;
      case 'row_removed':
      case 'stock_sold_out':
      case 'ticket_count_decreased':
        return config.alertOnStockDrop;
      case 'price_decreased':
      case 'price_increased':
        return config.alertOnPriceChange;
      default:
        return true;
    }
  });

  return {
    ...diff,
    changes: filteredChanges,
    changeCount: filteredChanges.length,
  };
}

module.exports = {
  diffSnapshots,
  filterDiffForAlerts,
};
