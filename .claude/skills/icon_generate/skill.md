# Skill: Icon Generate

从源图标生成状态栏 bar 图标。将白色区域镂空为透明，缩放并添加 padding 后输出 44x44 @ 144 DPI 的状态栏图标。

## Instructions

1. **镂空白色区域**：
   - 读取 `client/icons/socks_on_M.png` 和 `client/icons/socks_on_G.png`
   - 将白色像素（R>240, G>240, B>240）的 alpha 设为 0（透明）
   - 保存回原文件

2. **生成 bar 图标**：
   - 将镂空后的图片缩放至 38x38（内容区）
   - 放置在 44x44 透明画布中央（四周各 3px padding）
   - 设置 DPI 为 144x144
   - 输出为 `client/icons/socks_on_M_bar.png` 和 `client/icons/socks_on_G_bar.png`

3. **执行脚本**：
   ```bash
   python3 << 'PYEOF'
   from PIL import Image

   for name in ["socks_on_M", "socks_on_G"]:
       img = Image.open(f"client/icons/{name}.png").convert("RGBA")
       pixels = img.load()
       w, h = img.size
       for y in range(h):
           for x in range(w):
               r, g, b, a = pixels[x, y]
               if r > 240 and g > 240 and b > 240:
                   pixels[x, y] = (r, g, b, 0)
       img.save(f"client/icons/{name}.png")
       print(f"{name}.png: 白色已镂空")

       canvas = Image.new("RGBA", (44, 44), (0, 0, 0, 0))
       resized = img.resize((38, 38), Image.LANCZOS)
       canvas.paste(resized, (3, 3), resized)
       canvas.save(f"client/icons/{name}_bar.png", dpi=(144, 144))
       print(f"{name}_bar.png: 44x44 @ 144 DPI")
   PYEOF
   ```

4. **报告结果**：
   - 确认源文件白色已镂空
   - 确认 bar 图标尺寸（44x44）和分辨率（144 DPI）
