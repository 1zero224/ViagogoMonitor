const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { extractAllSectionsFromJSON } = require('../src/scraper');

function loadFixture(fileName) {
  const filePath = path.join(__dirname, '..', 'fixtures', fileName);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('extractAllSectionsFromJSON supports the grid.venueMapData branch and emits zero-stock rows', async () => {
  const fixture = loadFixture('index-data.grid-venueMapData.json');
  const sections = await extractAllSectionsFromJSON(fixture, {
    56342: 'M15',
    56343: 'M16',
  });

  assert.equal(sections.length, 3);

  const zeroStockRow = sections.find((section) => section.rowId === 'B');
  assert.ok(zeroStockRow);
  assert.equal(zeroStockRow.ticketCount, 0);
  assert.equal(zeroStockRow.dataNotFound, true);
});

test('extractAllSectionsFromJSON falls back to sectionPopupData and grid items when rowPopupData is empty', async () => {
  const fixture = loadFixture('index-data.sectionPopupData-fallback.json');
  const sections = await extractAllSectionsFromJSON(fixture);

  assert.equal(sections.length, 4);

  const sectionPopupRow = sections.find((section) => section.rowKey === '2116_528504_25912');
  assert.ok(sectionPopupRow);
  assert.equal(sectionPopupRow.ticketCount, 17);
  assert.equal(sectionPopupRow.listingCount, 5);
  assert.equal(sectionPopupRow.price, 128.77);
  assert.equal(sectionPopupRow.priceFormatted, 'S$129');
  assert.equal(sectionPopupRow.rowPopupEntry.currencyCode, 'SGD');
  assert.equal(sectionPopupRow.dataNotFound, false);

  const gridFallbackRow = sections.find((section) => section.rowKey === '303_724530_25796');
  assert.ok(gridFallbackRow);
  assert.equal(gridFallbackRow.ticketCount, 1);
  assert.equal(gridFallbackRow.listingCount, 1);
  assert.equal(gridFallbackRow.price, 120.5);
  assert.equal(gridFallbackRow.priceFormatted, 'S$121');
  assert.equal(gridFallbackRow.rowPopupEntry.currencyCode, 'SGD');
  assert.equal(gridFallbackRow.dataNotFound, false);

  const stillMissingRow = sections.find((section) => section.rowKey === '303_724529_25769');
  assert.ok(stillMissingRow);
  assert.equal(stillMissingRow.ticketCount, 0);
  assert.equal(stillMissingRow.dataNotFound, true);
});

test('extractAllSectionsFromJSON supports the venueMapData branch', async () => {
  const fixture = loadFixture('index-data.venueMapData.json');
  const sections = await extractAllSectionsFromJSON(fixture);

  assert.equal(sections.length, 3);
  assert.equal(sections.find((section) => section.rowId === 'AA').ticketCount, 1);
});

test('extractAllSectionsFromJSON supports the root-level venueConfiguration branch', async () => {
  const fixture = loadFixture('index-data.root-venueConfiguration.json');
  const sections = await extractAllSectionsFromJSON(fixture);

  assert.equal(sections.length, 3);

  const missingNorthStandRow = sections.find((section) => section.sectionId === 72002);
  assert.ok(missingNorthStandRow);
  assert.equal(missingNorthStandRow.dataNotFound, true);
});
