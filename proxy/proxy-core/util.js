'use strict';

/**
 * Utility helpers extracted from @bachi/anyproxy/lib/util.js.
 * Only the functions needed by proxy-core are included.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const Buffer = require('buffer').Buffer;

module.exports.merge = function (baseObj, extendObj) {
  for (const key in extendObj) {
    baseObj[key] = extendObj[key];
  }
  return baseObj;
};

function getUserHome() {
  return process.env.HOME || process.env.USERPROFILE;
}
module.exports.getUserHome = getUserHome;

function getAnyProxyHome() {
  const home = path.join(__dirname, '../../certificates');
  if (!fs.existsSync(home)) {
    fs.mkdirSync(home, { recursive: true });
  }
  return home;
}
module.exports.getAnyProxyHome = getAnyProxyHome;

module.exports.getAnyProxyPath = function (pathName) {
  const home = getAnyProxyHome();
  const targetPath = path.join(home, pathName);
  if (!fs.existsSync(targetPath)) {
    fs.mkdirSync(targetPath);
  }
  return targetPath;
};

/**
 * Remove a module from require cache and re-require it.
 */
module.exports.freshRequire = function (modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
};

/**
 * Parse rawHeaders array into a header object.
 * Handles duplicate keys (except set-cookie which becomes an array).
 */
module.exports.getHeaderFromRawHeaders = function (rawHeaders) {
  const headerObj = {};
  const _handleSetCookieHeader = function (key, value) {
    if (headerObj[key].constructor === Array) {
      headerObj[key].push(value);
    } else {
      headerObj[key] = [headerObj[key], value];
    }
  };

  if (!!rawHeaders) {
    for (let i = 0; i < rawHeaders.length; i += 2) {
      const key = rawHeaders[i];
      let value = rawHeaders[i + 1];

      if (typeof value === 'string') {
        value = value.replace(/\0+$/g, '');
      }

      if (!headerObj[key]) {
        headerObj[key] = value;
      } else {
        if (key.toLowerCase() === 'set-cookie') {
          _handleSetCookieHeader(key, value);
        } else {
          headerObj[key] = headerObj[key] + ',' + value;
        }
      }
    }
  }
  return headerObj;
};

const networkInterfaces = os.networkInterfaces();

module.exports.getAllIpAddress = function getAllIpAddress() {
  const allIp = [];
  Object.keys(networkInterfaces).map((nic) => {
    networkInterfaces[nic].filter((detail) => {
      if (detail.family.toLowerCase() === 'ipv4') {
        allIp.push(detail.address);
      }
    });
  });
  return allIp.length ? allIp : ['127.0.0.1'];
};

module.exports.getFreePort = function () {
  return new Promise((resolve, reject) => {
    const server = require('net').createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, () => {
      const port = server.address().port;
      server.close(() => {
        resolve(port);
      });
    });
  });
};

module.exports.collectErrorLog = function (error) {
  if (error && error.code && error.toString()) {
    return error.toString();
  } else {
    let result = [error, error.stack].join('\n');
    try {
      const errorString = error.toString();
      if (errorString.indexOf('You may only yield a function') >= 0) {
        result = 'Function is not yieldable. Did you forget to provide a generator or promise in rule file ?';
      }
    } catch (e) {}
    return result;
  }
};

/**
 * @param {object} content
 * @returns the byte size of the content
 */
module.exports.getByteSize = function (content) {
  return Buffer.byteLength(content);
};

/**
 * Check whether a domain string is an IP address.
 */
module.exports.isIp = function (domain) {
  if (!domain) {
    return false;
  }
  const ipReg = /^\d+?\.\d+?\.\d+?\.\d+?$/;
  return ipReg.test(domain);
};
