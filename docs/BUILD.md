# 编译与归档

## 环境要求

| 工具 | 版本 | 说明 |
|---|---|---|
| Rust | ≥1.77（本机 1.97.1） | `~/.cargo/bin` 需在 PATH |
| Node.js | ≥18（本机 v24） | |
| Xcode Command Line Tools | 任意近期版本 | clang 编译 SQLite bundled 源码 |
| cargo 镜像 | rsproxy.cn | 已配置 `~/.cargo/config.toml`，国内加速 |

## 编译

```bash
export PATH="$HOME/.cargo/bin:$PATH"   # 若 cargo 不在 PATH
npm install                # 首次
npm run dev                # 开发调试（热加载界面代码）
npm run build              # 正式编译，产出：
#   src-tauri/target/release/bundle/macos/playerWCY.app   (aarch64 原生)
#   src-tauri/target/release/bundle/dmg/playerWCY_*.dmg
```

## 归档（规则）

归档目录：`20260901-playerWCY-archive/`（项目建立日期 20260901 + 项目名 playerWCY + -archive）

命名规则：**四位序号-编译日期-产品名**，如 `0001-20260901-playerWCY.app`

```bash
npm run release            # 编译 + 自动归档（编号自动 +1）
# 或手动归档：
bash scripts/archive.sh
```

## 图标

图标由 `scripts/gen_icons.sh` 生成（纯系统工具：python3 + sips + iconutil），修改图标设计后重跑该脚本再编译。

## 常见问题

- **mkv/avi 无法播放**：macOS WebKit 解码能力有限。mp4(H.264)/mov/m4v/webm 支持完好；mkv 内 H.264 多数可播，HEVC/avi 老编码可能黑屏。属系统限制，后续可评估引入 ffmpeg 软解。
- **首次编译慢**：Rust 首次全量编译（含 SQLite 源码）需数分钟，之后增量编译很快。
- **进度数据库位置**：`~/Library/Application Support/com.wcy.playerwcy/data.db`
