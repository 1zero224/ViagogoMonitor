function isListingAvailabilityChange(change) {
  return change?.entityType === 'listing'
    && (change.type === 'new_listing_available' || change.type === 'listing_removed');
}

function getComparableListings(snapshot) {
  const stableListings = snapshot?.stableListings || {};
  if (Object.keys(stableListings).length > 0) {
    return stableListings;
  }

  return snapshot?.listings || {};
}

function getListingRecord(snapshot, listingKey) {
  if (!snapshot || !listingKey) {
    return null;
  }

  return getComparableListings(snapshot)?.[listingKey] || null;
}

function hasListingStock(snapshot, listingKey) {
  return (getListingRecord(snapshot, listingKey)?.availableTickets || 0) > 0;
}

function createListingAvailabilityChange(type, listingKey, previousListing, currentListing) {
  const source = currentListing || previousListing || {};
  return {
    type,
    entityType: 'listing',
    listingKey,
    listingId: source.listingId || listingKey,
    sourceListingIds: source.sourceListingIds || [],
    sectionName: source.sectionName || 'Unknown Section',
    rowId: source.rowId || null,
    seat: source.seat || null,
    oldTicketCount: previousListing?.availableTickets ?? null,
    newTicketCount: currentListing?.availableTickets ?? null,
    oldPrice: previousListing?.rawPrice ?? null,
    newPrice: currentListing?.rawPrice ?? null,
  };
}

function buildDebouncedListingAvailabilityChanges({ currentSnapshot, previousSnapshots = [], confirmRuns = 2 }) {
  const normalizedConfirmRuns = Math.max(2, Number(confirmRuns) || 2);
  const history = [currentSnapshot, ...previousSnapshots.filter(Boolean)].slice(0, normalizedConfirmRuns + 1);
  if (history.length < normalizedConfirmRuns + 1) {
    return [];
  }

  const listingIds = new Set();
  for (const snapshot of history) {
    for (const listingId of Object.keys(getComparableListings(snapshot))) {
      listingIds.add(listingId);
    }
  }

  const changes = [];
  for (const listingId of [...listingIds].sort()) {
    const presenceWindow = history.map((snapshot) => hasListingStock(snapshot, listingId));
    const recentPresence = presenceWindow.slice(0, normalizedConfirmRuns);
    const anchorPresence = presenceWindow[normalizedConfirmRuns];

    if (recentPresence.every(Boolean) && !anchorPresence) {
      changes.push(
        createListingAvailabilityChange(
          'new_listing_available',
          listingId,
          null,
          getListingRecord(history[0], listingId) || getListingRecord(history[1], listingId),
        ),
      );
      continue;
    }

    if (recentPresence.every((value) => !value) && anchorPresence) {
      const lastPresentSnapshot = history.slice(normalizedConfirmRuns).find((snapshot) => hasListingStock(snapshot, listingId));
      changes.push(
        createListingAvailabilityChange(
          'listing_removed',
          listingId,
          getListingRecord(lastPresentSnapshot, listingId),
          null,
        ),
      );
    }
  }

  return changes;
}

function buildAlertDiff({ diff, currentSnapshot, previousSnapshots = [], config = {} }) {
  const confirmRuns = Math.max(2, Number(config.listingAvailabilityConfirmRuns) || 2);
  const previousSnapshotCount = previousSnapshots.filter(Boolean).length;
  const debounceEnabled = Boolean(config.debounceListingAvailabilityAlerts) && diff?.comparisonMode === 'listing';

  if (!debounceEnabled) {
    return {
      ...diff,
      debounce: {
        enabled: false,
        confirmRuns,
        previousSnapshotCount,
        insufficientHistory: false,
        suppressedRawAvailabilityChangeCount: 0,
        emittedDebouncedAvailabilityChangeCount: 0,
        suppressedListingIds: [],
        emittedListingIds: [],
      },
    };
  }

  const rawAvailabilityChanges = (diff.changes || []).filter(isListingAvailabilityChange);
  const immediateChanges = (diff.changes || []).filter((change) => !isListingAvailabilityChange(change));
  const debouncedAvailabilityChanges = buildDebouncedListingAvailabilityChanges({
    currentSnapshot,
    previousSnapshots,
    confirmRuns,
  });

  const combinedChanges = [...debouncedAvailabilityChanges, ...immediateChanges];
  return {
    ...diff,
    changes: combinedChanges,
    changeCount: combinedChanges.length,
    debounce: {
      enabled: true,
      confirmRuns,
      previousSnapshotCount,
      insufficientHistory: previousSnapshotCount < confirmRuns,
      suppressedRawAvailabilityChangeCount: rawAvailabilityChanges.length,
      emittedDebouncedAvailabilityChangeCount: debouncedAvailabilityChanges.length,
      suppressedListingIds: rawAvailabilityChanges
        .map((change) => `${change.type}:${change.listingKey || change.listingId}`)
        .slice(0, 20),
      emittedListingIds: debouncedAvailabilityChanges
        .map((change) => `${change.type}:${change.listingKey || change.listingId}`)
        .slice(0, 20),
    },
  };
}

module.exports = {
  buildAlertDiff,
  buildDebouncedListingAvailabilityChanges,
  isListingAvailabilityChange,
};
