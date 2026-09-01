#!/bin/bash
# 生成应用图标：纯 Python 生成 1024px PNG → sips 缩放 → iconutil 打包 icns
# 仅使用 macOS 自带工具，无需额外依赖
set -e
cd "$(dirname "$0")/../src-tauri"
mkdir -p icons
cd icons

# 1) 生成 1024x1024 原图（深色底 + 紫色播放三角）
python3 - <<'PYEOF'
import struct, zlib

W = H = 1024
BG = (0x1d, 0x1d, 0x26)   # 与应用面板同色
FG = (0x6f, 0x6f, 0xff)   # 品牌紫

def in_tri(x, y):
    """播放按钮三角形：底边 x=400(y 340~684)，顶点 (624, 512)"""
    if x < 400 or x > 624:
        return False
    t = (x - 400) / 224.0
    return 340 + t * 172 <= y <= 684 - t * 172

rows = []
for y in range(H):
    row = bytearray(b'\x00')
    for x in range(W):
        c = FG if in_tri(x, y) else BG
        row += bytes((c[0], c[1], c[2], 0xFF))  # RGBA
    rows.append(bytes(row))
raw = b''.join(rows)

def chunk(t, d):
    c = struct.pack('>I', len(d)) + t + d
    return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)

# color type 6 = RGBA（Tauri 要求图标必须带 alpha 通道）
png = (b'\x89PNG\r\n\x1a\n'
       + chunk(b'IHDR', struct.pack('>IIBBBBB', W, H, 8, 6, 0, 0, 0))
       + chunk(b'IDAT', zlib.compress(raw, 9))
       + chunk(b'IEND', b''))
open('icon.png', 'wb').write(png)
print('icon.png 生成完成')
PYEOF

# 2) 组装 iconset 各尺寸
mkdir -p icon.iconset
for s in 16 32 128 256 512; do
  sips -z $s $s icon.png --out "icon.iconset/icon_${s}x${s}.png" >/dev/null
done
sips -z 32 32   icon.png --out icon.iconset/icon_16x16@2x.png  >/dev/null
sips -z 64 64   icon.png --out icon.iconset/icon_32x32@2x.png  >/dev/null
sips -z 256 256 icon.png --out icon.iconset/icon_128x128@2x.png >/dev/null
sips -z 512 512 icon.png --out icon.iconset/icon_256x256@2x.png >/dev/null
cp icon.png icon.iconset/icon_512x512@2x.png

# 3) 生成 icns（macOS 系统自动套用圆角遮罩）
iconutil -c icns icon.iconset -o icon.icns
rm -rf icon.iconset

# 4) tauri.conf.json 引用的散图
sips -z 32 32   icon.png --out 32x32.png        >/dev/null
sips -z 128 128 icon.png --out 128x128.png      >/dev/null
sips -z 256 256 icon.png --out 128x128@2x.png   >/dev/null

echo "图标全部生成完毕：icon.png / icon.icns / 32x32.png / 128x128.png / 128x128@2x.png"
