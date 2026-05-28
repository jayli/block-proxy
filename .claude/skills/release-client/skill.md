---
name: "release-client"
description: "构建并发布 macOS 客户端到 GitHub Release（自动从最新 release 版本号 patch +1）"
user-invocable: true
---

# Skill: Release Client

从 GitHub Release 获取最新版本号，patch +1，构建并发布。

## Instructions

1. **获取最新版本号**：
   ```bash
   gh release list --repo jayli/block-proxy --limit 1 --json tagName --jq '.[0].tagName'
   ```
   - 如果没有任何 release，初始版本为 `v0.1.0`
   - 如果有，取 tag（如 `v0.1.2`），将 patch 版本 +1（→ `v0.1.3`）

2. **确认版本号**：向用户展示即将发布的版本号，等待用户确认后继续

3. **更新版本号到源码**（新版本号记为 `$VERSION`，不含 `v` 前缀）：
   - `client/VERSION` → 写入 `$VERSION`
   - `client/build.sh` → 替换 `VERSION="..."` 为 `VERSION="$VERSION"`
   - `client/app.py` → 替换所有 `版本：v...` 为 `版本：v$VERSION`

4. **构建**：
   ```bash
   bash /Users/bachi/jaylli/block-proxy/client/build.sh
   ```

5. **打包**：
   ```bash
   cd /Users/bachi/jaylli/block-proxy/client/dist && rm -f SocksClient-macos-arm64.zip && zip -r -q SocksClient-macos-arm64.zip SocksClient.app
   ```

6. **提交并推送**：
   - `git add client/VERSION client/build.sh client/app.py`
   - `git commit -m "release(client): v$VERSION"`
   - `git push`

7. **创建 GitHub Release**：
   ```bash
   gh release create v$VERSION /Users/bachi/jaylli/block-proxy/client/dist/SocksClient-macos-arm64.zip --title "SocksClient v$VERSION" --notes "SocksClient v$VERSION (macOS arm64)"
   ```

8. **报告结果**：展示 release URL 给用户
