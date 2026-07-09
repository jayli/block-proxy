'use strict';

/**
 * Lightweight log utility for proxy-core.
 * Replaces the AnyProxy `colorful`-based log module.
 */

let ifPrint = true;
let logLevel = 0;
const LogLevelMap = {
  tip: 0,
  system_error: 1,
  rule_error: 2,
  warn: 3,
  debug: 4,
};

function formatTimestamp() {
  const d = new Date();
  const pad = (v) => v < 10 ? '0' + v : v;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function setPrintStatus(status) {
  ifPrint = !!status;
}

function setLogLevel(level) {
  logLevel = parseInt(level, 10);
}

function printLog(content, type) {
  if (!ifPrint) {
    return;
  }

  const timeString = formatTimestamp();
  switch (type) {
    case LogLevelMap.tip: {
      if (logLevel > 0) return;
      console.log(`[ProxyCore][${timeString}]: ${content}`);
      break;
    }
    case LogLevelMap.system_error: {
      if (logLevel > 1) return;
      console.error(`[ProxyCore ERROR][${timeString}]: ${content}`);
      break;
    }
    case LogLevelMap.rule_error: {
      if (logLevel > 2) return;
      console.error(`[ProxyCore RULE_ERROR][${timeString}]: ${content}`);
      break;
    }
    case LogLevelMap.warn: {
      if (logLevel > 3) return;
      console.error(`[ProxyCore WARN][${timeString}]: ${content}`);
      break;
    }
    case LogLevelMap.debug: {
      console.log(`[ProxyCore][${timeString}]: ${content}`);
      return;
    }
    default: {
      console.log(`[ProxyCore][${timeString}]: ${content}`);
      break;
    }
  }
}

module.exports.printLog = printLog;
module.exports.debug = (content) => printLog(content, LogLevelMap.debug);
module.exports.info = (content) => printLog(content, LogLevelMap.tip);
module.exports.warn = (content) => printLog(content, LogLevelMap.warn);
module.exports.error = (content) => printLog(content, LogLevelMap.system_error);
module.exports.ruleError = (content) => printLog(content, LogLevelMap.rule_error);
module.exports.setPrintStatus = setPrintStatus;
module.exports.setLogLevel = setLogLevel;
module.exports.T_TIP = LogLevelMap.tip;
module.exports.T_ERR = LogLevelMap.system_error;
module.exports.T_RULE_ERROR = LogLevelMap.rule_error;
module.exports.T_WARN = LogLevelMap.warn;
module.exports.T_DEBUG = LogLevelMap.debug;
