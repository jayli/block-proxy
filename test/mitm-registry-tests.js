#!/usr/bin/env node

const assert = require('assert');
const {
  createRegistry,
  normalizeRuleExports
} = require('../proxy/mitm/registry');

function makeRule(host = 'example.com', regexp = '^https://example.com/') {
  return {
    type: 'beforeSendRequest',
    host,
    regexp,
    callback: async function() {
      return null;
    }
  };
}

function testOldFormatNormalizes() {
  const groups = normalizeRuleExports({
    MyRule: [makeRule()]
  }, { source: 'external:docker', defaultDescription: '外部自定义规则' });

  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].id, 'external:docker:MyRule');
  assert.strictEqual(groups[0].key, 'MyRule');
  assert.strictEqual(groups[0].name, 'MyRule');
  assert.strictEqual(groups[0].description, '外部自定义规则');
  assert.strictEqual(groups[0].rules.length, 1);
  assert.ok(groups[0].rules[0].compiledRegexp instanceof RegExp);
}

function testNewFormatNormalizes() {
  const groups = normalizeRuleExports({
    MyRule: {
      name: 'Custom Rule',
      description: 'Custom description',
      rules: [makeRule()]
    }
  }, { source: 'external:cli', defaultDescription: '外部自定义规则' });

  assert.strictEqual(groups[0].id, 'external:cli:MyRule');
  assert.strictEqual(groups[0].name, 'Custom Rule');
  assert.strictEqual(groups[0].description, 'Custom description');
}

function testInvalidItemsAreSkipped() {
  const groups = normalizeRuleExports({
    Broken: [
      makeRule('ok.example.com'),
      { type: 'beforeSendRequest', host: 'bad.example.com', regexp: '(', callback: async function() {} },
      { type: 'beforeSendRequest', host: 'bad.example.com', regexp: '^https://bad', callback: 'not-a-function' }
    ]
  }, { source: 'external:docker', defaultDescription: '外部自定义规则' });

  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].rules.length, 1);
  assert.strictEqual(groups[0].ruleCount, 1);
}

function testLegacyOverrideOrder() {
  const registry = createRegistry({
    builtinRules: { Same: [makeRule('builtin.example.com')] },
    cliRules: { Same: [makeRule('cli.example.com')] },
    dockerRules: { Same: [makeRule('docker.example.com')] },
    config: {}
  });

  const modules = registry.getRuleModules();
  assert.strictEqual(modules.length, 1);
  assert.strictEqual(modules[0].id, 'external:docker:Same');
  assert.strictEqual(registry.getEnabledRules()[0].host, 'docker.example.com');
}

function testExplicitFalseDisablesGroup() {
  const registry = createRegistry({
    builtinRules: { Youtube: [makeRule('youtubei.googleapis.com')] },
    config: { rule_modules: { 'builtin:Youtube': false } }
  });

  assert.deepStrictEqual(registry.getEnabledRules(), []);
  assert.strictEqual(registry.isBuiltinYoutubeEnabled(), false);
}

function testMissingConfigDefaultsEnabled() {
  const registry = createRegistry({
    builtinRules: { Youtube: [makeRule('youtubei.googleapis.com')] },
    config: {}
  });

  assert.strictEqual(registry.getEnabledRules().length, 1);
  assert.strictEqual(registry.isBuiltinYoutubeEnabled(), true);
}

[
  testOldFormatNormalizes,
  testNewFormatNormalizes,
  testInvalidItemsAreSkipped,
  testLegacyOverrideOrder,
  testExplicitFalseDisablesGroup,
  testMissingConfigDefaultsEnabled
].forEach((testFn) => {
  testFn();
  console.log(`PASS ${testFn.name}`);
});
