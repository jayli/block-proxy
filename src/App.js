// src/App.js
import React, { useState, useEffect } from 'react';
import './App.css';

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

function App() {
  const [config, setConfig] = useState({
    block_hosts: [],
    proxy_port: 8001,
    web_interface_port: 8002
  });
  
  const [newHost, setNewHost] = useState('');
  const [timezone, setTimeZone] = useState('');
  const [newMatchRule, setNewMatchRule] = useState('');
  const [newStartTime, setNewStartTime] = useState('00:00');
  const [newEndTime, setNewEndTime] = useState('23:59');
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState({ message: '', type: '' });
  const [toastTimer, setToastTimer] = useState(null);
  const [serverIPs, setServerIPs] = useState([]);
  const [isDocker, setIsDocker] = useState(false);
  const [hostIPs, setHostIPs] = useState([]);
  const [devices, setDevices] = useState([]);

  // 组件加载时获取当前配置和服务器IP
  useEffect(() => {
    fetchConfig();
    fetchServerIPs();
    fetchTimeZone();
    
    // 清理定时器
    return () => {
      if (toastTimer) {
        clearTimeout(toastTimer);
      }
    };
  }, []);

  const fetchTimeZone = async () => {
    const response = await fetch('/api/timezone');
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
      if (response.ok) {
        const data = await response.json();
        setServerIPs(data.ips);
        setIsDocker(data.docker);
        if (data.hostIPs) {
          setHostIPs(data.hostIPs);
        }
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


  // 在 handleRestartProxy 函数之后添加以下函数：
  const handleUpdateDevices = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/update-devices', {
        method: 'POST'
      });

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
        
        <div className="config-section">
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
                  <span className="host-text"><strong>{getFilterHostDisplay(host)}</strong><br />{getFilterMatchRule(host)}</span>
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
                    <label>~</label>
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
        
        <div className="config-section">
          <h2>端口设置，验证信息，下游 VPN_Proxy 代理</h2>
          {/*<p><span>配置页端口默认 8003</span></p> */}
          <div className="setting-row">
            <label>Anyproxy 代理端口:</label>
            <input
              type="number"
              value={config.proxy_port}
              onChange={(e) => setConfig({...config, proxy_port: parseInt(e.target.value) || 8001})}
            />
          </div>
          
          <div className="setting-row">
            <label>Anyproxy 监控端口:</label>
            <input
              type="number"
              value={config.web_interface_port}
              onChange={(e) => setConfig({...config, web_interface_port: parseInt(e.target.value) || 8002})}
            />
          </div>

          <div className="setting-row">
            <label>代理用户名:</label>
            <input
              type="string"
              value={config.auth_username}
              onChange={(e) => setConfig({...config, auth_username: e.target.value || ""})}
            />
          </div>
          <div className="setting-row">
            <label>代理密码:&nbsp;&nbsp;&nbsp;&nbsp;</label>
            <input
              type="string"
              value={config.auth_password}
              onChange={(e) => setConfig({...config, auth_password: e.target.value || ""})}
            />
          </div>

          <div className="setting-row">
            <label>公网域名:</label>
            <div>如果要公网可访问，OpenWRT 配置相同的端口转发到 AnyProxy 代理端口，这里写公网域名<br />（仅在浏览器通过公网域名+端口查看系统水位时防止回环）</div>
            <input
              type="text"
              value={config.your_domain}
              onChange={(e) => setConfig({...config, your_domain: e.target.value || ""})}
            />
          </div>

          <div className="setting-row">
            <label>VPN_PROXY 设置（格式：“127.0.0.1:1087”，仅调试用）:</label>
            <input
              type="text"
              value={config.vpn_proxy}
              onChange={(e) => setConfig({...config, vpn_proxy: e.target.value || ""})}
            />
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
              onClick={handleUpdateDevices} 
              disabled={loading}
              className="restart-btn"
              style={{ backgroundColor: '#17a2b8', color: 'white' }}
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
        
        <div className="config-section">
          <h2>代理设置</h2>
          <p>
            <img src="/iphone-proxy-setting.jpg" alt="iPhone Proxy Setting"
                 style={{ float: 'right', marginLeft: '10px', width: '166px' }} />
            <b>服务器：</b>
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
            <b>端口：</b><span>{config.proxy_port}</span>
          </p>
          <p>
            <b>监控地址：</b>
            {serverIPs.length > 0 ? (
              <span>
                <a href={`http://${getIpAddress()}:${config.web_interface_port}`} target="_blank" rel="noopener noreferrer">
                  监控地址
                </a>
              </span>
            ) : (
              <span>正在获取服务器IP地址...</span>
            )}
          </p>
          <div>
            <p><b>配置方法</b>：（以Iphone为例）</p>
            <p>设置 → 无线局域网 → 点击当前网络 → HTTP代理/配置代理，设置服务器和端口（图右）</p>
          </div>
          <div>
            <p><b>拦截配置</b>：</p>
            <p>1. 不写 Mac 地址则拦截内网所有设备。</p>
            <p>2. 路径留空则该域名下所有请求都拦截</p>
            <p>3. 路径处可以写部分匹配</p>
          </div>
        </div>

        <div className="config-section">
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
            <p>暂无设备信息</p>
          )}
          <button 
            onClick={fetchConfig} 
            disabled={loading}
            style={{ marginTop: '10px' }}
          >
            {loading ? '刷新中...' : '更新路由表'}
          </button>
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
