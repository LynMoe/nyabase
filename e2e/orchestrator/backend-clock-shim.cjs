'use strict';

// Recovery-only process clock. The Compose topology always preloads this file,
// but ordinary runs leave Date untouched. The provider can select exactly one
// fixed +8 day offset so the production seven-day retention worker is tested
// without changing the host clock or mutating SQLite directly.
const raw = process.env.NYABASE_E2E_CLOCK_OFFSET_MS ?? '0';
if (!/^(?:0|691200000)$/.test(raw)) {
  throw new Error('NYABASE_E2E_CLOCK_OFFSET_MS is outside the closed E2E clock vocabulary');
}
const offsetMs = Number(raw);
if (offsetMs !== 0) {
  const RealDate = Date;
  class OffsetDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(RealDate.now() + offsetMs);
      else super(...args);
    }

    static now() {
      return RealDate.now() + offsetMs;
    }
  }
  globalThis.Date = OffsetDate;
}
