
const filtered_mitm_domains = [
  "youtube.com",
  "googlevideo.com",
  "youtubei.googleapis.com"
];

// a.com:443 → a.com
function trimHost(host) {
  if (/:\d+$/.test(host)) {
    host = host.split(":")[0];
  }
  return host;
}

module.exports = {
  filtered_mitm_domains: filtered_mitm_domains,
  getUA: function(headers) {
    if (headers.hasOwnProperty("User-Agent")) {
      return headers["User-Agent"];
    } else if (headers.hasOwnProperty("user-agent")) {
      return headers["user-agent"];
    } else {
      return "";
    }
  },
  isYoutubeApp: function(ua) {
    if (ua.startsWith("com.google.ios.youtube") || ua.startsWith("com.google.android.youtube")) {
      return true;
    } else {
      return false;
    }
  },
  // 判断是否需要放行
  // 无须做mitm: return true
  // 需要做mitm: return false
  match: function(headers, host) {
    host = trimHost(host);
    // Hack，Youtube 广告拦截不兼容浏览器，浏览器访问 Youtube 的广告拦截都不做 mitm
    if (!this.isYoutubeApp(this.getUA(headers)) &&
      this.filtered_mitm_domains.some(domain => host.endsWith(domain) || host === domain)) {
      return true;
    } else {
      return false;
    }
  }
};
