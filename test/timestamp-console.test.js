const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { formatTimestamp, timestampLine } = require('../server/timestampConsole');

describe('timestampConsole', () => {
  it('formats timestamps as YYYY-MM-DD hh:mm:ss', () => {
    const date = new Date(2026, 6, 26, 21, 7, 5);

    assert.equal(formatTimestamp(date), '2026-07-26 21:07:05');
  });

  it('prefixes lines once', () => {
    const date = new Date(2026, 6, 26, 21, 7, 5);

    assert.equal(timestampLine('[2026-07-26 21:07:05] already', date), '[2026-07-26 21:07:05] already');
    assert.equal(timestampLine('hello', date), '[2026-07-26 21:07:05] hello');
  });
});
