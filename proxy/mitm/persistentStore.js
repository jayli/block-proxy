const fs = require('fs');
const path = require('path');

// 存储文件路径（可自定义）
const STORE_PATH = path.join(__dirname, './persistentStore.json');

// 确保存储文件存在
if (!fs.existsSync(STORE_PATH)) {
  fs.writeFileSync(STORE_PATH, '{}');
}

function read(key) {
  const data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  return data[key] || null;
}

function write(value, key) {
  const data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  data[key] = value;
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2));
}

function remove(key) {
  const data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  delete data[key];
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2));
}

module.exports = {
  read,
  write,
  remove
};
