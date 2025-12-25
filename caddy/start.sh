#!/bin/bash

# 脚本名称: start_caddy.sh
# 功能: 根据操作系统和架构选择并启动 Caddy

# 获取脚本所在目录
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# 定义可执行文件名，使用脚本目录作为前缀
MAC_AMD64_FILE="$SCRIPT_DIR/bin/caddy_darwin_amd64"
LINUX_ARM64_FILE="$SCRIPT_DIR/bin/caddy_linux_arm64"

# 定义配置文件名 (保持不变，或根据需要调整)
CONFIG_FILE="/tmp/Caddyfile"
USERNAME="admin"
# 123456
PASSWORD="\$2a\$14\$TzL7qrw.E4ZZaO7Wz2M.Ye7fB0.L0tN7yqQ2M6t0e1p5u4v3r2s1t"

CONFIG_CONTENT=$(cat <<EOF
:12345 {
    basic_auth {
        $USERNAME $PASSWORD
    }
    reverse_proxy 127.0.0.1:8001
}
EOF
)

# 检查配置文件是否存在
if [ ! -f "$CONFIG_FILE" ]; then
  echo "配置文件 '$CONFIG_FILE' 不存在。"
  echo "$CONFIG_CONTENT" > "$CONFIG_FILE"
fi

# 获取当前操作系统和硬件架构
OS="$(uname -s)"
ARCH="$(uname -m)"

# 根据 OS 和 ARCH 选择可执行文件
EXECUTABLE=""

case $OS in
  Darwin)
    if [ "$ARCH" = "x86_64" ]; then
      EXECUTABLE="$MAC_AMD64_FILE"
    else
      echo "错误: macOS 上不支持的架构: $ARCH (当前脚本仅查找 $MAC_AMD64_FILE)"
      exit 1
    fi
    ;;
  Linux)
    if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
      EXECUTABLE="$LINUX_ARM64_FILE"
    else
      echo "错误: Linux 上不支持的架构: $ARCH (当前脚本仅查找 $LINUX_ARM64_FILE)"
      exit 1
    fi
    ;;
  *)
    echo "错误: 不支持的操作系统: $OS"
    exit 1
    ;;
esac

# 检查选定的可执行文件是否存在
if [ ! -f "$EXECUTABLE" ]; then
  echo "错误: 找不到可执行文件 '$EXECUTABLE'。请确保文件存在且名称正确。"
  exit 1
fi

# 检查可执行文件是否有执行权限，如果没有则添加
if [ ! -x "$EXECUTABLE" ]; then
  echo "警告: '$EXECUTABLE' 没有执行权限，正在添加..."
  chmod +x "$EXECUTABLE"
  if [ $? -ne 0 ]; then
    echo "错误: 无法为 '$EXECUTABLE' 添加执行权限。"
    exit 1
  fi
fi

# 启动 Caddy
echo "检测到平台: $OS $ARCH"
echo "使用配置文件: $CONFIG_FILE"
echo "启动 Caddy..."
echo "$CONFIG_FILE"
cat $CONFIG_FILE
exec "$EXECUTABLE" run --config "$CONFIG_FILE"

# 如果 exec 失败，脚本会继续到这里
echo "Caddy 启动失败或意外退出。"
exit 1
