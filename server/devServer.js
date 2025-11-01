// devServer.js
const http = require('http');
const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const LocalProxy = require('../proxy/proxy');

module.exports = {
  devServer: (devServerConfig, { env, paths, proxy, allowedHost }) => {
    // recorderManager.updateAll();

    // 添加自定义代理中间件，模拟Rust中的实现
    devServerConfig.onBeforeSetupMiddleware = (devServer) => {

      function extractTrailingHttpUrl(str) {
        const regex = /\/proxy\/(http|https):\/\/.+$/;
        const match = str.match(regex);
        if (!match) {
          return null;
        } else {
          const mixed_url = match[0];
          const url = mixed_url.replace(/^\/proxy\//,'');
          return url;
        }
      }

      // post
      // {name:xx, url:xx}
      devServer.app.use('/start_recorder', async (req, res) => {
        // 获取POST请求体中的数据
        let body = '';
        req.on('data', chunk => {
          body += chunk.toString();
        });
        req.on('end', () => {
          try {
            // 解析请求体中的JSON数据
            const data = JSON.parse(body);
            const name = data.name;
            const url = data.url;
            recorderManager.startRecorder(name, url);
            res.status(200).json({ ok: '摄像头开始录制' });
          } catch (err) {
            console.log(err);
            res.status(400).json({ error: err.message });
          }
        });
      });

      devServer.app.use('/hello', async (req, res) => {
        LocalProxy.start();
        res.status(200).json({ ok: 'hello' });
      });

 

      // post /proxy/https://www.baidu.com/...
      devServer.app.use('/proxy/*', async (req, res) => {
        try {
          // 提取目标URL，移除'/proxy/'前缀
          const targetUrl = extractTrailingHttpUrl(req.originalUrl);

          // 解析URL以确定使用哪个HTTP模块
          const parsedUrl = new URL(targetUrl);
          const httpClient = parsedUrl.protocol === 'https:' ? https : http;

          // 准备代理请求选项
          const proxyOptions = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: req.method,
            headers: { ...req.headers }
          };

          // 移除不应该转发的头部
          delete proxyOptions.headers['host'];
          delete proxyOptions.headers['connection'];

          // 创建代理请求
          const proxyReq = httpClient.request(proxyOptions, (proxyRes) => {
            // 转发状态码
            res.status(proxyRes.statusCode);

            // 转发头部（除了content-length会自动设置）
            Object.keys(proxyRes.headers).forEach(key => {
              if (key.toLowerCase() !== 'content-length') {
                res.setHeader(key, proxyRes.headers[key]);
              }
            });

            // 管道传输响应数据
            proxyRes.pipe(res);
          });

          // 处理代理请求错误
          proxyReq.on('error', (err) => {
            res.status(502).json({ error: `代理错误: ${err.message}` });
          });

          // 如果有请求体则转发
          if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
            req.pipe(proxyReq);
          } else {
            proxyReq.end();
          }
        } catch (error) {
          res.status(502).json({ error: `代理错误: ${error.message}` });
        }
      });
    };

    return devServerConfig;
  },

};
