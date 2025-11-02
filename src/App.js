// src/App.js
import React, { useState, useEffect } from 'react';
import './App.css';

function App() {
  const [config, setConfig] = useState({
    block_hosts: [],
    proxy_port: 8001,
    web_interface_port: 8002
  });
  
  const [newHost, setNewHost] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [messageType, setMessageType] = useState(''); // success, error, info

  // 组件加载时获取当前配置
  useEffect(() => {
    fetchConfig();
  }, []);

  const fetchConfig = async () => {
    try {
      const response = await fetch('/api/config');
      if (response.ok) {
        const data = await response.json();
        setConfig(data);
      } else {
        showMessage('获取配置失败', 'error');
      }
    } catch (error) {
      showMessage('网络错误: ' + error.message, 'error');
    }
  };

  const showMessage = (text, type) => {
    setMessage(text);
    setMessageType(type);
    setTimeout(() => {
      setMessage('');
      setMessageType('');
    }, 3000);
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
        showMessage('配置保存成功!', 'success');
      } else {
        const errorData = await response.json();
        showMessage('保存配置失败: ' + errorData.error, 'error');
      }
    } catch (error) {
      showMessage('网络错误: ' + error.message, 'error');
    }
    setLoading(false);
  };

  const handleRestartProxy = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/restart', {
        method: 'POST'
      });
      
      if (response.ok) {
        showMessage('代理服务器重启成功!', 'success');
      } else {
        const errorData = await response.json();
        showMessage('重启失败: ' + errorData.error, 'error');
      }
    } catch (error) {
      showMessage('网络错误: ' + error.message, 'error');
    }
    setLoading(false);
  };

  return (
    <div className="App">
      <div className="config-container">
        <h1>代理服务器配置</h1>
        
        {message && (
          <div className={`message ${messageType}`}>
            {message}
          </div>
        )}
        
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
              onChange={(e) => setConfig({...config, proxy_port: parseInt(e.target.value) || 8001})}
            />
          </div>
          
          <div className="setting-row">
            <label>Web界面端口:</label>
            <input
              type="number"
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
      </div>
    </div>
  );
}

export default App;
