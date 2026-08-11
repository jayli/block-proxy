'use strict';

const assert = require('assert');
const Server = require('../server/express');

function minimalConfig(overrides = {}) {
  return {
    proxy_port: 8001,
    socks5_port: 8002,
    express_port: 8004,
    block_hosts: [],
    auth_username: '',
    auth_password: '',
    enable_mitm: '1',
    enable_socks5: '1',
    enable_express: '1',
    devices: [],
    rule_modules: {},
    enable_tunnel: '1',
    tunnel_port: 8003,
    tunnel_ws_path: '/websocket',
    tunnel_sse_path: '/api/v1/events',
    tunnel_sse_keepalive_min_ms: 20000,
    tunnel_sse_keepalive_max_ms: 25000,
    tunnel_silent_idle_timeout: 3000,
    tunnel_domains: [],
    chain_proxy_enabled: '0',
    chain_proxy_type: 'http',
    chain_proxy_address: '',
    ...overrides,
  };
}

function testImportValidationRejectsInvalidChainProxyType() {
  const result = Server._test.validateImportedConfig(minimalConfig({
    chain_proxy_enabled: '1',
    chain_proxy_type: 'ftp',
    chain_proxy_address: 'proxy.example.test:8080',
  }));

  assert.strictEqual(result.ok, false);
  assert(result.details.some((detail) => detail.includes('链式代理类型')));
}

function testImportValidationRejectsEnabledChainProxyWithoutAddress() {
  const result = Server._test.validateImportedConfig(minimalConfig({
    chain_proxy_enabled: '1',
    chain_proxy_type: 'http',
    chain_proxy_address: '',
  }));

  assert.strictEqual(result.ok, false);
  assert(result.details.some((detail) => detail.includes('链式代理地址')));
}

function testImportValidationAcceptsValidChainProxyConfig() {
  const result = Server._test.validateImportedConfig(minimalConfig({
    chain_proxy_enabled: '1',
    chain_proxy_type: 'socks5',
    chain_proxy_address: 'proxy.example.test:1080',
  }));

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.details, []);
}

function testImportValidationBackfillsTunnelXhttpBasePath() {
  const config = minimalConfig();
  delete config.tunnel_xhttp_base_path;

  const result = Server._test.validateImportedConfig(config);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.config.tunnel_xhttp_base_path, '/xhttp');
}

function testImportValidationBackfillsSseSilentDefaults() {
  const config = minimalConfig();
  delete config.tunnel_sse_path;
  delete config.tunnel_sse_keepalive_min_ms;
  delete config.tunnel_sse_keepalive_max_ms;
  delete config.tunnel_silent_idle_timeout;

  const result = Server._test.validateImportedConfig(config);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.config.tunnel_sse_path, '/api/v1/events');
  assert.strictEqual(result.config.tunnel_sse_keepalive_min_ms, 20000);
  assert.strictEqual(result.config.tunnel_sse_keepalive_max_ms, 25000);
  assert.strictEqual(result.config.tunnel_silent_idle_timeout, 3000);
}

function testImportValidationRejectsInvalidTunnelXhttpBasePath() {
  const result = Server._test.validateImportedConfig(minimalConfig({
    tunnel_xhttp_base_path: 123,
  }));

  assert.strictEqual(result.ok, false);
  assert(result.details.some((detail) => detail.includes('隧道 xhttp 路径')));
}

function run() {
  testImportValidationBackfillsTunnelXhttpBasePath();
  console.log('PASS testImportValidationBackfillsTunnelXhttpBasePath');
  testImportValidationRejectsInvalidTunnelXhttpBasePath();
  console.log('PASS testImportValidationRejectsInvalidTunnelXhttpBasePath');
  testImportValidationBackfillsSseSilentDefaults();
  console.log('PASS testImportValidationBackfillsSseSilentDefaults');
  testImportValidationRejectsInvalidChainProxyType();
  console.log('PASS testImportValidationRejectsInvalidChainProxyType');
  testImportValidationRejectsEnabledChainProxyWithoutAddress();
  console.log('PASS testImportValidationRejectsEnabledChainProxyWithoutAddress');
  testImportValidationAcceptsValidChainProxyConfig();
  console.log('PASS testImportValidationAcceptsValidChainProxyConfig');
}

run();
