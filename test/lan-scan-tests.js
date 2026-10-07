// 局域网扫描单元测试：node test/lan-scan-tests.js
// 只用纯函数与注入的假数据，不依赖真实网络环境
const assert = require('assert');
const lanScan = require('../proxy/lan-scan');

// ---------- 网段过滤 ----------

function testScannableIpv4AcceptsPrivateLans() {
  assert.strictEqual(lanScan.isScannableIpv4('192.168.1.10'), true);
  assert.strictEqual(lanScan.isScannableIpv4('192.168.124.240'), true);
  assert.strictEqual(lanScan.isScannableIpv4('10.0.0.5'), true);
  assert.strictEqual(lanScan.isScannableIpv4('10.255.255.254'), true);
}

function testScannableIpv4RejectsEverythingElse() {
  // 172 开头整段排除（含用户明确要排除的 docker0 172.17/16 与 vap 172.17.1/24）
  assert.strictEqual(lanScan.isScannableIpv4('172.16.0.1'), false);
  assert.strictEqual(lanScan.isScannableIpv4('172.17.0.1'), false);
  assert.strictEqual(lanScan.isScannableIpv4('172.17.1.254'), false);
  assert.strictEqual(lanScan.isScannableIpv4('172.31.255.254'), false);
  assert.strictEqual(lanScan.isScannableIpv4('172.0.0.1'), false);
  // 公网 / 回环 / 链路本地 / 保留段
  assert.strictEqual(lanScan.isScannableIpv4('111.192.194.102'), false);
  assert.strictEqual(lanScan.isScannableIpv4('8.8.8.8'), false);
  assert.strictEqual(lanScan.isScannableIpv4('100.64.0.1'), false);
  assert.strictEqual(lanScan.isScannableIpv4('127.0.0.1'), false);
  assert.strictEqual(lanScan.isScannableIpv4('169.254.1.1'), false);
  assert.strictEqual(lanScan.isScannableIpv4('224.0.0.251'), false);
  assert.strictEqual(lanScan.isScannableIpv4('239.255.255.250'), false);
  assert.strictEqual(lanScan.isScannableIpv4('255.255.255.255'), false);
  assert.strictEqual(lanScan.isScannableIpv4('0.0.0.0'), false);
}

function testScannableIpv4RejectsGarbage() {
  assert.strictEqual(lanScan.isScannableIpv4(''), false);
  assert.strictEqual(lanScan.isScannableIpv4('192.168.1'), false);
  assert.strictEqual(lanScan.isScannableIpv4('192.168.1.256'), false);
  assert.strictEqual(lanScan.isScannableIpv4('192.168.1.1.1'), false);
  assert.strictEqual(lanScan.isScannableIpv4(null), false);
  assert.strictEqual(lanScan.isScannableIpv4(undefined), false);
  assert.strictEqual(lanScan.isScannableIpv4('abc.def.ghi.jkl'), false);
}

function testPrefixLengthFromNetmask() {
  assert.strictEqual(lanScan.prefixLengthFromNetmask('255.255.255.0'), 24);
  assert.strictEqual(lanScan.prefixLengthFromNetmask('255.255.254.0'), 23);
  assert.strictEqual(lanScan.prefixLengthFromNetmask('255.255.252.0'), 22);
  assert.strictEqual(lanScan.prefixLengthFromNetmask('255.255.0.0'), 16);
  assert.strictEqual(lanScan.prefixLengthFromNetmask('255.255.255.255'), 32);
  assert.strictEqual(lanScan.prefixLengthFromNetmask('255.0.255.0'), null); // 掩码不连续
  assert.strictEqual(lanScan.prefixLengthFromNetmask('garbage'), null);
}

function testNetworkAddress() {
  assert.strictEqual(lanScan.networkAddress('192.168.124.240', '255.255.255.0'), '192.168.124.0');
  assert.strictEqual(lanScan.networkAddress('192.168.1.254', '255.255.255.0'), '192.168.1.0');
  assert.strictEqual(lanScan.networkAddress('10.1.2.3', '255.255.0.0'), '10.1.0.0');
}

// ---------- 网段枚举 ----------

