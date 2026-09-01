#!/bin/bash
# 归档编译产物：复制 .app/.dmg 到归档目录，命名 = 四位序号-日期-产品名
# 归档目录名固定为项目建立日期-项目名称-archive（20260901-playerWCY-archive）
set -e
cd "$(dirname "$0")/.."

ARCHIVE_DIR="20260901-playerWCY-archive"
APP_SRC="src-tauri/target/release/bundle/macos/playerWCY.app"
NAME="playerWCY"
DATE=$(date +%Y%m%d)

if [ ! -d "$APP_SRC" ]; then
  echo "错误：未找到编译产物 $APP_SRC，请先执行 npm run build"
  exit 1
fi

mkdir -p "$ARCHIVE_DIR"

# 扫描已有归档，取最大四位编号
MAX=0
for f in "$ARCHIVE_DIR"/*; do
  [ -e "$f" ] || continue
  n=$(basename "$f" | cut -c1-4)
  if [[ "$n" =~ ^[0-9]{4}$ ]]; then
    n=$((10#$n))
    [ "$n" -gt "$MAX" ] && MAX=$n
  fi
done
NEXT=$(printf "%04d" $((MAX + 1)))

# 归档 .app
cp -R "$APP_SRC" "$ARCHIVE_DIR/${NEXT}-${DATE}-${NAME}.app"
echo "已归档 app: ${NEXT}-${DATE}-${NAME}.app"

# 归档 .dmg（存在则一并保存）
DMG_SRC=$(ls -t src-tauri/target/release/bundle/dmg/*.dmg 2>/dev/null | head -1 || true)
if [ -n "$DMG_SRC" ]; then
  cp "$DMG_SRC" "$ARCHIVE_DIR/${NEXT}-${DATE}-${NAME}.dmg"
  echo "已归档 dmg: ${NEXT}-${DATE}-${NAME}.dmg"
fi

# 自动写入当天开发日志（log/YYYYMMDD.log，追加一行）
LOG_DIR="log"
LOG_FILE="$LOG_DIR/$(date +%Y%m%d).log"
mkdir -p "$LOG_DIR"
DMG_TAG=""
[ -n "$DMG_SRC" ] && DMG_TAG="+dmg"
echo "[$(date +%H:%M)] 完成：编译归档 ${NEXT}-${DATE}-${NAME}（app${DMG_TAG}）" >> "$LOG_FILE"
