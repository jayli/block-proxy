// 仅启动本地代理
const { execSync } = require('child_process');
const LocalProxy = require('./proxy');

LocalProxy.start();
