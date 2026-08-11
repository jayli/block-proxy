// proxy/attacker.js
// 存储每个 IP 的访问信息
const ipAccessLog = new Map(); 
// value: { timestamps: number[], isBad: boolean, lastSeen: number, goodUntil: number | null }

const WINDOW_MS = 2 * 60 * 1000;        // 2 分钟滑动窗口
const BAD_THRESHOLD = 20;               // 恶意阈值
const INACTIVE_TIMEOUT = 10 * 60 * 1000; // 普通 IP 10 分钟无活动则清理
const GOOD_GUY_DURATION = 10 * 60 * 1000; // 好人豁免期：10 分钟

/**
 * 记录并返回指定 IP 在过去 2 分钟内的访问次数
 * 如果在“好人豁免期”内，即使高频也不标记为恶意
 */
function countIPAccess(ip) {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;

  let record = ipAccessLog.get(ip);
  if (!record) {
    record = {
      timestamps: [],
      isBad: false,
      lastSeen: 0,
      goodUntil: null // 新增字段
    };
  }

  // 清理过期时间戳
  const recentTimestamps = record.timestamps.filter(ts => ts > cutoff);
  recentTimestamps.push(now);
  const currentCount = recentTimestamps.length;

  // 🔒 判断是否处于“好人豁免期”
  const isInGoodPeriod = record.goodUntil && now < record.goodUntil;

  // 只有不在豁免期，才可能被标记为坏人
  const newIsBad = isInGoodPeriod 
    ? false 
    : (record.isBad || currentCount >= BAD_THRESHOLD);

  ipAccessLog.set(ip, {
    timestamps: recentTimestamps,
    isBad: newIsBad,
    lastSeen: now,
    goodUntil: record.goodUntil // 保留原有 goodUntil
  });

  return currentCount;
}

/**
 * 判断是否为恶意 IP
 * 注意：即使 isBad=true，若在 goodUntil 期内，也应视为非恶意（但按你要求，isBad 字段可保留）
 * 但根据你的描述：“只要被标记过是好人就不能被标记为坏人”，我们让 isBad=false 在豁免期内
 * —— 实际上上面 countIPAccess 已确保 isBad 不会为 true
 */
function isBadGuy(ip) {
  const record = ipAccessLog.get(ip);
  if (!record) return false;

  const now = Date.now();
  const isInGoodPeriod = record.goodUntil && now < record.goodUntil;

  // 豁免期内，即使 isBad 字段残留，也返回 false
  return isInGoodPeriod ? false : record.isBad;
}

/**
 * 手动将 IP 标记为“好人”：获得 10 分钟豁免权
 * - 不能被标记为恶意
 * - 记录至少保留 10 分钟（即使无访问）
 */
function setGoodGuy(ip) {
  const now = Date.now();
  let record = ipAccessLog.get(ip);

  if (!record) {
    record = {
      timestamps: [],
      isBad: false,
      lastSeen: now,
      goodUntil: null
    };
  }

  // 设置豁免截止时间
  record.goodUntil = now + GOOD_GUY_DURATION;
  record.lastSeen = now; // 更新 lastSeen 防止被 cleanup 立即删掉
  record.isBad = false;  // 立即洗白

  ipAccessLog.set(ip, record);
}

/**
 * 清理过期记录：
 * - 普通 IP：10 分钟无访问 → 删除
 * - 好人 IP：即使无访问，只要 goodUntil 未过期 → 保留
 */
function cleanupInactiveIPs() {
  const now = Date.now();
  const inactiveCutoff = now - INACTIVE_TIMEOUT;

  for (const [ip, record] of ipAccessLog.entries()) {
    const isGoodGuyActive = record.goodUntil && now < record.goodUntil;

    if (!isGoodGuyActive && record.lastSeen < inactiveCutoff) {
      // 不是活跃好人，且超过 10 分钟无访问 → 删除
      ipAccessLog.delete(ip);
    } else {
      // 清理 timestamps 中的过期项
      const recent = record.timestamps.filter(ts => ts > now - WINDOW_MS);
      if (recent.length !== record.timestamps.length) {
        ipAccessLog.set(ip, { ...record, timestamps: recent });
      }
    }
  }

  // 在 countIPAccess 中增加硬上限（例如最多保留 10,000 个 IP）
  if (ipAccessLog.size > 10000) {
    // 按 lastSeen 排序，删除最旧的一批
    const sorted = Array.from(ipAccessLog.entries())
      .sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    for (let i = 0; i < 1000; i++) {
      ipAccessLog.delete(sorted[i][0]);
    }
  }
}

module.exports = {
  countIPAccess,
  isBadGuy,
  setGoodGuy,
  cleanupInactiveIPs
};
