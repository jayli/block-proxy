'use strict';

const TIMESTAMP_PREFIX_RE = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/;

function pad2(value) {
  return value < 10 ? `0${value}` : `${value}`;
}

function formatTimestamp(date = new Date()) {
  return [
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`,
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`,
  ].join(' ');
}

function timestampLine(line, now = new Date()) {
  if (line === '' || TIMESTAMP_PREFIX_RE.test(line)) return line;
  return `[${formatTimestamp(now)}] ${line}`;
}

function installConsoleTimestamp() {
  if (console.__blockProxyTimestampInstalled) return;
  console.__blockProxyTimestampInstalled = true;

  for (const method of ['log', 'warn', 'error']) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      if (typeof args[0] === 'string') {
        args[0] = timestampLine(args[0]);
      } else {
        args.unshift(`[${formatTimestamp()}]`);
      }
      original(...args);
    };
  }
}

function createTimestampingWriter(write) {
  let pending = '';
  return (chunk) => {
    pending += chunk.toString();
    const lines = pending.split(/\n/);
    pending = lines.pop() || '';
    for (const line of lines) {
      write(`${timestampLine(line)}\n`);
    }
  };
}

module.exports = {
  formatTimestamp,
  timestampLine,
  installConsoleTimestamp,
  createTimestampingWriter,
};
