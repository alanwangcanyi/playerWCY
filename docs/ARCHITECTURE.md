# 架构详解

## 总体结构

```
┌──────────────── 前端 src/（WebView）────────────────┐   ┌──────── Rust 后端 src-tauri/ ────────┐
│ sidebar.js   打开文件夹/清单渲染/进度显示            │   │ commands.rs  IPC 命令入口            │
│ player.js    播放/续播/倍速/快进快退/进度保存触发    │ ←→ │ folder.rs    目录扫描(视频过滤/排序)  │
│ keyboard.js  空格/左右键(按住加速)                  │IPC│ db.rs        SQLite 建表/查询/保存    │
└─────────────────────────────────────────────────────┘   └──────────────┬───────────────────────┘
                                                                        │ rusqlite(bundled)
                                                          ~/Library/Application Support/com.wcy.playerwcy/data.db
```

- 前后端**唯一**通道是 Tauri IPC（`invoke`），共 7 个命令，职责清晰。

- 本地视频通过 Tauri `asset` 协议播放：`convertFileSrc(path)` → `asset://` URL → `<video>` 标签。

- 系统音量通过 Rust 端 CoreAudio 读写与监听（volume.rs）：读写以 VirtualMasterVolume 为主（声道值兜底）；音量监听绑定当前默认设备，并在系统对象上监听默认设备变化，切换设备时互斥锁保护下自动重绑并推送新设备音量。

## IPC 命令

| 命令                  | 参数                                                   | 返回              | 说明                                                                                                 |
| ------------------- | ---------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------- |
| `scan_folder`       | `folder: string`                                     | `VideoItem[]`   | 扫描目录一层内视频文件（mp4/mov/m4v/webm/mkv/avi），按文件名排序；文件夹与新视频入库（INSERT OR IGNORE 不覆盖进度），合并历史进度返回；目录读取失败返回错误 |
| `list_library`      | 无                                                    | `FolderGroup[]` | 启动加载：全部文件夹及其视频记录（纯读 SQLite，不扫磁盘）                                                                   |
| `remove_folder`     | `folder: string`                                     | 无               | 删除文件夹记录（事务级联删其下视频记录；不动磁盘文件）                                                                        |
| `remove_videos`     | `paths: string[]`                                    | 无               | 批量删除视频记录（单事务；不动磁盘文件）                                                                               |
| `save_progress`     | `filePath, fileName, folderPath, position, duration` | 无               | upsert 进度（百分比 clamp 0-100）；`folderPath` 为空时由后端从路径推导父目录                                             |
| `get_system_volume` | 无                                                    | `f32` (0.0-1.0) | 读取默认输出设备音量（VirtualMasterVolume 优先）                                                                 |
| `set_system_volume` | `volume: f64` (0.0-1.0)                              | 无               | 设置默认输出设备音量                                                                                         |

`VideoItem = { file_path, file_name, folder_path, position(秒), duration(秒), percent(0-100) }`
`FolderGroup = { path, name, videos: VideoItem[] }`

## 数据库表

```sql
CREATE TABLE videos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path   TEXT UNIQUE NOT NULL,   -- 绝对路径，唯一标识
    file_name   TEXT NOT NULL,
    folder_path TEXT NOT NULL,          -- 父目录，按文件夹分组依据
    duration    REAL NOT NULL DEFAULT 0,
    position    REAL NOT NULL DEFAULT 0,
    percent     REAL NOT NULL DEFAULT 0,
    updated_at  TEXT NOT NULL
);

CREATE TABLE folders (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    path           TEXT UNIQUE NOT NULL,  -- 文件夹绝对路径
    name           TEXT NOT NULL,         -- 显示名（路径最后一段）
    added_at       TEXT NOT NULL,
    last_opened_at TEXT NOT NULL
);
```

## 关键流程

### 播放身份（activePath）

- 当前播放项的身份是 `file_path`（`ctx.activePath`），不是数组索引

- 列表删除/刷新后 `reload()` 按路径重算 `activeGroup/activeIdx`，防止索引偏移导致高亮错位或"播完下集"切错目标

- 删除正在播放的条目/文件夹时停止进度跟踪（`stopTracking`），防止自动保存把记录写回

### 进度记忆

1. `timeupdate` 事件 → 每 5 秒节流调用 `save_progress`（player.js `save()`，返回 Promise）
2. 暂停 / 播完 / 切换视频 → 立即保存；关闭窗口（`onCloseRequested`）→ `await save(true)` 完成后才销毁窗口，确保最后一次写入落库
3. 再次加载：`position > 3s 且 < 98%` 时自动续播；换源后浏览器会重置进度与倍速，统一在 `loadedmetadata` 事件中应用续播位置与倍速（pendingResume 机制）

### 播放模式（player.js ended 处理）

- 单集循环：`currentTime = 0` 重播本集

- 播完暂停：停住不动

- 播完下集：切下一集，末尾停住

- 列表循环：切下一集，末尾回到第一集

- 模式选择存 localStorage（`pwcy-mode`），默认"播完下集"

### 按住加速（keyboard.js）

- `keydown`（含系统自动重复）→ 节流 120ms 执行一次跳转

- 触发次数每满 4 次升一档：步长 5s → 8s → 12s → 20s 封顶

- `keyup` 重置计数；输入框聚焦时不响应全局快捷键

### 倍速

- 预设按钮 0.5/1/1.5/2，或输入框任意值（校验 0.50-2.00，四舍五入两位小数）→ `video.playbackRate`

## 权限与安全

- `capabilities/default.json`：`core:default` + `dialog:default`（打开文件夹对话框）

- `assetProtocol.scope: ["**"]`：允许读取任意本地视频（用户自选目录不固定，本地单机应用可接受）

- CSP 为 null（本地静态页面，无外部网络请求）

