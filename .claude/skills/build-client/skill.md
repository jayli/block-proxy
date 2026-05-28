---
name: "build-client"
description: "构建 macOS 客户端 SocksClient.app（仅本地构建，不升级版本号）"
user-invocable: true
---

# Skill: Build Client

仅本地构建 macOS 客户端，不修改版本号，不发布。

## Instructions

1. 执行构建脚本：
   ```bash
   bash /Users/bachi/jaylli/block-proxy/client/build.sh
   ```

2. 构建完成后，报告结果：
   - 输出路径：`client/dist/SocksClient.app`
   - 告知用户构建是否成功
