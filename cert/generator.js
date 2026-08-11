const fs = require('fs');
const selfsigned = require('selfsigned');

function ensureTempCert(name, keyPath, certPath) {
  // 先检查文件是否已存在，存在则跳过（同步检查，无需 await）
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return;
  }

  console.log(`[Cert] Generating temporary ECC P-256 certificate for ${name}...`);

  // selfsigned v5 API: async, keyType: 'ec', curve: 'P-256'
  // 使用 notAfterDate 设置 30 年有效期（与 MITM rootCA 对齐，~2056 年）
  const notAfterDate = new Date();
  notAfterDate.setFullYear(notAfterDate.getFullYear() + 30);

  return selfsigned.generate(
    [{ name: 'commonName', value: `BlockProxy-${name}` }],
    {
      keyType: 'ec',
      curve: 'P-256',
      algorithm: 'sha256',
      notAfterDate: notAfterDate,
      extensions: [
        { name: 'basicConstraints', cA: false },
        { name: 'subjectAltName', altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' }
        ]}
      ]
    }
  ).then(pems => {
    fs.writeFileSync(keyPath, pems.private);
    fs.writeFileSync(certPath, pems.cert);
    console.log(`[Cert] Generated: ${keyPath}, ${certPath}`);
  });
}

module.exports = { ensureTempCert };
