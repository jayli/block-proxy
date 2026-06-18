#!/usr/bin/env node

const assert = require('assert');
const mitmRegistry = require('../proxy/mitm/registry');
const LocalProxy = require('../proxy/proxy');

function makeRule(host = 'example.com', regexp = '^https://example.com/path', type = 'beforeSendRequest') {
  return {
    type,
    host,
    regexp,
    callback: async function() {
      return {
        response: {
          statusCode: 204,
          header: { 'X-Rule-Regexp': this.regexp },
          body: Buffer.alloc(0)
        }
      };
    }
  };
}

function setRegistry(config) {
  const registry = mitmRegistry.createRegistry({
    builtinRules: {
      Youtube: [makeRule('youtubei.googleapis.com', '^https://youtubei.googleapis.com/path')],
      Custom: [
        makeRule('example.com'),
        makeRule('response.example.com', '^https://response.example.com/path', 'beforeSendResponse')
      ]
    },
    config
  });
  LocalProxy._test.setRuleRegistryForTest(registry);
}

async function testDisabledRulesDoNotMitmOrBufferOrRewrite() {
  setRegistry({ rule_modules: { 'builtin:Custom': false } });

  assert.strictEqual(LocalProxy._test.shouldMitm('example.com'), false);
  assert.strictEqual(LocalProxy._test.shouldMitm('response.example.com'), false);
  assert.deepStrictEqual(LocalProxy._test.getResponseRules(), []);

  const result = await LocalProxy._test.runMITMHandler(
    'beforeSendRequest',
    'https://example.com/path',
    {},
    {}
  );
  assert.strictEqual(result, null);
}

async function testEnabledRulesRewriteAndPreserveThis() {
  setRegistry({});

  assert.strictEqual(LocalProxy._test.shouldMitm('example.com'), true);
  assert.strictEqual(LocalProxy._test.shouldMitm('response.example.com'), true);
  assert.deepStrictEqual(LocalProxy._test.getResponseRules(), [{
    type: 'beforeSendResponse',
    host: 'response.example.com',
    regexp: '^https://response.example.com/path'
  }]);

  const result = await LocalProxy._test.runMITMHandler(
    'beforeSendRequest',
    'https://example.com/path',
    {},
    {}
  );
  assert.strictEqual(result.response.statusCode, 204);
  assert.strictEqual(result.response.header['X-Rule-Regexp'], '^https://example.com/path');
}

function testYoutubeUaFilterRequiresEffectiveBuiltinYoutube() {
  LocalProxy._test.setEnableMitmForTest("1");
  setRegistry({ rule_modules: { 'builtin:Youtube': false } });
  assert.strictEqual(LocalProxy._test.shouldBypassByUa({ 'user-agent': 'Mozilla/5.0' }, 'youtube.com'), false);

  const shadowRegistry = mitmRegistry.createRegistry({
    builtinRules: { Youtube: [makeRule('youtubei.googleapis.com')] },
    cliRules: { Youtube: [makeRule('youtubei.googleapis.com')] },
    config: {}
  });
  LocalProxy._test.setRuleRegistryForTest(shadowRegistry);
  assert.strictEqual(LocalProxy._test.shouldBypassByUa({ 'user-agent': 'Mozilla/5.0' }, 'youtube.com'), false);

  setRegistry({});
  assert.strictEqual(LocalProxy._test.shouldBypassByUa({ 'user-agent': 'Mozilla/5.0' }, 'youtube.com'), true);

  LocalProxy._test.setEnableMitmForTest("0");
  assert.strictEqual(LocalProxy._test.shouldBypassByUa({ 'user-agent': 'Mozilla/5.0' }, 'youtube.com'), false);
  LocalProxy._test.setEnableMitmForTest("1");
}

(async () => {
  await testDisabledRulesDoNotMitmOrBufferOrRewrite();
  console.log('PASS testDisabledRulesDoNotMitmOrBufferOrRewrite');
  await testEnabledRulesRewriteAndPreserveThis();
  console.log('PASS testEnabledRulesRewriteAndPreserveThis');
  testYoutubeUaFilterRequiresEffectiveBuiltinYoutube();
  console.log('PASS testYoutubeUaFilterRequiresEffectiveBuiltinYoutube');
})();
