#!/usr/bin/env sh


# 获取当前脚本所在目录的绝对路径
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# 进入该目录
cd "$SCRIPT_DIR"

# 执行 npm 命令
npm run start
