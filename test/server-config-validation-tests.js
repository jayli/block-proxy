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
    tunnel_h2_path: '/h2-tunnel',
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

function testImportValidationBackfillsTunnelH2Path() {
  const config = minimalConfig();
  delete config.tunnel_h2_path;

  const result = Server._test.validateImportedConfig(config);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.config.tunnel_h2_path, '/h2-tunnel');
}

function testImportValidationRejectsInvalidTunnelH2Path() {
  const result = Server._test.validateImportedConfig(minimalConfig({
    tunnel_h2_path: 123,
  }));

  assert.strictEqual(result.ok, false);
  assert(result.details.some((detail) => detail.includes('隧道 HTTP/2 路径')));
}

function run() {
  testImportValidationBackfillsTunnelH2Path();
  console.log('PASS testImportValidationBackfillsTunnelH2Path');
  testImportValidationRejectsInvalidTunnelH2Path();
  console.log('PASS testImportValidationRejectsInvalidTunnelH2Path');
  testImportValidationRejectsInvalidChainProxyType();
  console.log('PASS testImportValidationRejectsInvalidChainProxyType');
  testImportValidationRejectsEnabledChainProxyWithoutAddress();
  console.log('PASS testImportValidationRejectsEnabledChainProxyWithoutAddress');
  testImportValidationAcceptsValidChainProxyConfig();
  console.log('PASS testImportValidationAcceptsValidChainProxyConfig');
}

run();
