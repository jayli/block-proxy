// 示例：使用 proper-lockfile 进行写入
const fs = require('fs').promises;
const path = require('path');
const lockfile = require('proper-lockfile');
const CONFIG_FILE_PATH = path.join(__dirname, '../config.json');

// 传入的是对象
async function writeConfig(newData) {
  let releaseLock = null;
  try {
    // 获取排他锁
    releaseLock = await lockfile.lock(CONFIG_FILE_PATH, { retries: 10, realpath: false });
    console.log('Write lock acquired');

    // 写入文件
    await fs.writeFile(CONFIG_FILE_PATH, JSON.stringify(newData, null, 2), 'utf8');
    console.log('Config file written successfully');

  } catch (error) {
    if (error.code === 'ELOCKED') {
      console.error('Config file is locked by another process.');
    } else {
      console.error('Error writing config file:', error.message);
    }
    throw error;
  } finally {
    if (releaseLock) {
      try {
        await releaseLock(); // 释放锁
        console.log('Write lock released');
      } catch (unlockError) {
        console.error('Error releasing write lock:', unlockError.message);
      }
    }
  }
}

// 示例：使用 proper-lockfile 进行读取
// 返回的是对象
async function readConfig() {
  let releaseLock = null;
  try {
    // 获取排他锁 (对于配置文件，读取时也获取排他锁可以防止读取过程中被写入中断)
    releaseLock = await lockfile.lock(CONFIG_FILE_PATH, { retries: 10, realpath: false });
    console.log('Read lock acquired');

    const data = await fs.readFile(CONFIG_FILE_PATH, 'utf8');
    const config = JSON.parse(data);
    console.log('Config file read successfully');
    return config;

  } catch (error) {
    if (error.code === 'ELOCKED') {
      console.error('Config file is locked by another process.');
    } else if (error instanceof SyntaxError) {
      console.error('Error parsing config file JSON:', error.message);
    } else {
      console.error('Error reading config file:', error.message);
    }
    throw error; // 或返回默认配置
  } finally {
    if (releaseLock) {
      try {
        await releaseLock(); // 释放锁
        console.log('Read lock released');
      } catch (unlockError) {
        console.error('Error releasing read lock:', unlockError.message);
      }
    }
  }
}

module.exports = {
  writeConfig,
  readConfig
};
