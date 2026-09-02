# FEATURES 架构审查

审查对象：`docs/FEATURES.md` 与当前代码架构  
审查日期：2026-09-02  
审查范围：前端模块、Rust IPC、SQLite 数据层、CoreAudio 音量监听、窗口生命周期

## 结论

当前架构整体符合 `FEATURES.md` 的产品功能清单，核心模块边界清晰，前后端职责基本匹配。

已通过验证的部分：

- Tauri 2 + Rust + 原生 HTML/CSS/JS，无前端框架
- SQLite `folders` / `videos` 两表持久化，启动时纯读库
- 文件夹扫描、视频入库、分组树、折叠状态记忆、右键删除和多选删除
- 删除记录仅删除数据库记录，不删除磁盘文件；重新打开/导入文件夹时，磁盘中存在的视频会再次被发现并重新添加，这是预期行为
- 播放模式限定在当前文件夹，续播使用 `pendingResume` 并在 `loadedmetadata` 后应用
- 进度节流保存、暂停/切换/关闭窗口保存，关闭窗口等待写入完成
- 系统音量使用 `VirtualMasterVolume`，并监听默认输出设备变化后重绑新设备
- Rust 单元测试 7 项全部通过

## 已确认的架构风险

### 1. 播放身份依赖数组索引

`src/js/main.js` 和 `src/js/sidebar.js` 使用 `activeGroup` / `activeIdx` 表示当前播放项。删除当前项之前的其他视频后，重载列表可能造成索引偏移，进而影响当前高亮和“播完下集”的目标。

建议：以 `file_path` 作为当前播放身份；列表刷新后根据路径重新计算分组和索引。

### 2. 音量监听重绑不是整体原子操作

`src-tauri/src/volume.rs` 使用原子变量保存当前设备 ID，单次读写是线程安全的，但设备 ID 更新、移除旧监听、注册新监听之间仍存在竞态窗口。

建议：使用 mutex 或其他串行化方式保护完整的重绑流程，并检查 `AudioObjectAddPropertyListener` / `AudioObjectRemovePropertyListener` 的返回状态。

### 3. SQLite 删除操作缺少事务边界

删除文件夹时会先删视频再删文件夹，批量删除视频时逐条执行。如果中途发生数据库错误，可能留下部分删除结果。

建议：将级联删除和批量删除放入事务；批量操作可使用预编译语句或单条条件语句。

### 4. 播放失败反馈仍不完整

FEATURES 已知限制提到文件移动、编码不支持等情况，但播放器尚未提供明确的 `error` 状态展示，用户只能看到播放区域无内容或停止。

建议：监听 `<video>` 的 `error` 事件，显示文件路径、失败原因和删除记录入口。

## 文档同步项

`docs/ARCHITECTURE.md` 仍需持续与功能清单同步，尤其是：

- IPC 命令数量和完整列表
- `folders` 表结构
- `VideoItem.folder_path` 字段
- 默认输出设备变化后的音量监听重绑流程

## 验证记录

```text
cargo test
7 passed; 0 failed
```

前端模块已通过 Node.js 语法检查。本文档仅记录审查结果，不改变业务代码。