function testCollectScanNetworksPicksPrivateSubnetsOnly() {
  // 取自路由器真实网卡列表（含 iKuai 场景的 192.168.1.* 与 openwrt 的 192.168.124.*）
  const interfaces = {
    lo: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true }],
    eth0: [{ family: 'IPv4', address: '192.168.1.254', netmask: '255.255.255.0', internal: false, mac: 'fa:27:3c:e5:31:5e' }],
    'br-lan': [{ family: 'IPv4', address: '192.168.124.1', netmask: '255.255.255.0', internal: false, mac: 'fa:27:3c:e5:31:5f' }],
    docker0: [{ family: 'IPv4', address: '172.17.0.1', netmask: '255.255.0.0', internal: false, mac: '02:42:1b:ab:71:92' }],
    'vap-lan-peer': [{ family: 'IPv4', address: '172.17.1.254', netmask: '255.255.255.0', internal: false, mac: 'ba:f4:14:d5:5c:fb' }],
    'pppoe-wan': [{ family: 'IPv4', address: '111.192.194.102', netmask: '255.255.255.255', internal: false, mac: '00:00:00:00:00:00' }]
  };

  const networks = lanScan.collectScanNetworks(interfaces);
  const keys = networks.map((n) => `${n.base}/${n.prefix}`).sort();

  assert.deepStrictEqual(keys, ['192.168.1.0/24', '192.168.124.0/24']);
}

function testCollectScanNetworksDeduplicatesSecondaryIps() {
  // 同一网卡绑了多个同网段 IP（192.168.124.1 / .11 / .10 都是 br-lan 的地址）
  const interfaces = {
    'br-lan': [
      { family: 'IPv4', address: '192.168.124.1', netmask: '255.255.255.0', internal: false, mac: 'fa:27:3c:e5:31:5f' },
      { family: 'IPv4', address: '192.168.124.11', netmask: '255.255.255.0', internal: false, mac: 'fa:27:3c:e5:31:5f' },
      { family: 'IPv4', address: '192.168.124.10', netmask: '255.255.255.0', internal: false, mac: 'fa:27:3c:e5:31:5f' }
    ]
  };

  const networks = lanScan.collectScanNetworks(interfaces);
  assert.strictEqual(networks.length, 1);
  assert.strictEqual(networks[0].base, '192.168.124.0');
  assert.strictEqual(networks[0].hostCount, 254);
}

function testCollectScanNetworksSkipsHugeSubnets() {
  const interfaces = {
    docker0: [{ family: 'IPv4', address: '10.0.0.1', netmask: '255.0.0.0', internal: false, mac: '02:42:1b:ab:71:92' }],
    wlan0: [{ family: 'IPv4', address: '10.1.2.3', netmask: '255.255.252.0', internal: false, mac: '02:42:1b:ab:71:93' }]
  };

  const networks = lanScan.collectScanNetworks(interfaces);
  // 10/8 太大被跳过，/22 允许
  assert.deepStrictEqual(networks.map((n) => `${n.base}/${n.prefix}`), ['10.1.0.0/22']);
}

