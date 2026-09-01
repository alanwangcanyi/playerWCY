#!/bin/bash
# 生成应用图标：Python 以 2048 超采样渲染（白底 + 黑色圆角边框 + 黑色线条播放三角）
# 再用 sips 缩小得到平滑边线，iconutil 打包 icns；仅用系统自带工具
set -e
cd "$(dirname "$0")/../src-tauri"
mkdir -p icons
cd icons

# 1) 2048x2048 超采样渲染（sips 缩小时自带平滑，等效抗锯齿）
python3 - <<'PYEOF'
import struct, zlib

S = 2048                 # 超采样边长
BLACK = (17, 17, 17)     # 线条黑
WHITE = (255, 255, 255)  # 底色/填充白

# --- 圆角矩形边框参数（框带 = 距圆角矩形边界 |sd| <= HALF_W）---
INSET = 180              # 距画布边缘
RADIUS = 340             # 圆角半径
HALF_W = 44              # 边框线半宽（线宽 88）

# --- 播放三角（黑色描边、白色填充 => 只需画三条黑色边线带）---
P1, P2, P3 = (800, 640), (800, 1408), (1450, 1024)
EDGES = [(P1, P2), (P1, P3), (P2, P3)]

def seg_dist(px, py, a, b):
    """点到线段距离"""
    ax, ay = a; bx, by = b
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    cx, cy = ax + t * dx, ay + t * dy
    return ((px - cx) ** 2 + (py - cy) ** 2) ** 0.5

def in_frame_band(px, py):
    """是否落在圆角矩形边框线带内（SDF 判定）"""
    cx = cy = S / 2.0
    hx = hy = S / 2.0 - INSET
    ux, uy = abs(px - cx) - (hx - RADIUS), abs(py - cy) - (hy - RADIUS)
    d = (max(ux, 0.0) ** 2 + max(uy, 0.0) ** 2) ** 0.5 + min(max(ux, uy), 0.0) - RADIUS
    return abs(d) <= HALF_W

def in_tri_edges(px, py):
    """是否落在三角形任一边线带内"""
    return any(seg_dist(px, py, a, b) <= HALF_W for a, b in EDGES)

rows = []
for y in range(S):
    row = bytearray(b'\x00')
    for x in range(S):
        c = BLACK if (in_frame_band(x, y) or in_tri_edges(x, y)) else WHITE
        row += bytes((c[0], c[1], c[2], 0xFF))  # RGBA
    rows.append(bytes(row))
raw = b''.join(rows)

def chunk(t, d):
    cc = struct.pack('>I', len(d)) + t + d
    return cc + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)

png = (b'\x89PNG\r\n\x1a\n'
       + chunk(b'IHDR', struct.pack('>IIBBBBB', S, S, 8, 6, 0, 0, 0))
       + chunk(b'IDAT', zlib.compress(raw, 6))
       + chunk(b'IEND', b''))
open('icon_2048.png', 'wb').write(png)
print('icon_2048.png 渲染完成')
PYEOF

# 2) 缩小到 1024 作为主图（sips 重采样平滑边线）
sips -z 1024 1024 icon_2048.png --out icon.png >/dev/null
rm -f icon_2048.png

# 3) 组装 iconset 各尺寸
mkdir -p icon.iconset
for s in 16 32 128 256 512; do
  sips -z $s $s icon.png --out "icon.iconset/icon_${s}x${s}.png" >/dev/null
done
sips -z 32 32   icon.png --out icon.iconset/icon_16x16@2x.png  >/dev/null
sips -z 64 64   icon.png --out icon.iconset/icon_32x32@2x.png  >/dev/null
sips -z 256 256 icon.png --out icon.iconset/icon_128x128@2x.png >/dev/null
sips -z 512 512 icon.png --out icon.iconset/icon_256x256@2x.png >/dev/null
cp icon.png icon.iconset/icon_512x512@2x.png

# 4) 生成 icns（macOS 系统自动套用圆角遮罩）
iconutil -c icns icon.iconset -o icon.icns
rm -rf icon.iconset

# 5) tauri.conf.json 引用的散图
sips -z 32 32   icon.png --out 32x32.png        >/dev/null
sips -z 128 128 icon.png --out 128x128.png      >/dev/null
sips -z 256 256 icon.png --out 128x128@2x.png   >/dev/null

echo "图标全部生成完毕：icon.png / icon.icns / 32x32.png / 128x128.png / 128x128@2x.png"
