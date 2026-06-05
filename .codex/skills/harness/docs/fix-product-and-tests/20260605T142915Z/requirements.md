# Requirements

User requested:
- Fix issue 1 (mount console websocket timeout / exec input race) from product code level.
- For remaining failures, adjust tests to match existing product code.
- Verify and report.

Constraints:
- Do not leave compiled artifacts under packages/common/src.
- Do not broaden product changes beyond issue 1 unless needed for tests.
