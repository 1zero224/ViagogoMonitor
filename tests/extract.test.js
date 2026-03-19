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
