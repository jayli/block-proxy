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
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState({ message: '', type: '' });
  const [toastTimer, setToastTimer] = useState(null);
  const [serverIPs, setServerIPs] = useState([]);
  const [isDocker, setIsDocker] = useState(false);
  const [hostIPs, setHostIPs] = useState([]); // 存储宿主机IP信息

  // 组件加载时获取当前配置和服务器IP
  useEffect(() => {
    fetchConfig();
    fetchServerIPs();
    
    // 清理定时器
    return () => {
      if (toastTimer) {
        clearTimeout(toastTimer);
      }
    };
  }, []);

  const fetchServerIPs = async () => {
    try {
      const response = await fetch('/api/server-ip');
      if (response.ok) {
        const data = await response.json();
        setServerIPs(data.ips);
        setIsDocker(data.docker);
        if (data.hostIPs) {
          setHostIPs(data.hostIPs); // 设置宿主机IP信息
        }
      } else {
        showToast('获取服务器IP失败', 'error');
      }
    } catch (error) {
      showToast('网络错误: ' + error.message, 'error');
    }
  };

  const fetchConfig = async () => {
    try {
      const response = await fetch('/api/config');
      if (response.ok) {
        const data = await response.json();
        setConfig(data);
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

  const handleAddHost = () => {
    if (newHost.trim() && !config.block_hosts.includes(newHost.trim())) {
      const updatedConfig = {
        ...config,
        block_hosts: [...config.block_hosts, newHost.trim()]
      };
      setConfig(updatedConfig);
      setNewHost('');
    }
  };

  const handleRemoveHost = (hostToRemove) => {
    // 添加确认框
    const confirmed = window.confirm(`确定要删除主机 "${hostToRemove}" 吗？`);
    if (confirmed) {
      const updatedConfig = {
        ...config,
        block_hosts: config.block_hosts.filter(host => host !== hostToRemove)
      };
      setConfig(updatedConfig);
    }
  };

  const handleSaveConfig = async () => {
    setLoading(true);
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
      } else {
        const errorData = await response.json();
        showToast('保存配置失败: ' + errorData.error, 'error');
      }
    } catch (error) {
      showToast('网络错误: ' + error.message, 'error');
    }
    setLoading(false);
  };

  const handleRestartProxy = async () => {
    setLoading(true);

    // 先保存配置
    try {
      const response = await fetch('/api/config', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(config)
      });
      
      if (response.ok) {
        showToast('配置同步完成，正在重启中!', 'info');
      } else {
        const errorData = await response.json();
        showToast('保存配置失败: ' + errorData.error, 'error');
        setLoading(false);
        return;
      }
    } catch (error) {
      showToast('网络错误: ' + error.message, 'error');
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
                <p><strong>服务器IP地址:</strong></p>
                <ul className="ip-list">
                  {serverIPs.map((ip, index) => (
                    <li key={index} className="ip-item">
                      <span className="interface-name">{ip.interface}:</span>
                      <span className="ip-address">{ip.address}</span>
                      <span className="docker-info">{isDocker ? ' (Docker环境)' : ' (本地环境)'}</span>
                    </li>
                  ))}
                </ul>
                
                {/* 显示宿主机IP信息 */}
                {isDocker && hostIPs.length > 0 && (
                  <div className="host-ip-info">
                    <p><strong>宿主机IP地址:</strong></p>
                    <ul className="host-ip-list">
                      {hostIPs.map((hostIP, index) => (
                        <li key={index} className="host-ip-item">
                          <span className="method-name">{hostIP.method}:</span>
                          <span className="host-ip-address">{hostIP.ip}</span>
                        </li>
                      ))}
                    </ul>
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
              placeholder="输入要拦截的主机 (例如: example.com)"
              onKeyPress={(e) => e.key === 'Enter' && handleAddHost()}
            />
            <button onClick={handleAddHost}>添加</button>
          </div>
          
          <ul className="host-list">
            {config.block_hosts.map((host, index) => (
              <li key={index} className="host-item">
                <span>{host}</span>
                <button 
                  onClick={() => handleRemoveHost(host)}
                  className="remove-btn"
                >
                  删除
                </button>
              </li>
            ))}
          </ul>
        </div>
        
        <div className="config-section">
          <h2>代理设置</h2>
          <div className="setting-row">
            <label>代理端口:</label>
            <input
              type="number"
              value={config.proxy_port}
              disabled={isDocker}
              onChange={(e) => setConfig({...config, proxy_port: parseInt(e.target.value) || 8001})}
            />
          </div>
          
          <div className="setting-row">
            <label>Web界面端口:</label>
            <input
              type="number"
              disabled={isDocker}
              value={config.web_interface_port}
              onChange={(e) => setConfig({...config, web_interface_port: parseInt(e.target.value) || 8002})}
            />
          </div>
        </div>
        
        <div className="actions">
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
        <div className="config-section">
          <h2>代理设置</h2>
          <p>
            <b>服务器：</b>
            {serverIPs.length > 0 ? (
              <span>
                {getIpAddress()}
              </span>
            ) : (
              <span>正在获取服务器IP地址...</span>
            )}
            {isDocker && (
              <span>当前是docker环境，请填写宿主机IP</span>
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
        </div>
      </div>
    </div>
  );
}

export default App;