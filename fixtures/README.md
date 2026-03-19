# Fixture Runbook

The JSON payloads in this directory are synthetic and anonymized contract fixtures.

They are intentionally small. Their job is to pin the parser branches and the normalized snapshot contract without depending on live scraping during tests.

Covered branches:

- `grid.venueMapData`
- `venueMapData`
- root-level `venueConfiguration` + `rowPopupData`

How to regenerate from a live run:

1. Set `DUMP_RAW_PAYLOAD_ON_FAILURE=true` and `RAW_PAYLOAD_DUMP_DIR=./debug-payloads`.
2. Run `node index.js --url "https://www.viagogo.com/.../E-123456789?quantity=2"`.
3. Copy the relevant `index-data` JSON into `fixtures/`.
4. Remove event-specific personal data that is not required for parser coverage.
5. Keep only the smallest branch subset needed for regression tests.

Why synthetic fixtures are checked in:

- the repository should have deterministic parser tests even without valid live credentials
- live `index-data` payloads can drift or contain marketplace-specific data that should not be committed verbatim
