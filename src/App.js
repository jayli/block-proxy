// src/App.js
import React, { useState, useEffect, useRef } from 'react';
import './App.css';
import QRCode from 'qrcode';

// Toast组件
const Toast = ({ message, type, onClose }) => {
  if (!message) return null;

  return (
    <div className={`toast ${type}`}>
      <span>{message}</span>
      <button className="toast-close" onClick={onClose}>×</button>
    </div>
  );
};

// 登录页组件
const LoginPage = ({ onLogin, loading, error }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    onLogin(username, password);
  };

  return (
    <div className="login-page">
      <form className="login-form" onSubmit={handleSubmit}>
        <h2>管理面板登录</h2>
        {error && <div className="login-error">{error}</div>}
        <div className="login-field">
          <label>用户名</label>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
          />
        </div>
        <div className="login-field">
          <label>密码</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <button type="submit" className="login-btn" disabled={loading}>
          {loading ? '登录中...' : '登录'}
        </button>
      </form>
    </div>
  );
};

function App() {
  const [loggedIn, setLoggedIn] = useState(null); // null = 检查中, true = 已登录, false = 未登录
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState('');

  const [config, setConfig] = useState({
    block_hosts: [],
    proxy_port: 8001,
    socks5_port:8002,
    socks5_tls: "1",
    auth_username: "",
    auth_password: "",
    login_username: "",
    login_password: "",
  });

  const [newHost, setNewHost] = useState('');
  const [timezone, setTimeZone] = useState('');
  const [newMatchRule, setNewMatchRule] = useState('');
  const [newStartTime, setNewStartTime] = useState('00:00');
  const [newEndTime, setNewEndTime] = useState('23:59');
  const [newTunnelDomain, setNewTunnelDomain] = useState('');
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState({ message: '', type: '' });
  const [toastTimer, setToastTimer] = useState(null);
  const [serverIPs, setServerIPs] = useState([]);
  const [isDocker, setIsDocker] = useState(false);
  const [hostIPs, setHostIPs] = useState([]);
  const [devices, setDevices] = useState([]);
  const [ruleModules, setRuleModules] = useState([]);
  const [activeTab, setActiveTab] = useState(0);
  const fileInputRef = useRef(null);

  // 检查登录状态
  useEffect(() => {
    checkAuth();
  }, []);

  const checkAuth = async () => {
    try {
      const response = await fetch('/api/auth-check');
      const data = await response.json();
      setLoggedIn(data.authenticated);
    } catch (error) {
      setLoggedIn(true); // 网络错误时默认已登录，避免死循环
    }
  };

  // 统一处理 401：cookie 失效时跳回登录页
  const handle401 = (response) => {
    if (response.status === 401) {
      setLoggedIn(false);
      return true;
    }
    return false;
  };

  const handleLogin = async (username, password) => {
    setLoginLoading(true);
    setLoginError('');
    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await response.json();
      if (response.ok) {
        setLoggedIn(true);
      } else {
        setLoginError(data.error || '登录失败');
      }
    } catch (error) {
      setLoginError('网络错误: ' + error.message);
    }
    setLoginLoading(false);
  };

  // 组件加载时获取当前配置和服务器IP
  useEffect(() => {
    if (loggedIn) {
      fetchConfig();
      fetchServerIPs();
      fetchTimeZone();
      fetchRuleModules();
    }

    // 清理定时器
    return () => {
      if (toastTimer) {
        clearTimeout(toastTimer);
      }
    };
  }, [loggedIn]);

  const fetchTimeZone = async () => {
    const response = await fetch('/api/timezone');
    if (handle401(response)) return;
    if (response.ok) {
      const data = await response.json();
      setTimeZone(data.timezone);
    } else {
      setTimeZone("");
    }
  };

  const fetchServerIPs = async () => {
    try {
      const response = await fetch('/api/server-ip');
      if (handle401(response)) return;
      if (response.ok) {
        const data = await response.json();
        setServerIPs(data.ips);
        setIsDocker(data.docker);
        if (data.hostIPs) {
          setHostIPs(data.hostIPs);
        }
        var localIp = "0.0.0.0"
        if (data.hostIPs) {
          localIp = data.hostIPs.split(",")[0];
        } else if (data.ips.length >= 1) {
          localIp = data.ips[0].address;
        }
        QRCode.toCanvas(document.getElementById('qrcode'), `${window.location.origin}/fetchCrtFile`);
      } else {
        showToast('获取服务器IP失败', 'error');
      }
    } catch (error) {
      showToast('网络错误: ' + error.message, 'error');
    }
  };

  // 修改 fetchConfig 函数：
  const fetchConfig = async () => {
    try {
      const response = await fetch('/api/config');
      if (handle401(response)) return;
      if (response.ok) {
        const data = await response.json();
        setConfig(data);
        // 同时设置设备信息
        if (data.devices) {
          setDevices(data.devices);
        }
      } else {
        showToast('获取配置失败', 'error');
      }
    } catch (error) {
      showToast('网络错误: ' + error.message, 'error');
    }
  };

  const fetchRuleModules = async () => {
    try {
      const response = await fetch('/api/rules');
      if (handle401(response)) return;
      if (response.ok) {
        const data = await response.json();
        setRuleModules(data);
      }
    } catch (error) {
      showToast('获取 Rule 逻辑失败: ' + error.message, 'error');
    }
  };

  const updateRuleModuleEnabled = (id, enabled) => {
    setRuleModules(ruleModules.map((rule) => (
      rule.id === id ? { ...rule, enabled } : rule
    )));
    setConfig({
      ...config,
      rule_modules: {
        ...(config.rule_modules || {}),
        [id]: enabled
      }
    });
  };

  const showToast = (message, type) => {
    // 清除之前的定时器
    if (toastTimer) {
      clearTimeout(toastTimer);
    }

    // 设置新的toast
    setToast({ message, type });

    // 设置新的定时器并保存引用
    const newTimer = setTimeout(() => {
      setToast({ message: '', type: '' });
      setToastTimer(null);
    }, 3000);

    // 保存定时器引用
    setToastTimer(newTimer);
  };

  const closeToast = () => {
    // 清除定时器
    if (toastTimer) {
      clearTimeout(toastTimer);
      setToastTimer(null);
    }
    setToast({ message: '', type: '' });
  };

  const handleAddHost = async () => {
    if (newHost.trim()) {
      const newFilterItem = {
        filter_host: newHost.trim(),
        filter_match_rule: newMatchRule.trim(), // 添加 match_rule 字段，默认为空
        filter_start_time: newStartTime,
        filter_end_time: newEndTime,
        filter_weekday: [1, 2, 3, 4, 5, 6, 7] // 默认每天生效
      };

      const updatedConfig = {
        ...config,
        block_hosts: [...config.block_hosts, newFilterItem]
      };

      // Update local state first
      setConfig(updatedConfig);
      setNewHost('');

      // Save to config.json via API
      setLoading(true);
      await saveConfig(updatedConfig);
      setLoading(false);
    }
  };

  const handleRemoveHost = async (hostToRemove) => {
    // 添加确认框
    const confirmed = window.confirm(`确定要删除主机 "${typeof hostToRemove === 'string' ? hostToRemove : hostToRemove.filter_host}" 吗？`);
    if (confirmed) {
      const updatedConfig = {
        ...config,
        block_hosts: config.block_hosts.filter(host => {
          if (typeof host === 'string') {
            return host !== hostToRemove;
          } else {
            return host !== hostToRemove && host.filter_host !== hostToRemove;
          }
        })
      };
      setConfig(updatedConfig);
      await saveConfig(updatedConfig);
    }
  };

  const handleSaveConfig = async () => {
    setLoading(true);
    // 先保存配置
    let saveResult = await saveConfig(config);
    setLoading(false);
  };

  const saveConfig = async (config) => {
    try {
      const response = await fetch('/api/config', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(config)
      });

      if (handle401(response)) return false;

      if (response.ok) {
        showToast('配置保存成功!', 'success');
        return true;
      } else {
        showToast('保存失败', 'error');
        return false;
      }
    } catch (error) {
      showToast('网络错误: ' + error.message, 'error');
      return false;
    }
  };

  const handleRestartProxy = async () => {
    setLoading(true);

    // 先保存配置
    if (!await saveConfig(config)) {
      setLoading(false);
      return;
    }

    try {
      const response = await fetch('/api/restart', {
        method: 'POST'
      });

      if (handle401(response)) {
        setLoading(false);
        return;
      }

      if (response.ok) {
        showToast('代理服务器重启成功!', 'success');
      } else {
        const errorData = await response.json();
        showToast('重启失败: ' + errorData.error, 'error');
      }
    } catch (error) {
      showToast('网络错误: ' + error.message, 'error');
    }
    setLoading(false);
  };


  // 在 handleRestartProxy 函数后面添加以下函数：
  const handleUpdateDevices = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/update-devices', {
        method: 'POST'
      });

      if (handle401(response)) {
        setLoading(false);
        return;
      }

      if (response.ok) {
        showToast('路由表刷新成功!', 'success');
        await fetchConfig();
      } else {
        const errorData = await response.json();
        showToast('刷新失败: ' + errorData.error, 'error');
      }
    } catch (error) {
      showToast('网络错误: ' + error.message, 'error');
    }
    setLoading(false);
  };

  // 导出配置
  const handleExportConfig = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/config/export');
      if (handle401(response)) {
        setLoading(false);
        return;
      }
      if (!response.ok) {
        showToast('导出失败', 'error');
        setLoading(false);
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'config.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('配置导出成功', 'success');
    } catch (error) {
      showToast('网络错误: ' + error.message, 'error');
    }
    setLoading(false);
  };

  // 导入配置
  const handleImportClick = () => {
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  const handleImportFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // 重置 file input，允许重复选择同一文件
    e.target.value = '';

    setLoading(true);
    try {
      const text = await file.text();
      // 客户端预检 JSON 格式
      try {
        JSON.parse(text);
      } catch {
        showToast('文件格式错误：不是有效的 JSON', 'error');
        setLoading(false);
        return;
      }

      const response = await fetch('/api/config/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: text
      });

      if (handle401(response)) {
        setLoading(false);
        return;
      }

      const data = await response.json();

      if (response.ok) {
        showToast('配置导入成功', 'success');
        await fetchConfig();
        await fetchRuleModules();
      } else {
        // 拼接校验错误详情
        const detailMsg = data.details ? data.details.join('；') : data.error;
        showToast(`导入失败：${detailMsg}`, 'error');
      }
    } catch (error) {
      showToast('网络错误: ' + error.message, 'error');
    }
    setLoading(false);
  };

  // 更新拦截项的时间段
  const updateFilterTime = async (index, startTime, endTime) => {
    const updatedBlockHosts = [...config.block_hosts];

    // 兼容旧格式转换为新格式
    if (typeof updatedBlockHosts[index] === 'string') {
      updatedBlockHosts[index] = {
        filter_host: updatedBlockHosts[index],
        filter_start_time: startTime,
        filter_end_time: endTime,
        filter_weekday: [1, 2, 3, 4, 5, 6, 7] // 默认每天生效
      };
    } else {
      updatedBlockHosts[index] = {
        ...updatedBlockHosts[index],
        filter_start_time: startTime,
        filter_end_time: endTime
      };
    }

    const updatedConfig = {
      ...config,
      block_hosts: updatedBlockHosts
    };

    setConfig(updatedConfig);
    await saveConfig(updatedConfig);
  };

  // 更新拦截项的星期几设置
  const updateFilterWeekday = async (index, day) => {
    const updatedBlockHosts = [...config.block_hosts];

    // 兼容旧格式转换为新格式
    if (typeof updatedBlockHosts[index] === 'string') {
      updatedBlockHosts[index] = {
        filter_host: updatedBlockHosts[index],
        filter_start_time: '00:00',
        filter_end_time: '23:59',
        filter_weekday: [1, 2, 3, 4, 5, 6, 7] // 默认每天生效
      };
    }

    // 初始化 filter_weekday 如果不存在
    if (!updatedBlockHosts[index].filter_weekday) {
      updatedBlockHosts[index].filter_weekday = [1, 2, 3, 4, 5, 6, 7];
    }

    // 切换星期几的选中状态
    const weekdays = [...updatedBlockHosts[index].filter_weekday];
    const dayIndex = weekdays.indexOf(day);

    if (dayIndex > -1) {
      // 如果已存在，则移除
      weekdays.splice(dayIndex, 1);
    } else {
      // 如果不存在，则添加
      weekdays.push(day);
      weekdays.sort((a, b) => a - b); // 排序
    }

    updatedBlockHosts[index] = {
      ...updatedBlockHosts[index],
      filter_weekday: weekdays
    };

    const updatedConfig = {
      ...config,
      block_hosts: updatedBlockHosts
    };

    setConfig(updatedConfig);
    await saveConfig(updatedConfig);
  };

  // 更新拦截项的MAC地址
  const updateFilterMac = async (index, mac) => {
    const updatedBlockHosts = [...config.block_hosts];

    // 兼容旧格式转换为新格式
    if (typeof updatedBlockHosts[index] === 'string') {
      updatedBlockHosts[index] = {
        filter_host: updatedBlockHosts[index],
        filter_start_time: '00:00',
        filter_end_time: '23:59',
        filter_mac: mac,
        filter_weekday: [1, 2, 3, 4, 5, 6, 7] // 默认每天生效
      };
    } else {
      updatedBlockHosts[index] = {
        ...updatedBlockHosts[index],
        filter_mac: mac
      };
    }

    const updatedConfig = {
      ...config,
      block_hosts: updatedBlockHosts
    };

    setConfig(updatedConfig);
    await saveConfig(updatedConfig);
  };

  function getIpAddress() {
    let addr = '';
    if (serverIPs.length == 0) {
      return '0.0.0.0';
    } else {
      serverIPs.map((ip, index) => {
        if(index == 0) {
          addr = ip.address;
        }
      });
    }
    return addr;
  }

  // 获取拦截项的显示名称
  const getFilterHostDisplay = (filterItem) => {
    return typeof filterItem === 'string' ? filterItem : filterItem.filter_host;
  };

  // 获取拦截项的 match_rule
  const getFilterMatchRule= (filterItem) => {
    if (typeof filterItem === 'string') {
      return ''; // 字符串格式没有 match_rule 字段
    }
    return filterItem.filter_match_rule || '';
  };

  // 获取拦截项的时间段
  const getFilterTimes = (filterItem) => {
    if (typeof filterItem === 'string') {
      return { start: '00:00', end: '23:59' };
    }
    return {
      start: filterItem.filter_start_time || '00:00',
      end: filterItem.filter_end_time || '23:59'
    };
  };

  // 获取拦截项的星期几设置
  const getFilterWeekdays = (filterItem) => {
    if (typeof filterItem === 'string') {
      return [1, 2, 3, 4, 5, 6, 7]; // 默认每天生效
    }
    return filterItem.filter_weekday || [1, 2, 3, 4, 5, 6, 7];
  };

  // 获取拦截项的MAC地址
  const getFilterMac = (filterItem) => {
    if (typeof filterItem === 'string') {
      return ''; // 字符串格式没有MAC地址字段
    }
    return filterItem.filter_mac || '';
  };

  // 星期几的显示名称
  const weekdayNames = ['一', '二', '三', '四', '五', '六', '日'];

  // 未登录时显示登录页
  if (!loggedIn) {
    return <LoginPage onLogin={handleLogin} loading={loginLoading} error={loginError} />;
  }

  return (
    <div className="App">
      <div className="config-container">
        <h1>代理服务器配置</h1>

        {/* Toast提示组件 */}
        <Toast
          message={toast.message}
          type={toast.type}
          onClose={closeToast}
        />

        {/* 服务器IP信息 */}
        <div className="config-section">
          <div className="server-info">
            {serverIPs.length > 0 ? (
              <div>
                <p>
                  <strong>服务器IP地址:</strong>
                  <span className="docker-info">{isDocker ? ' (Docker环境)' : ' (非Docker环境)'}</span>
                  <span>&nbsp;{timezone}</span>
                </p>
                <ul className="ip-list">
                  {serverIPs.map((ip, index) => (
                    <li key={index} className="ip-item">
                      <span className="interface-name">{ip.interface}:</span>
                      <span className="ip-address">{ip.address}</span>
                    </li>
                  ))}
                </ul>

                {/* 显示宿主机IP信息 */}
                {isDocker && (
                  <div className="host-ip-info">
                    <p><strong>宿主机IP地址:</strong>{hostIPs}</p>
                  </div>
                )}
              </div>
            ) : (
              <p>正在获取服务器IP地址...</p>
            )}
          </div>
        </div>

        {/* Tab 导航栏 */}
        <div className="tab-bar">
          <button
            className={`tab-btn ${activeTab === 0 ? 'active' : ''}`}
            onClick={() => setActiveTab(0)}
          >
            HTTP/Socks5 端口设置
          </button>
          <button
            className={`tab-btn ${activeTab === 1 ? 'active' : ''}`}
            onClick={() => setActiveTab(1)}
          >
            拦截主机列表
          </button>
          <button
            className={`tab-btn ${activeTab === 2 ? 'active' : ''}`}
            onClick={() => setActiveTab(2)}
          >
            路由表
          </button>
          <button
            className={`tab-btn ${activeTab === 3 ? 'active' : ''}`}
            onClick={() => setActiveTab(3)}
          >
            隧道配置
          </button>
        </div>

        {/* Tab 0: HTTP/Socks5 端口设置 */}
        {activeTab === 0 && (
        <div className="config-section tab-content">
          <h2>HTTP/Socks5 端口设置</h2>
          <div className="setting-row">
            <label>HTTP 代理端口:</label>
            <input
              type="number"
              value={config.proxy_port}
              onChange={(e) => setConfig({...config, proxy_port: parseInt(e.target.value) || 8001})}
            />
          </div>
          <div className="setting-row">
            <label>Socks5 代理端口:</label>
            <input
              type="number"
              value={config.socks5_port}
              onChange={(e) => setConfig({...config, socks5_port: parseInt(e.target.value) || 8002})}
            />
          </div>
          <div className="setting-row">
            <label>Socks5 启用 TLS:</label>
            <select
              value={config.socks5_tls || "1"}
              onChange={(e) => setConfig({...config, socks5_tls: e.target.value})}
            >
              <option value="1">开启（加密传输）</option>
              <option value="0">关闭（纯 TCP）</option>
            </select>
          </div>

          <div className="setting-row">
            <label>代理用户名:</label>
            <input
              type="text"
              value={config.auth_username}
              onChange={(e) => setConfig({...config, auth_username: e.target.value || ""})}
            />
          </div>
          <div className="setting-row">
            <label>代理密码:</label>
            <input
              type="text"
              value={config.auth_password}
              onChange={(e) => setConfig({...config, auth_password: e.target.value || ""})}
            />
          </div>

          <div className="setting-row">
            <label>管理面板登录用户名:</label>
            <input
              type="text"
              value={config.login_username || ""}
              onChange={(e) => setConfig({...config, login_username: e.target.value || ""})}
              placeholder="留空则无需登录"
            />
          </div>
          <div className="setting-row">
            <label>管理面板登录密码:</label>
            <input
              type="text"
              value={config.login_password || ""}
              onChange={(e) => setConfig({...config, login_password: e.target.value || ""})}
              placeholder="留空则无需登录"
            />
          </div>
          <div className="help-text" style={{ marginTop: '-8px', marginBottom: '8px' }}>
            设置后重启代理生效，浏览器会弹出登录框
          </div>

          <div className="setting-row full-width">
            <label>公网域名:</label>
            <input
              type="text"
              value={config.your_domain}
              onChange={(e) => setConfig({...config, your_domain: e.target.value || ""})}
            />
            <div className="help-text">如果要公网可访问，OpenWRT 配置相同的端口转发到 AnyProxy 代理端口，这里写公网域名<br />（仅在浏览器通过公网域名+端口查看系统水位时防止回环）</div>
          </div>

          <div className="setting-row full-width">
            <label>VPN_PROXY 设置（留空）:</label>
            <input
              type="text"
              value={config.vpn_proxy}
              onChange={(e) => setConfig({...config, vpn_proxy: e.target.value || ""})}
            />
            <div className="help-text">（格式："127.0.0.1:1087"，仅调试用）</div>
          </div>
          <div className="setting-row">
            <label>HTTPS MITM 解密:</label>
            <select
              value={config.enable_mitm || "1"}
              onChange={(e) => setConfig({...config, enable_mitm: e.target.value})}
            >
              <option value="1">开启（需安装证书，支持 URL 路径过滤 + 广告重写）</option>
              <option value="0">关闭（纯隧道转发，不拦截，零证书错误）</option>
            </select>
          </div>
          <div className="rule-module-block">
            <div className="rule-module-header">
              <h3>Rule 逻辑区块</h3>
              {(config.enable_mitm || "1") !== "1" && (
                <span className="rule-module-disabled-note">MITM 关闭时规则不会生效</span>
              )}
            </div>
            <div className="rule-module-list">
              {ruleModules.length === 0 ? (
                <div className="help-text">暂无已加载 Rule 逻辑</div>
              ) : ruleModules.map((rule) => (
                <label className="rule-module-item" key={rule.id}>
                  <input
                    type="checkbox"
                    checked={config.rule_modules?.[rule.id] !== false}
                    disabled={(config.enable_mitm || "1") !== "1"}
                    onChange={(e) => updateRuleModuleEnabled(rule.id, e.target.checked)}
                  />
                  <span className="rule-module-main">
                    <span className="rule-module-title">
                      {rule.name}
                      <span className="rule-module-source">{rule.source}</span>
                      <span className="rule-module-count">{rule.ruleCount} 条</span>
                    </span>
                    <span className="rule-module-description">{rule.description}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
          <div className="setting-row actions">
            <button
              onClick={handleExportConfig}
              disabled={loading}
              className="refresh-btn export-btn"
            >
              {loading ? '导出中...' : '导出配置'}
            </button>
            <button
              onClick={handleImportClick}
              disabled={loading}
              className="refresh-btn import-btn"
            >
              {loading ? '导入中...' : '导入配置'}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json"
              style={{ display: 'none' }}
              onChange={handleImportFile}
            />

            <button
              onClick={handleSaveConfig}
              disabled={loading}
              className="save-btn"
            >
              {loading ? '保存中...' : '保存配置'}
            </button>

            <button
              onClick={handleUpdateDevices}
              disabled={loading}
              className="refresh-btn"
            >
              {loading ? '刷新中...' : '刷新路由表'}
            </button>

            <button
              onClick={handleRestartProxy}
              disabled={loading}
              className="restart-btn"
            >
              {loading ? '重启中...' : '重启代理'}
            </button>
          </div>
        </div>
        )}

        {/* Tab 1: 拦截主机列表 */}
        {activeTab === 1 && (
        <div className="config-section tab-content">
          <h2>拦截主机列表</h2>
          <div className="host-input">
            <input
              type="text"
              value={newHost}
              onChange={(e) => setNewHost(e.target.value)}
              placeholder="域名,例如:example.com"
            />
            <input
              type="text"
              value={newMatchRule}
              onChange={(e) => setNewMatchRule(e.target.value)}
              placeholder="例子：^https?:\/\/.+abc\.com\/api\/\/def, 留空拦截全部"
            />
            <div className="time-inputs">
              <label><span>开始：</span>
                <input
                  type="time"
                  value={newStartTime}
                  onChange={(e) => setNewStartTime(e.target.value)}
                />
              </label>
              <label><span>结束：</span>
                <input
                  type="time"
                  value={newEndTime}
                  onChange={(e) => setNewEndTime(e.target.value)}
                />
              </label>
              <button onClick={handleAddHost}>添加</button>
            </div>
          </div>
          <hr className="simple-line" />
          <ul className="host-list">
            <li key={1000} className="host-item">
              <div className="host-info">域名</div>
              <div className="weekday-controls title-weedkey-controls">星期</div>
              <div className="title-mac-input">MAC 地址</div>
              <div className="title-time-controls">时间段</div>
              <div className="table-right-blank"></div>
            </li>
            {config.block_hosts.map((host, index) => (
              <li key={index} className="host-item">
                <div className="host-info">
                  <span className="host-text">
                    <strong>{getFilterHostDisplay(host)}</strong>
                    {getFilterMatchRule(host) && (
                      <span className="host-match-rule">{getFilterMatchRule(host)}</span>
                    )}
                  </span>
                  <div className="weekday-controls">
                    {weekdayNames.map((name, dayIndex) => {
                      const day = dayIndex + 1;
                      const weekdays = getFilterWeekdays(host);
                      const isActive = weekdays.includes(day);
                      return (
                        <button
                          key={day}
                          className={`weekday-btn ${isActive ? 'active' : ''}`}
                          onClick={() => updateFilterWeekday(index, day)}
                          title={`周${name}`}
                        >
                        {name}
                      </button>
                      );
                    })}
                  </div>
                  <div className="mac-input">
                    <input
                      type="text"
                      value={getFilterMac(host)}
                      onChange={(e) => updateFilterMac(index, e.target.value)}
                      placeholder="MAC地址(可选)"
                    />
                  </div>
                  <div className="time-controls">
                    <label>
                      <input
                        type="time"
                        value={getFilterTimes(host).start}
                        onChange={(e) => updateFilterTime(index, e.target.value, getFilterTimes(host).end)}
                      />
                    </label>
                    <label>～</label>
                    <label>
                      <input
                        type="time"
                        value={getFilterTimes(host).end}
                        onChange={(e) => updateFilterTime(index, getFilterTimes(host).start, e.target.value)}
                      />
                    </label>
                  </div>
                </div>
                <button
                  onClick={() => handleRemoveHost(host)}
                  className="remove-btn"
                >
                  X
                </button>
              </li>
            ))}
          </ul>
        </div>
        )}

        {/* Tab 2: 路由表 */}
        {activeTab === 2 && (
        <div className="config-section tab-content">
          <h2>路由表</h2>
          {devices && devices.length > 0 ? (
            <div>
              <p>当前共有 {devices.length} 个设备</p>
              <ul className="ip-list">
                {devices.map((device, index) => (
                  <li key={index} className="ip-item">
                    <span className="interface-name">{device.mac || '未知MAC'} &nbsp;</span>
                    <span className="ip-address">{device.ip || '未知IP'}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="empty-hint">暂无设备信息</p>
          )}
          <button
            onClick={fetchConfig}
            disabled={loading}
            className="refresh-table-btn"
          >
            {loading ? '刷新中...' : '更新路由表'}
          </button>
        </div>
        )}

        {/* Tab 3: 隧道配置 */}
        {activeTab === 3 && (
        <div className="config-section tab-content">
          <h2>隧道配置</h2>
          <div className="setting-row">
            <label>启用隧道:</label>
            <label className="switch">
              <input
                type="checkbox"
                checked={(config.enable_tunnel || "1") === "1"}
                onChange={(e) => setConfig({...config, enable_tunnel: e.target.checked ? "1" : "0"})}
              />
              <span className="switch-slider"></span>
            </label>
            <span className="switch-label">
              {(config.enable_tunnel || "1") === "1" ? "已开启" : "已关闭"}
            </span>
          </div>
          <div className="setting-row">
            <label>隧道端口:</label>
            <input
              type="number"
              value={config.tunnel_port || 8003}
              onChange={(e) => setConfig({...config, tunnel_port: parseInt(e.target.value) || 8003})}
              min="1"
              max="65535"
            />
          </div>
          <div className="setting-row full-width">
            <label>隧道域名列表:</label>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                <input
                  type="text"
                  value={newTunnelDomain}
                  onChange={(e) => setNewTunnelDomain(e.target.value)}
                  placeholder="输入域名，例如: example.com"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newTunnelDomain.trim()) {
                      const domains = config.tunnel_domains || [];
                      if (!domains.includes(newTunnelDomain.trim())) {
                        setConfig({...config, tunnel_domains: [...domains, newTunnelDomain.trim()]});
                      }
                      setNewTunnelDomain('');
                    }
                  }}
                  style={{ flex: 1, padding: '10px 14px', border: '1.5px solid var(--input-border)', borderRadius: 'var(--radius-sm)', fontSize: '14px', background: 'var(--input-bg)', color: 'var(--gray-800)' }}
                />
                <button
                  onClick={() => {
                    if (newTunnelDomain.trim()) {
                      const domains = config.tunnel_domains || [];
                      if (!domains.includes(newTunnelDomain.trim())) {
                        setConfig({...config, tunnel_domains: [...domains, newTunnelDomain.trim()]});
                      }
                      setNewTunnelDomain('');
                    }
                  }}
                  className="save-btn"
                  style={{ flex: 'none', width: 'auto', padding: '10px 20px' }}
                >
                  添加
                </button>
              </div>
              {(config.tunnel_domains || []).length > 0 ? (
                <ul className="ip-list">
                  {(config.tunnel_domains || []).map((domain, index) => (
                    <li key={index} className="ip-item" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span>{domain}</span>
                      <button
                        onClick={() => {
                          const domains = config.tunnel_domains || [];
                          setConfig({...config, tunnel_domains: domains.filter((_, i) => i !== index)});
                        }}
                        className="refresh-btn"
                        style={{ flex: 'none', width: 'auto', padding: '4px 12px', fontSize: '12px', marginLeft: '12px' }}
                      >
                        删除
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="empty-hint">暂无隧道域名</p>
              )}
            </div>
          </div>
          <div className="help-text" style={{ marginTop: '-8px', marginBottom: '8px' }}>
            隧道域名列表用于指定哪些域名的流量需要通过反向隧道转发到客户端处理
          </div>
          <div className="setting-row actions">
            <button
              onClick={handleSaveConfig}
              disabled={loading}
              className="save-btn"
            >
              {loading ? '保存中...' : '保存配置'}
            </button>
            <button
              onClick={handleRestartProxy}
              disabled={loading}
              className="restart-btn"
            >
              {loading ? '重启中...' : '重启代理'}
            </button>
          </div>
        </div>
        )}

        {/* 客户端代理设置 */}
        <div className="config-section">
          <h2>客户端代理设置</h2>
          <p>
            <img src="/iphone-proxy-setting.jpg" alt="iPhone Proxy Setting"
                 style={{ float: 'right', marginLeft: '10px', width: '166px' }} />
            <b>代理服务器：</b>
            {serverIPs.length > 0 ? (
              <span>
                {getIpAddress()}
              </span>
            ) : (
              <span>正在获取服务器IP地址...</span>
            )}
            {isDocker && (
              <span> （当前是docker环境，请填写宿主机IP）</span>
            )}
          </p>
          <p>
            <b>HTTP 代理端口：</b><span>{config.proxy_port}</span> &nbsp;<span>开启</span>
          </p>
          <p>
            <b>Socks5{
              (config.socks5_tls || "1") === "1" ? "（Over TLS）" : "（纯 TCP）"
            }代理端口：</b><span>{config.socks5_port}</span> &nbsp;
            <span>{
              config.enable_socks5 === "1" ? "开启" : "关闭"
            }</span>
          </p>
          <p>
            <b>HTTPS MITM 解密：</b>
            <span>{
              (config.enable_mitm || "1") === "1" ? "开启（需安装证书，支持 URL 路径过滤 + 广告重写）" : "关闭（纯隧道转发，不拦截）"
            }</span>
          </p>
          <p>
            <b>用户名</b>：{config.auth_username === "" ? (
              <span>无</span>
            ) : (
              config.auth_username
            )}
          </p>
          <p>
            <b>密码</b>：{config.auth_password === "" ? (
              <span>无</span>
            ) : (
              config.auth_password
            )}
          </p>
          <p>
            <span>
              扫码安装证书：
              <a href={`${window.location.origin}/fetchCrtFile`} target="_blank">下载</a>
            </span><br />
            <canvas id="qrcode"></canvas>
          </p>
          <div>
            <p><b>配置方法</b>：（以Iphone为例）</p>
            <p>设置 → 无线局域网 → 点击当前网络 → HTTP代理/配置代理，设置服务器和端口（图右）</p>
          </div>
          <div>
            <p><b>拦截配置</b>：</p>
            <p>1. 不写 Mac 地址则拦截内网所有设备。</p>
            <p>2. 路径留空则该域名下所有请求都拦截</p>
            <p>3. 路径处写正则表达式</p>
          </div>
          <div>
            <p>
              运维信息：
              <a href={`http://${getIpAddress()}:${config.proxy_port}`} target="_blank">
                {`http://${getIpAddress()}:${config.proxy_port}`}
              </a>
            </p>
          </div>
        </div>

        <div className="config-section">
          <h3>项目源码</h3>
          <div>
            <p>Github 地址：<a href="https://github.com/jayli/block-proxy">Block Proxy</a></p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
/* vim: set filetype=javascriptreact : */
