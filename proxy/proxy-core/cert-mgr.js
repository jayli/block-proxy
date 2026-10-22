'use strict';

/**
 * AnyProxy-compatible certificate manager facade.
 *
 * The lifecycle module owns certificate generation underneath; this facade keeps
 * the old callback API while allowing startup prewarming and SNI invalidation
 * to share the same certificate cache.
 */

const certLifecycle = require('./cert-lifecycle');

module.exports = {
  getCertificate: certLifecycle.getCertificate,
  ifRootCAFileExists: certLifecycle.ifRootCAFileExists,
  getRootCAFilePath: certLifecycle.getRootCAFilePath,
  generateRootCA: certLifecycle.generateRootCA,
  invalidateCert: certLifecycle.invalidateCert,
};
