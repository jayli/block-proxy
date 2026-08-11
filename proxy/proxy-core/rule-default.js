'use strict';

/**
 * Default rule callbacks, extracted from @bachi/anyproxy/lib/rule_default.js.
 *
 * These are generator functions that AnyProxy's rule system invokes via `co`.
 * User rules override these defaults through `util.merge(default_rule, userRule)`.
 */

module.exports = {

  summary: 'the default rule for AnyProxy',

  *beforeSendRequest(requestDetail) {
    return null;
  },

  *beforeSendResponse(requestDetail, responseDetail) {
    return null;
  },

  *beforeDealHttpsRequest(requestDetail) {
    return null;
  },

  *onError(requestDetail, error) {
    return null;
  },

  *onConnectError(requestDetail, error) {
    return null;
  },

  *onClientSocketError(requestDetail, error) {
    return null;
  },
};
