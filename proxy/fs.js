// proxy/fs.js
const fs = require('fs').promises;
const path = require('path');

const configPath = path.join(__dirname, '../config.json');
const CONFIG_FILE_PATH = configPath;
const BACKUP_FILE_PATH = path.join(__dirname, '../config_backup.json');

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

async function backupConfig(newData) {
  try {
    await fs.writeFile(BACKUP_FILE_PATH, JSON.stringify(newData, null, 2), 'utf8');
  } catch (error) {
    console.error('Error writing backup config file:', error.message);
  }
}

// 示例：读取配置
// 返回的是对象
async function readConfig() {
  try {
    const data = await fs.readFile(CONFIG_FILE_PATH, 'utf8');
    const config = JSON.parse(data);

    // 第一次运行：如果备份不存在，则生成一个
    try {
      await fs.access(BACKUP_FILE_PATH);
    } catch (e) {
      await backupConfig(config);
    }

    return config;
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.error('Config file does not exist.');
      return {}; // 或返回一个默认配置对象
    } else if (error instanceof SyntaxError) {
      console.error('Error parsing config file JSON, attempting to restore from backup:', error.message);
      try {
        const backupData = await fs.readFile(BACKUP_FILE_PATH, 'utf8');
        const config = JSON.parse(backupData);
        // 自动恢复主配置文件
        await writeConfig(config);
        return config;
      } catch (backupError) {
        console.error('Backup file also failed:', backupError.message);
        throw error;
      }
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
  backupConfig,
  setGlobalConfigFile,
  getGlobalConfigFile,
  clearGlobalConfigFile
};
