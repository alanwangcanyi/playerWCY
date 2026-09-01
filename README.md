# playerWCY 视频播放器

macOS（Apple Silicon）本地视频播放器：打开文件夹浏览视频清单、记忆每个视频的播放进度、键盘快进快退（按住加速）、0.50-2.00 任意两位小数倍速、空格暂停、界面按钮操作。

- 技术栈：**Tauri 2**（Rust 后端 + 原生 HTML/JS 前端，无框架）

- 数据存储：**SQLite**（rusqlite bundled 静态编译进二进制，随 app 打包，无需系统安装）

- 项目建立日期：2026-09-01

***

## ⚠️ 修改前必读（强制规则）

1. **修改本项目任意内容（代码 / 配置 / 文档）之前，必须先更新本 README 对应章节及** **`docs/CHANGELOG.md`，然后再动代码。**
2. **Log 工作流**：任何更改前先在 `log/当天日期.log`（如 `log/20260901.log`）末尾追加一行 `[时间] 进行：改动内容`；改动完成后将该行改为 `[时间] 完成：改动内容`。当天文件不存在则新建，存在则追加到最后一行。编译归档记录由 `scripts/archive.sh` 自动写入。

## 目录架构

```
playerWCY/
├── README.md                    本文件：总架构说明 + 文档索引（修改前必先更新）
├── docs/                        全部文档（位置固定于此）
│   ├── ARCHITECTURE.md          架构详解：模块职责、数据流、IPC 命令
│   ├── BUILD.md                 编译与归档流程（含环境要求）
│   └── CHANGELOG.md             变更记录（每次修改追加一条）
├── src/                         前端（Web，无框架）
│   ├── index.html               界面结构：侧边栏 + 播放区 + 控制栏
│   ├── css/main.css             全部样式（深色主题）
│   └── js/
│       ├── main.js              入口：组装三个模块
│       ├── sidebar.js           打开文件夹 → 视频清单渲染（名称 + 播放百分比进度条）
│       ├── player.js            播放核心：加载/续播/快进快退/倍速/音量/进度保存
│       └── keyboard.js          键盘：空格暂停、左右键快进快退（按住自动加速）
├── src-tauri/                   Rust 后端
│   ├── Cargo.toml               依赖：tauri 2 / rusqlite(bundled) / tauri-plugin-dialog
│   ├── build.rs                 tauri-build 构建脚本
│   ├── tauri.conf.json          打包配置：窗口、asset 协议、bundle 目标(app/dmg)
│   ├── capabilities/default.json 权限声明（dialog 等）
│   ├── icons/                   应用图标（由 scripts/gen_icons.sh 生成）
│   └── src/
│       ├── main.rs              进程入口
│       ├── lib.rs               应用入口：注册插件、初始化 SQLite、挂载命令、启动音量监听
│       ├── commands.rs          IPC 命令层：scan_folder / save_progress / get_system_volume / set_system_volume
│       ├── folder.rs            文件夹扫描（视频扩展名过滤、排序）
│       ├── db.rs                SQLite 数据层：建表、进度查询、进度保存
│       └── volume.rs            系统音量读写与变化监听（CoreAudio FFI）
├── scripts/
│   ├── gen_icons.sh             生成应用图标（PNG/icns，仅用系统自带工具）
│   └── archive.sh               归档编译产物（编号自增）
├── 20260901-playerWCY-archive/  归档目录：每次编译产物放这里
│   └── 0001-20260901-playerWCY.app   命名 = 四位序号-日期-产品名
├── package.json                 npm 脚本（dev / build / release）
└── .gitignore
```

## 文档索引

| 文档                                           | 内容                     |
| -------------------------------------------- | ---------------------- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 模块职责、数据流、IPC 命令、数据库表结构 |
| [docs/BUILD.md](docs/BUILD.md)               | 环境要求、编译、归档、常见问题        |
| [docs/CHANGELOG.md](docs/CHANGELOG.md)       | 版本变更记录                 |

## 常用命令

```bash
npm install          # 安装依赖（首次）
npm run dev          # 开发模式运行
npm run build        # 编译正式包（.app + .dmg）
npm run release      # 编译 + 自动归档（推荐）
bash scripts/gen_icons.sh   # 重新生成图标（改图标设计时用）
```

## 核心功能与实现位置

| 功能                        | 位置                                                         |
| ------------------------- | ---------------------------------------------------------- |
| 打开文件夹 + 视频清单 + 进度%        | src/js/sidebar.js ↔ src-tauri/src/folder.rs                |
| 播放进度记忆（SQLite）            | src/js/player.js（节流保存）↔ src-tauri/src/db.rs                |
| 左右键快进快退、按住加速              | src/js/keyboard.js（步长档位 5→8→12→20s）                        |
| 倍速 0.50-2.00 两位小数         | src/js/player.js setRate()                                 |
| 空格暂停                      | src/js/keyboard.js                                         |
| 播放模式（列表循环/单集循环/播完暂停/播完下集） | src/js/player.js（ended 处理 + 模式按钮，localStorage 记忆）          |
| 音量条 = 系统音量（双向同步）          | src-tauri/src/volume.rs（CoreAudio 读写/监听）↔ src/js/player.js |
| 倍速记忆（调整后保存）               | src/js/player.js（localStorage，换源后自动重应用）                    |
| 界面操作按钮                    | src/index.html + src/js/player.js                          |

## 数据文件位置

播放进度数据库：`~/Library/Application Support/com.wcy.playerwcy/data.db`（自动创建）

## 开源协议

[MIT License](LICENSE) · Copyright (c) 2026 alanwangcanyi · GitHub: https://github.com/alanwangcanyi/playerWCY

注：归档目录 `20260901-playerWCY-archive/`（编译产物 .app/.dmg 二进制）不入 Git 仓库，仅在本地保留。
