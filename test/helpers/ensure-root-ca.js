// 测试辅助：确保 cert/rootCA.* 存在。
// 根证书已改为服务器本地生成、不随代码提交（见 .gitignore），
// 因此全新克隆的仓库里不会有这两个文件。调用本函数可在测试前补齐，
// 生成逻辑与运行时完全一致（复用 cert/generator.js）。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const GENERATOR_PATH = path.join(__dirname, '../../cert/generator.js');
const ROOT_CA_KEY_PATH = path.join(__dirname, '../../cert/rootCA.key');
const ROOT_CA_CRT_PATH = path.join(__dirname, '../../cert/rootCA.crt');

// 同步等待：部分测试在模块顶层直接 readFileSync，无法 await。
function ensureTestRootCA() {
  if (fs.existsSync(ROOT_CA_KEY_PATH) && fs.existsSync(ROOT_CA_CRT_PATH)) {
    return { generated: false, keyPath: ROOT_CA_KEY_PATH, certPath: ROOT_CA_CRT_PATH };
  }

  execFileSync(process.execPath, [GENERATOR_PATH], { stdio: 'inherit' });

  if (!fs.existsSync(ROOT_CA_KEY_PATH) || !fs.existsSync(ROOT_CA_CRT_PATH)) {
    throw new Error('无法准备测试用根证书，请检查 cert/generator.js');
  }

  return { generated: true, keyPath: ROOT_CA_KEY_PATH, certPath: ROOT_CA_CRT_PATH };
}

module.exports = {
  ensureTestRootCA,
  ROOT_CA_KEY_PATH,
  ROOT_CA_CRT_PATH
};
