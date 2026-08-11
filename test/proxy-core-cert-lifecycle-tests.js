'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const tls = require('tls');
const { X509Certificate } = require('crypto');

const certLifecycle = require('../proxy/proxy-core/cert-lifecycle');

async function run() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cert-lifecycle-'));
  try {
    const rootCACertPath = path.join(__dirname, '../cert/rootCA.crt');
    const rootCAKeyPath = path.join(__dirname, '../cert/rootCA.key');
    fs.copyFileSync(rootCACertPath, path.join(tmpDir, 'rootCA.crt'));
    fs.copyFileSync(rootCAKeyPath, path.join(tmpDir, 'rootCA.key'));

    certLifecycle.init({
      certDir: tmpDir,
      mitmRegistry: null,
    });

    // Test 1: hostname normalization
    assert.strictEqual(certLifecycle.normalizeHostname('Example.COM:443'), 'example.com');
    assert.strictEqual(certLifecycle.normalizeHostname('example.com.'), 'example.com');
    assert.strictEqual(certLifecycle.normalizeHostname('[::1]:443'), '::1');
    assert.strictEqual(certLifecycle.normalizeHostname('192.168.1.1:8080'), '192.168.1.1');
    assert.throws(() => certLifecycle.normalizeHostname('../evil.com'));
    assert.throws(() => certLifecycle.normalizeHostname(''));
    assert.throws(() => certLifecycle.normalizeHostname(null));
    console.log('PASS: hostname normalization');

    // Test 2: ensureCert uses the production node-easy-cert path
    const { key, cert } = await certLifecycle.ensureCert('Example.COM:443');
    const leaf = new X509Certificate(cert);
    const root = new X509Certificate(fs.readFileSync(rootCACertPath, 'utf8'));

    assert.strictEqual(leaf.publicKey.asymmetricKeyType, 'rsa');
    assert.strictEqual(leaf.publicKey.asymmetricKeyDetails.modulusLength, 2048);
    assert.strictEqual(leaf.verify(root.publicKey), true);
    assert.match(leaf.subjectAltName, /DNS:example\.com/);
    assert.doesNotThrow(() => tls.createSecureContext({ key, cert }));
    console.log('PASS: ensureCert creates RSA 2048 leaf signed by RSA rootCA');

    // Test 3: ensureCert with caching
    const result1 = await certLifecycle.ensureCert('cache-test.com');
    assert.strictEqual(result1.source, 'generated');
    const result2 = await certLifecycle.ensureCert('cache-test.com');
    assert.strictEqual(result2.source, 'cache');
    assert.strictEqual(String(result1.key), String(result2.key));
    assert.strictEqual(String(result1.cert), String(result2.cert));
    console.log('PASS: ensureCert caches and returns from cache');

    // Test 4: concurrent dedup
    const [r1, r2, r3] = await Promise.all([
      certLifecycle.ensureCert('concurrent.com'),
      certLifecycle.ensureCert('concurrent.com'),
      certLifecycle.ensureCert('concurrent.com'),
    ]);
    assert.strictEqual(String(r1.key), String(r2.key));
    assert.strictEqual(String(r2.key), String(r3.key));
    console.log('PASS: ensureCert deduplicates concurrent calls');

    // Test 5: cache validation and regeneration
    const paths = certLifecycle.getCachePaths('invalidate-test.com');
    await certLifecycle.ensureCert('invalidate-test.com');
    // Corrupt the cert
    fs.writeFileSync(paths.crtPath, 'corrupted');
    const result3 = await certLifecycle.ensureCert('invalidate-test.com');
    assert.strictEqual(result3.source, 'generated');
    const leaf2 = new X509Certificate(result3.cert);
    assert.strictEqual(leaf2.verify(root.publicKey), true);
    console.log('PASS: ensureCert regenerates invalid cache');

    // Test 6: rootCAExists
    assert.strictEqual(certLifecycle.rootCAExists(), true);
    console.log('PASS: rootCAExists returns true');

    // Test 7: getRootCAPath
    assert.match(certLifecycle.getRootCAPath(), /rootCA\.crt$/);
    console.log('PASS: getRootCAPath');

    // Test 8: getCertDir
    assert.strictEqual(certLifecycle.getCertDir(), tmpDir);
    console.log('PASS: getCertDir');

    // Test 9: IP address SAN
    const ipResult = await certLifecycle.ensureCert('192.168.1.1');
    const ipLeaf = new X509Certificate(ipResult.cert);
    assert.match(ipLeaf.subjectAltName, /IP Address:192\.168\.1\.1/);
    console.log('PASS: IP address SAN');

    // Test 10: invalidateCert
    await certLifecycle.ensureCert('to-invalidate.com');
    const invPaths = certLifecycle.getCachePaths('to-invalidate.com');
    assert.ok(fs.existsSync(invPaths.keyPath));
    certLifecycle.invalidateCert('to-invalidate.com');
    assert.ok(!fs.existsSync(invPaths.keyPath));
    assert.ok(!fs.existsSync(invPaths.crtPath));
    console.log('PASS: invalidateCert deletes cache files');

    // Test 11: getDomainsToPrewarm
    const mockRegistry = {
      getEnabledRules: () => [
        { host: 'youtube.com' },
        { host: 'googlevideo.com' },
      ]
    };
    certLifecycle.init({
      certDir: tmpDir,
      mitmRegistry: mockRegistry,
    });
    const domains = certLifecycle.getDomainsToPrewarm({ block_hosts: ['blocked.com', { filter_host: 'blocked2.com' }] });
    assert.ok(domains.includes('youtube.com'));
    assert.ok(domains.includes('googlevideo.com'));
    assert.ok(domains.includes('blocked.com'));
    assert.ok(domains.includes('blocked2.com'));
    console.log('PASS: getDomainsToPrewarm collects from rules and block_hosts');

    // Test 12: prewarmCerts
    const prewarmResult = await certLifecycle.prewarmCerts(['prewarm1.com', 'prewarm2.com']);
    assert.strictEqual(prewarmResult.success, 2);
    assert.strictEqual(prewarmResult.fail, 0);
    console.log('PASS: prewarmCerts');

    // Test 13: healthCheck
    // Create some valid certs
    await certLifecycle.ensureCert('health-ok.com');
    // Create a corrupted cert
    const badPaths = certLifecycle.getCachePaths('health-bad.com');
    await certLifecycle.ensureCert('health-bad.com');
    fs.writeFileSync(badPaths.crtPath, 'corrupted');
    // Create orphan files
    fs.writeFileSync(path.join(tmpDir, 'orphan.json'), '{}');

    const hcResult = await certLifecycle.healthCheck();
    assert.ok(hcResult.kept >= 1); // health-ok.com
    assert.ok(hcResult.removed >= 1); // health-bad.com or orphan
    assert.ok(!fs.existsSync(badPaths.keyPath)); // corrupted was removed
    console.log('PASS: healthCheck removes invalid caches');

    // Test 14: cert-mgr compatibility (getCertificate callback API)
    // Re-init with a mock registry for cert-mgr test
    certLifecycle.init({
      certDir: tmpDir,
      mitmRegistry: null,
    });

    const certMgr = require('../proxy/proxy-core/cert-mgr');
    await new Promise((resolve, reject) => {
      certMgr.getCertificate('compat.example.com', (err, keyContent, crtContent) => {
        if (err) return reject(err);
        assert.match(String(keyContent), /BEGIN RSA PRIVATE KEY/);
        assert.match(String(crtContent), /BEGIN CERTIFICATE/);
        resolve();
      });
    });
    assert.strictEqual(certMgr.ifRootCAFileExists(), true);
    assert.match(certMgr.getRootCAFilePath(), /rootCA\.crt$/);
    console.log('PASS: cert-mgr compatibility layer');

    console.log('\nAll proxy-core cert lifecycle tests passed!');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
