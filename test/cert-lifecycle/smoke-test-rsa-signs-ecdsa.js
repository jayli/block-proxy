'use strict';

const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tls = require('tls');
const { test } = require('node:test');
const certLifecycle = require('../../proxy/proxy-core/cert-lifecycle');

test('node-easy-cert path creates RSA 2048 leaf signed by fixed rootCA', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cert-lifecycle-smoke-'));
  try {
    fs.copyFileSync(path.join(__dirname, '../../cert/rootCA.crt'), path.join(tmpDir, 'rootCA.crt'));
    fs.copyFileSync(path.join(__dirname, '../../cert/rootCA.key'), path.join(tmpDir, 'rootCA.key'));

    certLifecycle.init({ certDir: tmpDir });
    const { key, cert } = await certLifecycle.ensureCert('example.com');
    const leaf = new crypto.X509Certificate(cert);
    const root = new crypto.X509Certificate(fs.readFileSync(path.join(tmpDir, 'rootCA.crt')));

    assert.strictEqual(leaf.publicKey.asymmetricKeyType, 'rsa');
    assert.strictEqual(leaf.publicKey.asymmetricKeyDetails.modulusLength, 2048);
    assert.strictEqual(leaf.verify(root.publicKey), true);
    assert.match(leaf.subjectAltName, /DNS:example\.com/);
    assert.ok(tls.createSecureContext({ key, cert }));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
