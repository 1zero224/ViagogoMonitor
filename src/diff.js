function cloneSummaryChanges(previous, current) {
  const previousSummary = previous?.summary || {};
  const currentSummary = current?.summary || {};

  return {
    totalListingCountDelta: (currentSummary.totalListingCount || 0) - (previousSummary.totalListingCount || 0),
    totalTicketCountDelta: (currentSummary.totalTicketCount || 0) - (previousSummary.totalTicketCount || 0),
    rowsWithStockDelta: (currentSummary.rowsWithStock || 0) - (previousSummary.rowsWithStock || 0),
    sectionsWithStockDelta: (currentSummary.sectionsWithStock || 0) - (previousSummary.sectionsWithStock || 0),
    minPriceDelta:
      typeof previousSummary.minPrice === 'number' && typeof currentSummary.minPrice === 'number'
        ? currentSummary.minPrice - previousSummary.minPrice
        : null,
  };
}

function hasListingSnapshot(snapshot) {
  return Object.keys(snapshot?.listings || {}).length > 0;
}

function createBaseChange(type, rowKey, previousRow, currentRow) {
  const source = currentRow || previousRow || {};
  return {
    type,
    entityType: 'row',
    rowKey,
    sectionName: source.sectionName || 'Unknown Section',
    rowId: source.rowId || null,
    oldTicketCount: previousRow?.ticketCount ?? null,
    newTicketCount: currentRow?.ticketCount ?? null,
    oldPrice: previousRow?.rawMinPrice ?? null,
    newPrice: currentRow?.rawMinPrice ?? null,
  };
}

function createListingChange(type, listingId, previousListing, currentListing) {
  const source = currentListing || previousListing || {};
  return {
    type,
    entityType: 'listing',
    listingId,
    sectionName: source.sectionName || 'Unknown Section',
    rowId: source.rowId || null,
    seat: source.seat || null,
    oldTicketCount: previousListing?.availableTickets ?? null,
    newTicketCount: currentListing?.availableTickets ?? null,
    oldPrice: previousListing?.rawPrice ?? null,
    newPrice: currentListing?.rawPrice ?? null,
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

function compareListings(previousListings, currentListings, minTicketDelta) {
  const changes = [];
  const keys = new Set([...Object.keys(previousListings || {}), ...Object.keys(currentListings || {})]);

  for (const listingId of [...keys].sort()) {
    const previousListing = previousListings[listingId];
    const currentListing = currentListings[listingId];
    const previousStock = (previousListing?.availableTickets || 0) > 0;
    const currentStock = (currentListing?.availableTickets || 0) > 0;

    if (!previousListing && currentListing && currentStock) {
      changes.push(createListingChange('new_listing_available', listingId, previousListing, currentListing));
      continue;
    }

    if (previousListing && !currentListing && previousStock) {
      changes.push(createListingChange('listing_removed', listingId, previousListing, currentListing));
      continue;
    }

    if (!previousListing || !currentListing) {
      continue;
    }

    if (!previousStock && currentStock) {
      changes.push(createListingChange('listing_stock_appeared', listingId, previousListing, currentListing));
    } else if (previousStock && !currentStock) {
      changes.push(createListingChange('listing_sold_out', listingId, previousListing, currentListing));
    }

    const ticketDelta = (currentListing.availableTickets || 0) - (previousListing.availableTickets || 0);
    if (previousStock && currentStock && Math.abs(ticketDelta) >= minTicketDelta) {
      if (ticketDelta > 0) {
        changes.push(createListingChange('listing_ticket_count_increased', listingId, previousListing, currentListing));
      } else if (ticketDelta < 0) {
        changes.push(createListingChange('listing_ticket_count_decreased', listingId, previousListing, currentListing));
      }
    }

    const previousPrice = previousListing.rawPrice;
    const currentPrice = currentListing.rawPrice;
    if (typeof previousPrice === 'number' && typeof currentPrice === 'number' && previousPrice !== currentPrice) {
      if (currentPrice > previousPrice) {
        changes.push(createListingChange('listing_price_increased', listingId, previousListing, currentListing));
      } else {
        changes.push(createListingChange('listing_price_decreased', listingId, previousListing, currentListing));
      }
    }
  }

  return changes;
}

function diffSnapshots(previousSnapshot, currentSnapshot, options = {}) {
  const minTicketDelta = Math.max(1, Number(options.minTicketDelta) || 1);
  const currentHasListings = hasListingSnapshot(currentSnapshot);
  const previousHasListings = hasListingSnapshot(previousSnapshot);

  if (!previousSnapshot) {
    return {
      eventId: currentSnapshot.eventId,
      eventUrl: currentSnapshot.eventUrl,
      capturedAt: currentSnapshot.capturedAt,
      previousCapturedAt: null,
      comparisonMode: currentHasListings ? 'listing' : 'row',
      summaryChanges: cloneSummaryChanges(null, currentSnapshot),
      changes: [],
      changeCount: 0,
    };
  }

  if (currentHasListings && !previousHasListings) {
    return {
      eventId: currentSnapshot.eventId,
      eventUrl: currentSnapshot.eventUrl,
      capturedAt: currentSnapshot.capturedAt,
      previousCapturedAt: previousSnapshot.capturedAt || null,
      comparisonMode: 'listing',
      baselineReset: true,
      summaryChanges: cloneSummaryChanges(previousSnapshot, currentSnapshot),
      changes: [],
      changeCount: 0,
    };
  }

  const comparisonMode = currentHasListings && previousHasListings ? 'listing' : 'row';
  const changes = comparisonMode === 'listing'
    ? compareListings(previousSnapshot.listings || {}, currentSnapshot.listings || {}, minTicketDelta)
    : compareRows(previousSnapshot.rows || {}, currentSnapshot.rows || {}, minTicketDelta);

  return {
    eventId: currentSnapshot.eventId,
    eventUrl: currentSnapshot.eventUrl,
    capturedAt: currentSnapshot.capturedAt,
    previousCapturedAt: previousSnapshot.capturedAt || null,
    comparisonMode,
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
      case 'new_listing_available':
      case 'listing_stock_appeared':
      case 'listing_ticket_count_increased':
        return config.alertOnStockAppear;
      case 'row_removed':
      case 'stock_sold_out':
      case 'ticket_count_decreased':
      case 'listing_removed':
      case 'listing_sold_out':
      case 'listing_ticket_count_decreased':
        return config.alertOnStockDrop;
      case 'price_decreased':
      case 'price_increased':
      case 'listing_price_decreased':
      case 'listing_price_increased':
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
