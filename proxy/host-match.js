// 域名匹配语义（filter_host / 访问日志共用）
//
// 约定：filter_host 描述的是「某个域名及其所有子域」，不是任意子串。
//   filter_host = "y.qq.com"  →  命中 y.qq.com、www.y.qq.com
//                                不命中 ios.bugly.qq.com（只是恰好以 y.qq.com 结尾）
//   filter_host = "baidu.com" →  命中 baidu.com、mbd.baidu.com、s0-ant.baidu.com
//
// 之前用 host.includes(filter_host) 做子串匹配，会把 "ios.bugly.qq.com"
// 当成命中 "y.qq.com"，误伤无关域名。子域判定必须以 "." 为边界。

function stripPort(host) {
  if (typeof host !== 'string') return '';
  let value = host.trim();
  if (value === '') return '';

  if (value.startsWith('[')) {
    const closingBracket = value.indexOf(']');
    return closingBracket === -1 ? value.substring(1) : value.substring(1, closingBracket);
  }

  const lastColon = value.lastIndexOf(':');
  if (lastColon !== -1 && /^\d+$/.test(value.substring(lastColon + 1))) {
    return value.substring(0, lastColon);
  }
  return value;
}

// 归一化成一个可比较的域名 token：小写、去端口、去末尾点
function normalizeHostToken(input) {
  const host = stripPort(input);
  if (host === '') return '';
  return host.toLowerCase().replace(/\.+$/, '');
}

// host 是否属于 filterHost 指代的域名（自身或子域）
function hostMatchesRule(host, filterHost) {
  const target = normalizeHostToken(host);
  if (target === '') return false;

  // 允许配置写成 ".example.com" / "example.com."
  const rule = normalizeHostToken(filterHost).replace(/^\.+/, '');
  if (rule === '') return false;

  return target === rule || target.endsWith('.' + rule);
}

module.exports = {
  normalizeHostToken,
  hostMatchesRule
};
