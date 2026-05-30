---
name: "release-client"
description: "构建并发布 macOS 客户端到 GitHub Release（自动从最新 release 版本号 patch +1）"
user-invocable: true
---

# Skill: Release Client

构建并发布 macOS 客户端到 GitHub Release。支持多架构（arm64 / x86_64），当前机器编译当前架构。

## Instructions

### 1. 获取当前架构和版本信息

- **检测架构**：`uname -m`（x86_64 或 arm64）
  - `x86_64` → zip 名 `SocksClient-macos-x86_64.zip`
  - `arm64` → zip 名 `SocksClient-macos-arm64.zip`

- **获取最新版本号**：
  ```bash
  gh release list --repo jayli/block-proxy --limit 1 --json tagName --jq '.[0].tagName'
  ```
  - 如果没有任何 release，初始版本为 `v0.1.0`
  - 如果有，取 tag（如 `v0.1.2`），将 patch 版本 +1（→ `v0.1.3`）

### 2. 确认发布策略

向用户展示并确认：
- 当前架构
- 新版本号（是否创建新 release，还是追加到已有 release）
- **默认行为**：patch +1 创建新 release。如果用户指定追加到已有 release（如「加到 v0.1.0 里」），则跳过版本号递增和 git 提交，直接编译并上传资产

### 3. 版本号更新（仅新建 release 时）

新版本号记为 `$VERSION`（不含 `v` 前缀）：
- `client/VERSION` → 写入 `$VERSION`
- `client/build.sh` → 替换 `VERSION="..."` 为 `VERSION="$VERSION"`
- `client/app.py` → 替换所有 `版本：v...` 为 `版本：v$VERSION`

### 4. 构建

```bash
bash client/build.sh
```

构建脚本自动检测当前架构，输出对应的 zip 文件。

### 5. 提交并推送（仅新建 release 时）

- `git add client/VERSION client/build.sh client/app.py`
- `git commit -m "release(client): v$VERSION"`
- `git push`

### 6. 创建或更新 GitHub Release

**新建 release**：
```bash
gh release create v$VERSION client/dist/SocksClient-macos-{arch}.zip --title "SocksClient v$VERSION" --notes "SocksClient v$VERSION (macOS {arch})"
```

**追加资产到已有 release**（tag 记为 `$TAG`，如 `v0.1.0`）：
```bash
gh release upload $TAG client/dist/SocksClient-macos-{arch}.zip --repo jayli/block-proxy --clobber
```

### 7. 报告结果

展示 release URL 给用户：`https://github.com/jayli/block-proxy/releases/tag/$VERSION`
