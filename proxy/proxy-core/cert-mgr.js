'use strict';

/**
 * Certificate manager extracted from @bachi/anyproxy/lib/certMgr.js.
 *
 * Kept:
 *  - node-easy-cert integration
 *  - ifRootCAFileExists, generateRootCA, getCertificate, getRootCAFilePath
 *  - existing ~/.anyproxy/certificates location
 *
 * Removed:
 *  - trustRootCA, getCAStatus, inquirer, trust-store shell commands
 */

const EasyCert = require('node-easy-cert');
const util = require('./util');

const options = {
  rootDirPath: util.getAnyProxyPath('certificates'),
  inMemory: false,
  defaultCertAttrs: [
    { name: 'countryName', value: 'CN' },
    { name: 'organizationName', value: 'AnyProxy' },
    { shortName: 'ST', value: 'SH' },
    { shortName: 'OU', value: 'AnyProxy SSL Proxy' }
  ]
};

const easyCert = new EasyCert(options);
const crtMgr = util.merge({}, easyCert);

// Rename to match AnyProxy API
crtMgr.ifRootCAFileExists = easyCert.isRootCAFileExists;

crtMgr.generateRootCA = function (cb) {
  doGenerate(false);

  function doGenerate(overwrite) {
    const rootOptions = {
      commonName: 'AnyProxy',
      overwrite: !!overwrite
    };

    easyCert.generateRootCA(rootOptions, (error, keyPath, crtPath) => {
      cb(error, keyPath, crtPath);
    });
  }
};

module.exports = crtMgr;
