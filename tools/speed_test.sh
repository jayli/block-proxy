#!/usr/bin/env sh

# --- 参数检查 ---
if [ $# -eq 0 ]; then
    echo "用法: $0 <URL> [TARGET_IP]"
    echo "说明: 若提供 TARGET_IP，则绕过 DNS，直连该 IP 并使用 URL 中的域名作为 SNI/Host"
    echo "示例:"
    echo "  $0 https://www.taobao.com"
    echo "  $0 https://www.taobao.com 211.100.8.95"
    exit 1
fi

URL="$1"
TARGET_IP="${2:-}"  # 第二个参数可选
PROXY="socks5://127.0.0.1:1081"
TUNNEL_PID=""
SOCAT_LOG="/tmp/socat_error.log"

# --- 从 URL 提取主机名（用于 --resolve 和 SNI）---
# 移除协议头，再截断路径和端口
HOST=$(echo "$URL" | sed -E 's|^[^:]+://||' | sed -E 's|/.*$||' | sed -E 's/:.*$//')
PORT="443"

cleanup() {
    if [ -n "$TUNNEL_PID" ]; then
        # 检查进程是否存在
        if kill -0 "$TUNNEL_PID" 2>/dev/null; then
            echo "" >&2
            # echo "🛑 正在终止 socat 隧道 (PID: $TUNNEL_PID)..." >&2
            kill "$TUNNEL_PID" 2>/dev/null

            # 等待最多 1 秒让它优雅退出
            i=0
            while kill -0 "$TUNNEL_PID" 2>/dev/null && [ $i -lt 10 ]; do
                sleep 0.1
                i=$((i + 1))
            done

            # 如果还在，强制杀死
            if kill -0 "$TUNNEL_PID" 2>/dev/null; then
                echo "⚠️  强制终止 socat..." >&2
                kill -9 "$TUNNEL_PID" 2>/dev/null
            fi

            # 清理僵尸进程
            wait "$TUNNEL_PID" 2>/dev/null
        fi
    fi
    rm -f "$SOCAT_LOG"
    exit "${1:-0}"
}

trap cleanup EXIT INT TERM

# --- 检查本地端口 1081 是否已被占用 ---
if command -v ss >/dev/null 2>&1; then
    if ss -tuln 2>/dev/null | grep -q ':1081\b'; then
        echo "⚠️  警告: 本地端口 1081 已被占用，socat 可能启动失败。"
    fi
elif command -v netstat >/dev/null 2>&1; then
    if netstat -tuln 2>/dev/null | grep -q ':1081\b'; then
        echo "⚠️  警告: 本地端口 1081 已被占用，socat 可能启动失败。"
    fi
fi

# --- 启动 socat 隧道，并记录错误 ---
echo "🔌 正在启动隧道: socat → OPENSSL:yui.cool:8002 ..."
socat TCP-LISTEN:1081,fork,bind=127.0.0.1 OPENSSL:yui.cool:8002,verify=0 >"$SOCAT_LOG" 2>&1 &
TUNNEL_PID=$!
sleep 0.5

# --- 检查 socat 是否仍在运行 ---
if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    echo "❌ 隧道启动失败！socat 报错如下："
    if [ -s "$SOCAT_LOG" ]; then
        cat "$SOCAT_LOG"
    else
        echo "（无详细错误，可能进程立即崩溃）"
    fi
    exit 1
else
    : > "$SOCAT_LOG"  # 清空日志
fi

# --- 构建 curl 命令 ---
CURL_CMD="curl -k -I --proxy '$PROXY'"

if [ -n "$TARGET_IP" ]; then
    CURL_CMD="$CURL_CMD --resolve '$HOST:$PORT:$TARGET_IP'"
    echo "🌐 绕过 DNS: 直连 $TARGET_IP，SNI = $HOST"
else
    echo "🌐 使用代理解析 DNS（常规模式）"
fi

echo "📡 请求: $URL via $PROXY"

# --- 执行 curl 并计时 ---
FINAL_CMD="$CURL_CMD $URL"

echo "$FINAL_CMD"

{ time_output=$( { time eval "$FINAL_CMD"; } 2>&1 1>&3 ); } 3>&1
exit_code=$?

# --- 提取状态行 ---
status_line=$(printf "%s\n" "$time_output" | head -n 1)

if [ "$exit_code" -eq 0 ]; then
    echo "✅ 响应状态: $status_line"
else
    echo "❌ 请求失败（退出码: $exit_code）"
    [ -n "$status_line" ] && echo "⚠️  部分响应: $status_line"
fi

# --- 显示耗时 ---
real_time=$(printf "%s\n" "$time_output" | grep "^real" | awk '{print $2}')
if [ -n "$real_time" ]; then
    echo "⏱️  耗时: $real_time"
else
    echo "⚠️  无法获取耗时（shell 不支持 time 内置命令的格式）"
fi

