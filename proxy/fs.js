// proxy/fs.js
const fs = require('fs').promises;
const path = require('path');
const writeFileAtomic = require('write-file-atomic'); // 引入 write-file-atomic

const configPath = path.join(__dirname, '../config.json');
const CONFIG_FILE_PATH = configPath;

// 传入的是对象
async function writeConfig(newData) {
  try {
    // 使用 write-file-atomic 进行原子写入
    // 它会在内部创建一个临时文件，写入成功后再重命名为目标文件
    await writeFileAtomic(CONFIG_FILE_PATH, JSON.stringify(newData, null, 2), 'utf8');
    // console.log('Config file written successfully');
  } catch (error) {
    console.error('Error writing config file:', error.message);
    throw error; // 或者根据需要处理错误
  }
}

// 示例：读取配置
// 返回的是对象
async function readConfig() {
  try {
    const data = await fs.readFile(CONFIG_FILE_PATH, 'utf8');
    const config = JSON.parse(data);
    return config;
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.error('Config file does not exist.');
      return {}; // 或返回一个默认配置对象
    } else if (error instanceof SyntaxError) {
      console.error('Error parsing config file JSON:', error.message);
      throw error;
    } else {
      console.error('Error reading config file:', error.message);
      throw error;
    }
  }
}

module.exports = {
  writeConfig,
  readConfig
};
