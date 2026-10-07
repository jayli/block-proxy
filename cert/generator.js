const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const selfsigned = require('selfsigned');

// MITM 根证书在服务器本地生成与保存，不随代码提交（见 .gitignore / .npmignore）。
// 与 ensureTempCert 的区别：这是签发域名证书的 CA，一旦泄露可被用来伪造任意站点，
// 因此私钥落盘权限收为 0600，并且绝不能被提交或打进发布包。
const ROOT_CA_KEY_PATH = path.join(__dirname, 'rootCA.key');
const ROOT_CA_CRT_PATH = path.join(__dirname, 'rootCA.crt');
const ROOT_CA_VALID_YEARS = 30;

function buildRootCaAttrs() {
  return [
    { name: 'commonName', value: 'BlockProxy' },
    { name: 'organizationName', value: 'BlockProxy' },
    { shortName: 'ST', value: 'SH' },
    { shortName: 'OU', value: 'BlockProxy SSL Proxy' }
  ];
}

// 先写临时文件再 rename，避免半写状态留下不可用的证书；
// 私钥用 0600，仅在创建时生效（已存在的文件不会被改权限）。
function writeFileAtomic(targetPath, content, mode) {
  const tmpPath = `${targetPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, content, { mode });
  fs.renameSync(tmpPath, targetPath);
}

async function generateRootCA() {
  const notAfterDate = new Date();
  notAfterDate.setFullYear(notAfterDate.getFullYear() + ROOT_CA_VALID_YEARS);

  const pems = await selfsigned.generate(buildRootCaAttrs(), {
    keyType: 'rsa',
    keySize: 2048,
    algorithm: 'sha256',
    notAfterDate,
    extensions: [
      { name: 'basicConstraints', cA: true, critical: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true }
    ]
  });

  // 只存在其中一个文件时视为残缺：两个一起重写，保证私钥与证书配对
  writeFileAtomic(ROOT_CA_KEY_PATH, pems.private, 0o600);
  writeFileAtomic(ROOT_CA_CRT_PATH, pems.cert, 0o644);

  const fingerprint = new crypto.X509Certificate(pems.cert).fingerprint256;
  console.log(`[Cert] 已生成本地 MITM 根证书（${ROOT_CA_VALID_YEARS} 年有效）`);
  console.log(`[Cert]   ${ROOT_CA_CRT_PATH}`);
  console.log(`[Cert]   ${ROOT_CA_KEY_PATH}`);
  console.log(`[Cert]   SHA-256: ${fingerprint}`);
  console.log('[Cert] 请在客户端设备上安装并信任该证书：http://<节点IP>:8004/fetchCrtFile');

  return { keyPath: ROOT_CA_KEY_PATH, certPath: ROOT_CA_CRT_PATH, fingerprint };
}

// 确保本地根证书存在，缺失（或残缺）时自动生成一对新的。
// 两个文件都在则什么都不做，可反复调用。
async function ensureRootCA() {
  const hasKey = fs.existsSync(ROOT_CA_KEY_PATH);
  const hasCrt = fs.existsSync(ROOT_CA_CRT_PATH);

  if (hasKey && hasCrt) {
    return { generated: false, keyPath: ROOT_CA_KEY_PATH, certPath: ROOT_CA_CRT_PATH };
  }

  if (hasKey || hasCrt) {
    console.warn('[Cert] 本地根证书不完整（缺少其中一个文件），将重新生成一对新的');
  }

  return { generated: true, ...(await generateRootCA()) };
}

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

module.exports = {
  ensureTempCert,
  ensureRootCA,
  ROOT_CA_KEY_PATH,
  ROOT_CA_CRT_PATH
};

// 支持直接执行：node cert/generator.js
// 供测试等需要同步等待生成的场景（execFileSync）复用同一份生成逻辑，
// 避免测试里再写一份 CA 参数。
if (require.main === module) {
  ensureRootCA()
    .then((result) => {
      if (!result.generated) {
        console.log('[Cert] 本地根证书已存在，未做任何修改');
      }
    })
    .catch((err) => {
      console.error('[Cert] 生成根证书失败:', err.message);
      process.exit(1);
    });
}
