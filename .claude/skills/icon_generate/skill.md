---
name: "icon_generate"
description: "从新源图替换客户端全部图标（应用图标 + 状态栏图标），自动适配各尺寸和 DPI"
argument-hint: "[source dir, default: client/icons/2/]"
user-invocable: true
---

# Skill: Icon Generate

从新源图全面替换 macOS 客户端 BlockProxyClient 的应用程序图标和状态栏图标。自动分析源图尺寸、适配各输出规格、保持与原图标一致的格式和 DPI。

## 源图约定

新源图默认放在 `client/icons/2/` 目录：

| 源图文件 | 用途 | 说明 |
|----------|------|------|
| `app_icon2.png` | 应用图标 | macOS app 图标原图（任意尺寸，RGBA） |
| `G.png` | 全局代理 | 状态栏 — 全局连接模式 |
| `M.png` | 手动代理 | 状态栏 — 手动代理模式 |
| `off.png` | 未连接 | 状态栏 — 代理断开 |

若用户指定了不同的源图目录或文件，按用户提供的路径为准。

## Instructions

### 1. 分析源图

读取每张源图，分析：
- 尺寸 (`width × height`)
- 模式 (`RGBA` 或其他)
- 内容边界框 (content bbox, 即非透明像素的最小包围矩形)
- 宽高比 (`aspect ratio`)

```bash
python3 << 'PYEOF'
from PIL import Image
import os

os.chdir('/Users/bachi/jaylli/block-proxy')
SRC_DIR = 'client/icons/2'

for name in ['app_icon2', 'G', 'M', 'off']:
    path = f'{SRC_DIR}/{name}.png'
    img = Image.open(path)
    print(f"{name}.png: {img.size}, mode: {img.mode}")
    pixels = img.load()
    w, h = img.size
    if img.mode == 'RGBA':
        rows = [y for y in range(h) for x in range(w) if pixels[x,y][3] > 0]
        cols = [x for x in range(w) for y in range(h) if pixels[x,y][3] > 0]
        if rows and cols:
            top, bottom = min(rows), max(rows)
            left, right = min(cols), max(cols)
            cw = right - left + 1
            ch = bottom - top + 1
            print(f"  content: {cw}x{ch}, aspect: {cw/ch:.4f}")
    print()
PYEOF
```

### 2. 生成应用图标

从 `app_icon2.png` 生成三个文件：

| 输出 | 规格 | 生成方式 |
|------|------|---------|
| `app_icon.png` | 1254×1254 RGBA | 源图保持原始分辨率，居中放入 1254×1254 透明画布（保留 padding，与旧版一致） |
| `app_example.png` | 512×516 RGBA | 取内容区 padding 为正方形 → LANCZOS 缩放至 512×516 |
| `app.icns` | 1024×1024 @144 DPI | 用 `sips` + `iconutil` 从 app_icon.png 生成 |

步骤：
1. `app_icon.png`：源图保持原始尺寸，直接居中放入 1254×1254 透明画布，不缩放（旧版 content 992×1009，padding L=131 R=131 T=122 B=123）
2. `app_example.png`：从源图裁剪内容边界框 → 放入正方形画布（以较长边为准，居中）→ LANCZOS 缩放至 512×516
3. 先备份旧的 `app.icns`，用以下脚本重新生成：

```bash
ICONSET=$(mktemp -d)/app.iconset
mkdir -p "$ICONSET"
sips -z 16 16   client/icons/app_icon.png --out "$ICONSET/icon_16x16.png"
sips -z 32 32   client/icons/app_icon.png --out "$ICONSET/icon_16x16@2x.png"
sips -z 32 32   client/icons/app_icon.png --out "$ICONSET/icon_32x32.png"
sips -z 64 64   client/icons/app_icon.png --out "$ICONSET/icon_32x32@2x.png"
sips -z 128 128 client/icons/app_icon.png --out "$ICONSET/icon_128x128.png"
sips -z 256 256 client/icons/app_icon.png --out "$ICONSET/icon_128x128@2x.png"
sips -z 256 256 client/icons/app_icon.png --out "$ICONSET/icon_256x256.png"
sips -z 512 512 client/icons/app_icon.png --out "$ICONSET/icon_256x256@2x.png"
sips -z 512 512 client/icons/app_icon.png --out "$ICONSET/icon_512x512.png"
sips -z 1024 1024 client/icons/app_icon.png --out "$ICONSET/icon_512x512@2x.png"
iconutil -c icns "$ICONSET" -o client/icons/app.icns
rm -rf "$(dirname "$ICONSET")"
```

### 3. 生成状态栏图标

从 `G.png`、`M.png`、`off.png` 各生成 2 个文件：

| 源图 | 552×552 源 PNG | 44×44 Bar PNG |
|------|---------------|---------------|
| `G.png` | `socks_on_G.png` | `socks_on_G_bar.png` |
| `M.png` | `socks_on_M.png` | `socks_on_M_bar.png` |
| `off.png` | `christmas-sock_light.png` | `christmas-sock_light_bar_off.png` |

此外 `christmas-sock_light_bar.png`（不带 `_off`）作为 `bar_off` 的同名拷贝保留兼容。

关键约束：
- Bar 图标内容区高度不超过 **38px**（容器 44px），确保不溢出状态栏
- Bar 图标 DPI 设为 **144×144**，与原图标完全一致
- 源图保持长宽比缩放，居中放入方形容器
- 最终验证：bar 图标顶部/底部边缘不应有非透明像素

