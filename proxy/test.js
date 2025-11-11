
const { execSync } = require('child_process');
const LocalProxy = require('./proxy');

execSync('cp ~/jayli/block-proxy/hack-of-anyproxy/lib/requestHandler.js ~/jayli/block-proxy/node_modules/anyproxy/lib/', { encoding: 'utf8' });

LocalProxy.start();
