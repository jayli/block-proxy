#!/bin/sh
# init_permissions.sh

# 确保 /tmp 目录下的 anyproxy 相关目录存在
mkdir -p /tmp/anyproxy/cache
mkdir -p /tmp/anyproxy/certificates # 如果证书也需要写入

# 修改 /tmp 目录及其子目录的权限
# 注意：这会修改挂载点的权限，影响宿主机
chmod -R 777 /tmp

# 或者只修改 anyproxy 相关目录
# chmod -R 777 /tmp/anyproxy

# 如果需要，也可以尝试 chown，但这通常需要 root 权限
# su nodeuser -c "mkdir -p /tmp/anyproxy/cache" # 这样可能不行，因为 mkdir 需要父目录权限

echo "Permissions in /tmp adjusted."