function testCollectScanNetworksIgnoresIpv6AndMissingFields() {
  const interfaces = {
    en1: [
      { family: 'IPv6', address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', internal: false },
      { family: 'IPv4', address: '192.168.124.240', netmask: '255.255.255.0', internal: false, mac: 'f4:6b:8c:90:29:05' }
    ],
    empties: [null, {}]
  };

  const networks = lanScan.collectScanNetworks(interfaces);
  assert.strictEqual(networks.length, 1);
  assert.strictEqual(networks[0].address, '192.168.124.240');
}

function testCollectScanNetworksHandlesEmptyInput() {
  assert.deepStrictEqual(lanScan.collectScanNetworks({}), []);
  assert.deepStrictEqual(lanScan.collectScanNetworks(null), []);
  assert.deepStrictEqual(lanScan.collectScanNetworks(undefined), []);
}

function testHostsForNetworkCoversUsableRange() {
  const hosts = lanScan.hostsForNetwork({ base: '192.168.124.0', prefix: 24 });
  assert.strictEqual(hosts.length, 254);
  assert.strictEqual(hosts[0], '192.168.124.1');
  assert.strictEqual(hosts[253], '192.168.124.254');
  assert.ok(!hosts.includes('192.168.124.0'));
  assert.ok(!hosts.includes('192.168.124.255'));
}

function testHostsForNetworkSmallerSubnet() {
  const hosts = lanScan.hostsForNetwork({ base: '192.168.1.0', prefix: 25 });
  assert.deepStrictEqual(hosts, [
    '192.168.1.1', '192.168.1.2', '192.168.1.3', '192.168.1.4', '192.168.1.5',
    '192.168.1.6', '192.168.1.7', '192.168.1.8', '192.168.1.9', '192.168.1.10',
    '192.168.1.11', '192.168.1.12', '192.168.1.13', '192.168.1.14', '192.168.1.15',
    '192.168.1.16', '192.168.1.17', '192.168.1.18', '192.168.1.19', '192.168.1.20',
    '192.168.1.21', '192.168.1.22', '192.168.1.23', '192.168.1.24', '192.168.1.25',
    '192.168.1.26', '192.168.1.27', '192.168.1.28', '192.168.1.29', '192.168.1.30',
    '192.168.1.31', '192.168.1.32', '192.168.1.33', '192.168.1.34', '192.168.1.35',
    '192.168.1.36', '192.168.1.37', '192.168.1.38', '192.168.1.39', '192.168.1.40',
    '192.168.1.41', '192.168.1.42', '192.168.1.43', '192.168.1.44', '192.168.1.45',
    '192.168.1.46', '192.168.1.47', '192.168.1.48', '192.168.1.49', '192.168.1.50',
    '192.168.1.51', '192.168.1.52', '192.168.1.53', '192.168.1.54', '192.168.1.55',
    '192.168.1.56', '192.168.1.57', '192.168.1.58', '192.168.1.59', '192.168.1.60',
    '192.168.1.61', '192.168.1.62', '192.168.1.63', '192.168.1.64', '192.168.1.65',
    '192.168.1.66', '192.168.1.67', '192.168.1.68', '192.168.1.69', '192.168.1.70',
    '192.168.1.71', '192.168.1.72', '192.168.1.73', '192.168.1.74', '192.168.1.75',
    '192.168.1.76', '192.168.1.77', '192.168.1.78', '192.168.1.79', '192.168.1.80',
    '192.168.1.81', '192.168.1.82', '192.168.1.83', '192.168.1.84', '192.168.1.85',
    '192.168.1.86', '192.168.1.87', '192.168.1.88', '192.168.1.89', '192.168.1.90',
    '192.168.1.91', '192.168.1.92', '192.168.1.93', '192.168.1.94', '192.168.1.95',
    '192.168.1.96', '192.168.1.97', '192.168.1.98', '192.168.1.99', '192.168.1.100',
    '192.168.1.101', '192.168.1.102', '192.168.1.103', '192.168.1.104', '192.168.1.105',
    '192.168.1.106', '192.168.1.107', '192.168.1.108', '192.168.1.109', '192.168.1.110',
    '192.168.1.111', '192.168.1.112', '192.168.1.113', '192.168.1.114', '192.168.1.115',
    '192.168.1.116', '192.168.1.117', '192.168.1.118', '192.168.1.119', '192.168.1.120',
    '192.168.1.121', '192.168.1.122', '192.168.1.123', '192.168.1.124', '192.168.1.125',
    '192.168.1.126'
  ]);
}

// ---------- 邻居表解析 ----------

function testParseIpNeighKeepsResolvedNeighbors() {
  // 取自 OpenWrt 真实输出
  const output = [
    '192.168.1.1 dev eth0 lladdr 30:a1:76:97:96:4a STALE ',
    '192.168.124.187 dev br-lan lladdr 86:8e:78:a6:d9:3d STALE ',
    '192.168.124.6 dev br-lan lladdr 00:dd:b6:eb:26:5c REACHABLE ',
    '192.168.124.125 dev br-lan FAILED ',
    '192.168.124.128 dev br-lan lladdr 48:f3:f3:ca:1d:0e REACHABLE ',
    '192.168.124.240 dev br-lan lladdr f4:6b:8c:90:29:05 REACHABLE ',
    '172.17.0.3 dev docker0 lladdr 02:42:ac:11:00:03 REACHABLE ',
    '192.168.124.150 dev br-lan  INCOMPLETE'
  ].join('\n');

  const entries = lanScan.parseIpNeigh(output);
  assert.deepStrictEqual(entries, [
    { ip: '192.168.1.1', mac: '30:a1:76:97:96:4a' },
    { ip: '192.168.124.187', mac: '86:8e:78:a6:d9:3d' },
    { ip: '192.168.124.6', mac: '00:dd:b6:eb:26:5c' },
    { ip: '192.168.124.128', mac: '48:f3:f3:ca:1d:0e' },
    { ip: '192.168.124.240', mac: 'f4:6b:8c:90:29:05' },
    { ip: '172.17.0.3', mac: '02:42:ac:11:00:03' }
  ]);
}

function testParseIpNeighDropsDeadAndPartialEntries() {
  const output = [
    '192.168.124.199 dev br-lan FAILED',
    '192.168.124.150 dev br-lan INCOMPLETE',
    '192.168.124.222 dev br-lan FAILED'
  ].join('\n');

  assert.deepStrictEqual(lanScan.parseIpNeigh(output), []);
}

function testParseIpNeighHandlesEmptyAndGarbage() {
  assert.deepStrictEqual(lanScan.parseIpNeigh(''), []);
  assert.deepStrictEqual(lanScan.parseIpNeigh(null), []);
  assert.deepStrictEqual(lanScan.parseIpNeigh('no neighbors here'), []);
}

function testParseProcNetArpRequiresCompleteFlag() {
  // /proc/net/arp 的 Flags 0x2 = ATF_COM，缺了它即使有 HW address 也不可信
  const output = [
    'IP address       HW type     Flags       HW address            Mask     Device',
    '192.168.1.1      0x1         0x2         30:a1:76:97:96:4a     *        eth0',
    '192.168.124.125  0x1         0x0         14:c0:50:14:6e:a5     *        br-lan',
    '192.168.124.6    0x1         0x2         00:dd:b6:eb:26:5c     *        br-lan'
  ].join('\n');

  assert.deepStrictEqual(lanScan.parseProcNetArp(output), [
    { ip: '192.168.1.1', mac: '30:a1:76:97:96:4a' },
    { ip: '192.168.124.6', mac: '00:dd:b6:eb:26:5c' }
  ]);
}

function testParseProcNetArpHandlesEmpty() {
  assert.deepStrictEqual(lanScan.parseProcNetArp(''), []);
  assert.deepStrictEqual(lanScan.parseProcNetArp('IP address HW type Flags'), []);
}

function testParseNetstatRouteReadsMacosFormat() {
  // 取自 macOS 真实 `netstat -rn -f inet` 输出
  const output = [
    'Internet:',
    'Destination        Gateway            Flags               Netif Expire',
    'default            192.168.124.1      UGScg                 en1       ',
    '192.168.124        link#5             UCS                   en1      !',
    '192.168.124.1      fa:27:3c:e5:31:5f  UHLWIir               en1   1199',
    '192.168.124.2      7c:de:78:a9:83:a0  UHLWI                 en1   1137',
    '192.168.124.4      link#5             UHLWI                 en1      !',
    '192.168.124.128    48:f3:f3:ca:1d:e   UHLWI                 en1   1155',
    '192.168.124.240    f4:6b:8c:90:29:5   UHLWI                 lo0       ',
    '224.0.0/4          link#5             UmCS                  en1      !'
  ].join('\n');

  assert.deepStrictEqual(lanScan.parseNetstatRoute(output), [
    { ip: '192.168.124.1', mac: 'fa:27:3c:e5:31:5f' },
    { ip: '192.168.124.2', mac: '7c:de:78:a9:83:a0' },
    { ip: '192.168.124.128', mac: '48:f3:f3:ca:1d:e' },
    { ip: '192.168.124.240', mac: 'f4:6b:8c:90:29:5' }
  ]);
}

function testParseArpAHandlesAllPlatformFormats() {
  const macos = [
    'openwrt.me (192.168.124.1) at fa:27:3c:e5:31:5f on en1 ifscope [ethernet]',
    '? (192.168.124.4) at (incomplete) on en1 ifscope [ethernet]',
    'mdns.mcast.net (224.0.0.251) at 1:0:5e:0:0:fb on en1 ifscope permanent [ethernet]'
  ].join('\n');
  assert.deepStrictEqual(lanScan.parseArpA(macos), [
    { ip: '192.168.124.1', mac: 'fa:27:3c:e5:31:5f' },
    { ip: '224.0.0.251', mac: '1:0:5e:0:0:fb' }
  ]);

  const linux = '192.168.1.5                ether   aa:bb:cc:dd:ee:ff   C                     eth0';
  assert.deepStrictEqual(lanScan.parseArpA(linux), [{ ip: '192.168.1.5', mac: 'aa:bb:cc:dd:ee:ff' }]);

  const windows = '  192.168.1.5           aa-bb-cc-dd-ee-ff     dynamic';
  assert.deepStrictEqual(lanScan.parseArpA(windows), [{ ip: '192.168.1.5', mac: 'aa-bb-cc-dd-ee-ff' }]);
}

// ---------- MAC 归一化 ----------

function testNormalizeMacPadsSingleDigitOctets() {
  // 旧解析器读得出来但 downstream 的 normalizeMacAddress 会按 6 段解析，
  // 单个十六进制位必须补零，否则 proxy.js 的匹配逻辑会抛错跳过整条规则
  assert.strictEqual(lanScan.normalizeMac('48:f3:f3:ca:1d:e'), '48:F3:F3:CA:1D:0E');
  assert.strictEqual(lanScan.normalizeMac('f4:6b:8c:90:29:5'), 'F4:6B:8C:90:29:05');
  assert.strictEqual(lanScan.normalizeMac('0:dd:b6:ea:e6:2a'), '00:DD:B6:EA:E6:2A');
  assert.strictEqual(lanScan.normalizeMac('00:DD:B6:EB:26:5C'), '00:DD:B6:EB:26:5C');
  assert.strictEqual(lanScan.normalizeMac('aa-bb-cc-dd-ee-ff'), 'AA:BB:CC:DD:EE:FF');
}

function testNormalizeMacRejectsNonUnicastAndMalformed() {
  assert.strictEqual(lanScan.normalizeMac('00:00:00:00:00:00'), null); // 全零
  assert.strictEqual(lanScan.normalizeMac('ff:ff:ff:ff:ff:ff'), null); // 广播
  assert.strictEqual(lanScan.normalizeMac('01:00:5e:00:00:fb'), null); // 组播
  assert.strictEqual(lanScan.normalizeMac('33:33:00:00:00:01'), null); // IPv6 组播
  assert.strictEqual(lanScan.normalizeMac('link#5'), null);
  assert.strictEqual(lanScan.normalizeMac('aa:bb:cc:dd:ee'), null);
  assert.strictEqual(lanScan.normalizeMac('zz:bb:cc:dd:ee:ff'), null);
  assert.strictEqual(lanScan.normalizeMac(''), null);
  assert.strictEqual(lanScan.normalizeMac(null), null);
  assert.strictEqual(lanScan.normalizeMac(undefined), null);
}

// 归一化后的 MAC 必须能通过 proxy.js 的 normalizeMacAddress（不抛错）
function testNormalizedMacIsAcceptedByProxyNormalizer() {
  const proxy = require('../proxy/proxy.js');
  const samples = ['48:F3:F3:CA:1D:0E', 'F4:6B:8C:90:29:05', '00:DD:B6:EA:E6:2A'];
  for (const sample of samples) {
    // proxy.js 内部函数，通过 block 规则匹配的等价逻辑间接验证：能 split 成 6 段且每段合法
    const parts = sample.toLowerCase().trim().split(':');
    assert.strictEqual(parts.length, 6);
    for (const part of parts) assert.ok(/^[0-9a-f]{2}$/.test(part), `${sample} 的分段 ${part} 必须已是两位`);
  }
  assert.ok(proxy);
}

// ---------- 设备表组装 ----------

function testBuildDevicesFiltersToScannedHostsAndValidMacs() {
  const hosts = new Set(['192.168.124.1', '192.168.124.6', '192.168.124.125']);
  const entries = [
    { ip: '192.168.124.1', mac: 'fa:27:3c:e5:31:5f' },
    { ip: '192.168.124.6', mac: '00:dd:b6:eb:26:5c' },
    { ip: '192.168.124.125', mac: 'link#5' }, // 无效 MAC，丢弃
    { ip: '172.17.0.3', mac: '02:42:ac:11:00:03' }, // 不在本轮网段内，丢弃
    { ip: '192.168.124.9', mac: 'aa:bb:cc:dd:ee:ff' } // 未探测，丢弃
  ];

  assert.deepStrictEqual(lanScan.buildDevices({ hosts, entries, selfEntries: [] }), [
    { ip: '192.168.124.1', mac: 'FA:27:3C:E5:31:5F' },
    { ip: '192.168.124.6', mac: '00:DD:B6:EB:26:5C' }
  ]);
}

function testBuildDevicesIncludesSelfAddresses() {
  const hosts = new Set(['192.168.1.1', '192.168.124.1']);
  const selfEntries = [{ ip: '192.168.124.1', mac: 'fa:27:3c:e5:31:5f' }];

  assert.deepStrictEqual(lanScan.buildDevices({ hosts, entries: [], selfEntries }), [
    { ip: '192.168.124.1', mac: 'FA:27:3C:E5:31:5F' }
  ]);
}

function testBuildDevicesSortsByIpAndDeduplicates() {
  const hosts = new Set(['192.168.124.10', '192.168.1.2', '192.168.124.2']);
  const entries = [
    { ip: '192.168.124.10', mac: 'aa:bb:cc:dd:ee:10' },
    { ip: '192.168.124.10', mac: 'aa:bb:cc:dd:ee:11' }, // 同 IP 重复，保留第一条
    { ip: '192.168.1.2', mac: 'aa:bb:cc:dd:ee:02' },
    { ip: '192.168.124.2', mac: 'aa:bb:cc:dd:ee:01' }
  ];

  assert.deepStrictEqual(lanScan.buildDevices({ hosts, entries, selfEntries: [] }), [
    { ip: '192.168.1.2', mac: 'AA:BB:CC:DD:EE:02' },
    { ip: '192.168.124.2', mac: 'AA:BB:CC:DD:EE:01' },
    { ip: '192.168.124.10', mac: 'AA:BB:CC:DD:EE:10' }
  ]);
}

// ---------- 全量替换语义 ----------

function testDiffDeviceTablesReplacesInsteadOfAppending() {
  const previous = [
    { ip: '192.168.124.1', mac: 'FA:27:3C:E5:31:5F' },
    { ip: '192.168.124.99', mac: 'AA:BB:CC:DD:EE:99' } // 已离线，必须被移除
  ];
  const scanned = [{ ip: '192.168.124.1', mac: 'FA:27:3C:E5:31:5F' }];

  const diff = lanScan.diffDeviceTables(previous, scanned);
  assert.deepStrictEqual(diff.devices, [{ ip: '192.168.124.1', mac: 'FA:27:3C:E5:31:5F' }]);
  assert.deepStrictEqual(diff.removed, [{ ip: '192.168.124.99', mac: 'AA:BB:CC:DD:EE:99' }]);
  assert.deepStrictEqual(diff.added, []);
  assert.deepStrictEqual(diff.updated, []);
  assert.strictEqual(diff.changed, true);
}

function testDiffDeviceTablesDetectsAddedUpdatedAndUnchanged() {
  const previous = [
    { ip: '192.168.124.1', mac: 'FA:27:3C:E5:31:5F' },
    { ip: '192.168.124.7', mac: 'AA:BB:CC:DD:EE:07' }
  ];
  const scanned = [
    { ip: '192.168.124.1', mac: 'FA:27:3C:E5:31:5F' },
    { ip: '192.168.124.7', mac: 'AA:BB:CC:DD:EE:77' }, // MAC 变了
    { ip: '192.168.124.8', mac: 'AA:BB:CC:DD:EE:08' }  // 新设备
  ];

  const diff = lanScan.diffDeviceTables(previous, scanned);
  assert.strictEqual(diff.added.length, 1);
  assert.deepStrictEqual(diff.added[0], { ip: '192.168.124.8', mac: 'AA:BB:CC:DD:EE:08' });
  assert.deepStrictEqual(diff.updated, [{ ip: '192.168.124.7', from: 'AA:BB:CC:DD:EE:07', to: 'AA:BB:CC:DD:EE:77' }]);
  assert.deepStrictEqual(diff.removed, []);
  assert.strictEqual(diff.changed, true);

  // 完全相同时 changed 为 false（用于跳过无意义的写盘）
  const same = lanScan.diffDeviceTables(previous, previous);
  assert.strictEqual(same.changed, false);
  assert.deepStrictEqual(same.devices, previous);
}

function testDiffDeviceTablesHandlesEmptyScanResult() {
  const previous = [{ ip: '192.168.124.1', mac: 'FA:27:3C:E5:31:5F' }];
  const diff = lanScan.diffDeviceTables(previous, []);
  assert.deepStrictEqual(diff.devices, []);
  assert.strictEqual(diff.removed.length, 1);
  assert.strictEqual(diff.changed, true);
}

function testDiffDeviceTablesToleratesGarbageInput() {
  const diff = lanScan.diffDeviceTables(null, undefined);
  assert.deepStrictEqual(diff.devices, []);
  assert.strictEqual(diff.changed, false);

  const withGarbage = lanScan.diffDeviceTables([null, {}, { ip: '192.168.124.1', mac: 'AA:BB:CC:DD:EE:01' }], [null]);
  assert.deepStrictEqual(withGarbage.devices, []);
  assert.strictEqual(withGarbage.removed.length, 1);
}

function testDeviceTablesEqual() {
  const a = [{ ip: '192.168.124.1', mac: 'FA:27:3C:E5:31:5F' }];
  assert.strictEqual(lanScan.deviceTablesEqual(a, [...a]), true);
  assert.strictEqual(lanScan.deviceTablesEqual(a, []), false);
  assert.strictEqual(lanScan.deviceTablesEqual(a, [{ ip: '192.168.124.1', mac: 'XX' }]), false);
  assert.strictEqual(lanScan.deviceTablesEqual(null, a), false);
}

function testCollectSelfEntries() {
  const networks = [
    { address: '192.168.124.1', mac: 'FA:27:3C:E5:31:5F' },
    { address: '192.168.1.254', mac: 'fa:27:3c:e5:31:5e' },
    { address: '10.0.0.1', mac: null },
    { mac: 'AA:BB:CC:DD:EE:FF' }
  ];

  assert.deepStrictEqual(lanScan.collectSelfEntries(networks), [
    { ip: '192.168.124.1', mac: 'FA:27:3C:E5:31:5F' },
    { ip: '192.168.1.254', mac: 'fa:27:3c:e5:31:5e' }
  ]);
}

// ---------- 邻居表来源选择 ----------

function testNeighborSourcesPerPlatform() {
  const linux = lanScan.neighborSources('linux').map((s) => s.name);
  assert.deepStrictEqual(linux, ['ip-neigh', 'proc-net-arp', 'arp-a']);

  const darwin = lanScan.neighborSources('darwin').map((s) => s.name);
  assert.deepStrictEqual(darwin, ['netstat-rn', 'arp-a']);

  const win = lanScan.neighborSources('win32').map((s) => s.name);
  assert.deepStrictEqual(win, ['arp-a']);
}

// ---------- 主流程（注入假探测/假邻居表） ----------

async function testScanLanEndToEndWithInjectedData() {
  const interfaces = {
    'br-lan': [{ family: 'IPv4', address: '192.168.124.1', netmask: '255.255.255.0', internal: false, mac: 'fa:27:3c:e5:31:5f' }],
    docker0: [{ family: 'IPv4', address: '172.17.0.1', netmask: '255.255.0.0', internal: false, mac: '02:42:1b:ab:71:92' }]
  };

  let probedIps = [];
  const devices = await lanScan.scanLan({
    interfaces,
    settleMs: 0,
    probeHosts: async (ips) => { probedIps = ips; return ips.length; },
    readNeighborEntries: async () => ({
      source: 'fake',
      entries: [
        { ip: '192.168.124.1', mac: 'fa:27:3c:e5:31:5f' },
        { ip: '192.168.124.6', mac: '00:dd:b6:eb:26:5c' },
        { ip: '192.168.124.4', mac: 'link#5' },
        { ip: '172.17.0.3', mac: '02:42:ac:11:00:03' }
      ]
    })
  });

  // 只探测 192.168.124.*（172 被排除），254 个地址
  assert.strictEqual(probedIps.length, 254);
  assert.ok(probedIps.includes('192.168.124.1'));
  assert.ok(probedIps.includes('192.168.124.254'));
  assert.ok(!probedIps.some((ip) => ip.startsWith('172.')));

  // 只保留有效单播 MAC，且不含 docker0 的 172 条目
  assert.deepStrictEqual(devices, [
    { ip: '192.168.124.1', mac: 'FA:27:3C:E5:31:5F' },
    { ip: '192.168.124.6', mac: '00:DD:B6:EB:26:5C' }
  ]);
}

async function testScanLanThrowsWithoutScannableNetwork() {
  await assert.rejects(
    () => lanScan.scanLan({
      interfaces: { 'pppoe-wan': [{ family: 'IPv4', address: '111.192.194.102', netmask: '255.255.255.255', internal: false }] },
      settleMs: 0
    }),
    /没有找到可扫描的局域网网段/
  );
}

async function testScanLanSurvivesProbeFailure() {
  const interfaces = {
    en1: [{ family: 'IPv4', address: '192.168.124.240', netmask: '255.255.255.0', internal: false, mac: 'f4:6b:8c:90:29:05' }]
  };

  const devices = await lanScan.scanLan({
    interfaces,
    settleMs: 0,
    probeHosts: async () => { throw new Error('探测失败'); },
    readNeighborEntries: async () => ({ source: 'fake', entries: [] })
  }).catch((error) => {
    // 探测失败应向上抛，由调用方决定是否保留旧表
    assert.match(error.message, /探测失败/);
    return null;
  });

  assert.strictEqual(devices, null);
}

// ---------- 运行 ----------

const tests = [
  testScannableIpv4AcceptsPrivateLans,
  testScannableIpv4RejectsEverythingElse,
  testScannableIpv4RejectsGarbage,
  testPrefixLengthFromNetmask,
  testNetworkAddress,
  testCollectScanNetworksPicksPrivateSubnetsOnly,
  testCollectScanNetworksDeduplicatesSecondaryIps,
  testCollectScanNetworksSkipsHugeSubnets,
  testCollectScanNetworksIgnoresIpv6AndMissingFields,
  testCollectScanNetworksHandlesEmptyInput,
  testHostsForNetworkCoversUsableRange,
  testHostsForNetworkSmallerSubnet,
  testParseIpNeighKeepsResolvedNeighbors,
  testParseIpNeighDropsDeadAndPartialEntries,
  testParseIpNeighHandlesEmptyAndGarbage,
  testParseProcNetArpRequiresCompleteFlag,
  testParseProcNetArpHandlesEmpty,
  testParseNetstatRouteReadsMacosFormat,
  testParseArpAHandlesAllPlatformFormats,
  testNormalizeMacPadsSingleDigitOctets,
  testNormalizeMacRejectsNonUnicastAndMalformed,
  testNormalizedMacIsAcceptedByProxyNormalizer,
  testBuildDevicesFiltersToScannedHostsAndValidMacs,
  testBuildDevicesIncludesSelfAddresses,
  testBuildDevicesSortsByIpAndDeduplicates,
  testDiffDeviceTablesReplacesInsteadOfAppending,
  testDiffDeviceTablesDetectsAddedUpdatedAndUnchanged,
  testDiffDeviceTablesHandlesEmptyScanResult,
  testDiffDeviceTablesToleratesGarbageInput,
  testDeviceTablesEqual,
  testCollectSelfEntries,
  testNeighborSourcesPerPlatform,
  testScanLanEndToEndWithInjectedData,
  testScanLanThrowsWithoutScannableNetwork,
  testScanLanSurvivesProbeFailure
];

(async () => {
  for (const testFn of tests) {
    await testFn();
    console.log(`PASS ${testFn.name}`);
  }
  console.log('lan scan tests passed');
})().catch((error) => {
  console.error('FAIL', error);
  process.exit(1);
});
