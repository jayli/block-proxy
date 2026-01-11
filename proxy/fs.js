// proxy/fs.js
const fs = require('fs').promises;
const path = require('path');

const configPath = path.join(__dirname, '../config.json');
const CONFIG_FILE_PATH = configPath;

// 传入的是对象
async function writeConfig(newData) {
  try {
    await fs.writeFile(CONFIG_FILE_PATH, JSON.stringify(newData, null, 2), 'utf8');
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

async function setGlobalConfigFile(configFile) {
  var data = await readConfig();
  data.config_file = configFile;
  await writeConfig(data);
}

async function getGlobalConfigFile() {
  var data = await readConfig();
  if (data.hasOwnProperty("config_file")) {
    return data.config_file;
  } else {
    return null;
  }
}

async function clearGlobalConfigFile() {
  var data = await readConfig();
  if (data.hasOwnProperty("config_file")) {
    delete data.config_file
  }
  await writeConfig(data);
}

module.exports = {
  writeConfig,
  readConfig,
  setGlobalConfigFile,
  getGlobalConfigFile,
  clearGlobalConfigFile
};