```bash
python3 << 'PYEOF'
from PIL import Image
import os, shutil

os.chdir('/Users/bachi/jaylli/block-proxy')

MAPPING = {
    'G':   {'source': 'socks_on_G.png',              'bar': 'socks_on_G_bar.png'},
    'M':   {'source': 'socks_on_M.png',              'bar': 'socks_on_M_bar.png'},
    'off': {'source': 'christmas-sock_light.png',    'bar': 'christmas-sock_light_bar_off.png'},
}

for src_name, targets in MAPPING.items():
    src = Image.open(f'client/icons/2/{src_name}.png').convert('RGBA')
    sw, sh = src.size

    # 552x552 source: scale to fit height
    scale_552 = 552 / sh
    new_w = int(sw * scale_552)
    scaled = src.resize((new_w, 552), Image.LANCZOS)
    canvas_552 = Image.new('RGBA', (552, 552), (0, 0, 0, 0))
    canvas_552.paste(scaled, ((552 - new_w) // 2, 0), scaled)
    canvas_552.save(f'client/icons/{targets["source"]}')
    print(f"{targets['source']}: 552x552")

    # 44x44 bar: content max 38px height
    bar_content_h = 38
    scale_bar = bar_content_h / sh
    bar_w = int(sw * scale_bar)
    bar_h = bar_content_h
    scaled_bar = src.resize((bar_w, bar_h), Image.LANCZOS)
    canvas_bar = Image.new('RGBA', (44, 44), (0, 0, 0, 0))
    canvas_bar.paste(scaled_bar, ((44 - bar_w) // 2, (44 - bar_h) // 2), scaled_bar)
    canvas_bar.save(f'client/icons/{targets["bar"]}', dpi=(144, 144))
    print(f"{targets['bar']}: 44x44 @144 DPI (content {bar_w}x{bar_h})")

    # Verify no content on edges
    px = canvas_bar.load()
    top_ok = not any(px[x, 0][3] > 0 for x in range(44))
    bot_ok = not any(px[x, 43][3] > 0 for x in range(44))
    assert top_ok and bot_ok, f"ERROR: {targets['bar']} content overflows status bar edge!"

shutil.copy('client/icons/christmas-sock_light_bar_off.png',
            'client/icons/christmas-sock_light_bar.png')

print("\nAll status bar icons done.")
PYEOF
```

### 4. 验证

确认所有生成文件符合规格：

```bash
python3 << 'PYEOF'
from PIL import Image
import os

os.chdir('/Users/bachi/jaylli/block-proxy')

checks = [
    ('app_icon.png', 1254, 1254),
    ('app_example.png', 512, 516),
    ('socks_on_G.png', 552, 552),
    ('socks_on_M.png', 552, 552),
    ('christmas-sock_light.png', 552, 552),
    ('socks_on_G_bar.png', 44, 44),
    ('socks_on_M_bar.png', 44, 44),
    ('christmas-sock_light_bar_off.png', 44, 44),
    ('christmas-sock_light_bar.png', 44, 44),
]

all_ok = True
for fname, ew, eh in checks:
    img = Image.open(f'client/icons/{fname}')
    w, h = img.size
    ok = w == ew and h == eh
    dpi = img.info.get('dpi')
    dpi_str = f"@ {dpi[0]:.0f} DPI" if dpi else ""
    print(f"  {'✓' if ok else '✗'} {fname}: {w}x{h} {dpi_str}")
    if not ok:
        all_ok = False
        print(f"    EXPECTED: {ew}x{eh}")

# Verify bar DPI
for name in ['socks_on_G_bar', 'socks_on_M_bar', 'christmas-sock_light_bar_off', 'christmas-sock_light_bar']:
    dpi = Image.open(f'client/icons/{name}.png').info.get('dpi')
    ok = dpi and abs(round(dpi[0]) - 144) <= 1
    print(f"  {'✓' if ok else '✗'} {name}.png DPI: {round(dpi[0]) if dpi else 'MISSING'} (expect 144)")

# Verify app.icns
import os as _os
size = _os.path.getsize('client/icons/app.icns')
print(f"  {'✓' if size > 500000 else '✗'} app.icns: {size:,} bytes (expect >500KB)")

print("\nALL OK" if all_ok else "\nFAILED!")
PYEOF
```

### 5. 报告

列出：
- 每张生成文件的名称、尺寸、DPI
- bar 图标内容区尺寸（宽×高，确认不溢出）
- app.icns 文件大小

## 注意事项

- 应用图标变更后需执行 `bash client/build.sh` 重新构建 .app
- Bar 图标直接复制到 `client/icons/` 目录，开发模式下运行即生效（无需重新构建）
- 旧的 `app.icns` 在覆盖前会自动备份
- 新源图目录 `client/icons/2/` 不受影响，可保留供后续使用
- 代码引用关系（`client/app.py:127-135`）：
  - 全局连接 → `socks_on_G_bar.png`
  - 手动代理 → `socks_on_M_bar.png`
  - 未连接 → `christmas-sock_light_bar_off.png`

## 相关文件

- `client/app.py` — 状态栏图标引用逻辑
- `client/build.sh` — Nuitka 构建 + `fileicon set` 应用图标
- `client/setup.py` — 打包时包含图标文件
