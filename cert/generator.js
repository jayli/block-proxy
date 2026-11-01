const fs = require('fs');
const os = require('os');
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
  console.log('[Cert] 请在客户端设备上安装并信任该证书：https://<节点IP>:8004/fetchCrtFile');

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

// 枚举本机当前的全部非内部 IPv4，用于 8004 面板证书的 SAN。
// 面板是按 IP 访问的（https://<节点IP>:8004 那套习惯），主机名只会是 IP，
// 所以 SAN 里必须带 IP，否则浏览器除了「不受信任的颁发者」还会多报一条主机名不匹配。
function collectLocalIpv4() {
  const ips = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

// 现有面板证书是否可直接复用。返回 { usable, reason }：
// 任一检查不通过就把 reason 带出去，由调用方重新签发。
//   1. 证书能解析、私钥能读
//   2. 公钥与私钥配对（避免手写/粘贴造成的错配）
//   3. 未过期
//   4. SAN 覆盖 localhost、127.0.0.1 与当前本机全部内网 IPv4
//      （换了网段导致新 IP 不在 SAN 里时，这里会判定为不可用）
function inspectPanelCert(keyPath, certPath) {
  let keyPem;
  let certPem;
  try {
    keyPem = fs.readFileSync(keyPath);
    certPem = fs.readFileSync(certPath);
  } catch (err) {
    return { usable: false, reason: `读取失败: ${err.message}` };
  }

  let cert;
  try {
    cert = new crypto.X509Certificate(certPem);
  } catch (err) {
    return { usable: false, reason: `证书无法解析: ${err.message}` };
  }

  let keyObject;
  try {
    keyObject = crypto.createPrivateKey(keyPem);
  } catch (err) {
    return { usable: false, reason: `私钥无法解析: ${err.message}` };
  }

  // 公钥指纹比对：私钥对应的公钥必须与证书里的公钥一致
  try {
    const fromKey = crypto.createPublicKey(keyObject).export({ type: 'spki', format: 'der' });
    const fromCert = cert.publicKey.export({ type: 'spki', format: 'der' });
    if (!fromKey.equals(fromCert)) {
      return { usable: false, reason: '私钥与证书不配对' };
    }
  } catch (err) {
    return { usable: false, reason: `公钥比对失败: ${err.message}` };
  }

  if (Date.parse(cert.validTo) <= Date.now()) {
    return { usable: false, reason: `证书已过期（${cert.validTo}）` };
  }
  if (Date.parse(cert.validFrom) > Date.now()) {
    return { usable: false, reason: `证书尚未生效（${cert.validFrom}）` };
  }

  if (!cert.checkHost('localhost')) {
    return { usable: false, reason: 'SAN 未覆盖 localhost' };
  }
  if (!cert.checkIP('127.0.0.1')) {
    return { usable: false, reason: 'SAN 未覆盖 127.0.0.1' };
  }

  const missingIps = collectLocalIpv4().filter(ip => !cert.checkIP(ip));
  if (missingIps.length > 0) {
    return { usable: false, reason: `SAN 未覆盖本机内网 IP: ${missingIps.join(', ')}` };
  }

  return { usable: true, reason: null };
}

// 8004 管理面板的 TLS 证书：ECC P-256 自签，30 年有效，SAN 覆盖 localhost、
// 127.0.0.1 与生成时本机的全部内网 IPv4。
// 与 ensureTempCert 的区别：后者只签 localhost + 127.0.0.1，且只检查文件是否存在；
// 这里先校验现有证书是否真的可用（能解析、公私钥配对、未过期、覆盖当前内网 IP），
// 不可用就静默重签，用户不需要手动删文件。
async function ensurePanelCert(keyPath, certPath) {
  const hasKey = fs.existsSync(keyPath);
  const hasCert = fs.existsSync(certPath);

  if (hasKey && hasCert) {
    const { usable, reason } = inspectPanelCert(keyPath, certPath);
    if (usable) {
      return { generated: false, keyPath, certPath };
    }
    console.warn(`[Cert] 已有管理面板证书不可用（${reason}），将重新生成一对新的`);
  } else if (hasKey || hasCert) {
    console.warn('[Cert] 管理面板证书不完整（缺少其中一个文件），将重新生成一对新的');
  }

  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' }
  ];
  for (const ip of collectLocalIpv4()) {
    if (ip !== '127.0.0.1') {
      altNames.push({ type: 7, ip });
    }
  }

  const notAfterDate = new Date();
  notAfterDate.setFullYear(notAfterDate.getFullYear() + 30);

  const pems = await selfsigned.generate(
    [{ name: 'commonName', value: 'BlockProxy-panel' }],
    {
      keyType: 'ec',
      curve: 'P-256',
      algorithm: 'sha256',
      notAfterDate,
      extensions: [
        { name: 'basicConstraints', cA: false },
        { name: 'subjectAltName', altNames }
      ]
    }
  );

  // 私钥用 0600，与 SOCKS5 证书落盘权限保持一致
  writeFileAtomic(keyPath, pems.private, 0o600);
  writeFileAtomic(certPath, pems.cert, 0o644);

  console.log('[Cert] 已生成管理面板 TLS 证书（30 年有效，ECC P-256，SAN 含本机内网 IP）');
  console.log(`[Cert]   ${certPath}`);
  console.log(`[Cert]   ${keyPath}`);

  return { generated: true, keyPath, certPath };
}

module.exports = {
  ensureTempCert,
  ensurePanelCert,
  inspectPanelCert,
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
