# 变更记录

格式：日期 | 版本/编号 | 变更内容 | 影响范围

━━━━━━━━━━━━━━━━━━━━━━━━

2026-09-09 | v1.7.1 / 0033 | 新增：Android 正式播放链路（方案 A） | Android + 前端

- MediaServer.kt：纯 Kotlin 手写本地 HTTP 服务（127.0.0.1:18899），SAF content:// 文档 → video 回环供流，完整 Range/206（start-end/start-/suffix，对齐 Rust media_proto 语义）；零外部依赖（NanoHTTPD 依赖在本环境不进 Kotlin classpath，模块依赖与 libs jar 均失效，已记录）
- 数据链路：SAF 选目录（持久授权）→ 列表存 localStorage（pwcy-android-lib，docId 身份+HTTP 可播 URL）→ 侧栏完整复用（renderList/多选/删除/吸顶/续播进度 localStorage 存储）；启动自动恢复（hasFolder→listSaved）
- 前端平台分支：__PW_ANDROID 标记必须在 initPlayer/initSidebar 之前设置（否则 SAF 回调注册被跳过）；player.js load 走本地 HTTP URL、save 走 localStorage；删除操作走 localStorage 分支
- 排障记录：gradle 配置缓存/Kotlin daemon 均非根因，新增外部依赖始终不进 Kotlin classpath（androidx 正常），最终以零依赖方案绕过；编辑工具出现"报成功实际未写入"的静默丢失，python 断言核验修复
- 验证（CDP 自动化）：侧栏 75 条目恢复、2709 秒视频 readyState=4 正常播放、duration 流式读取成功

2026-09-09 | v1.7.0 / 0031-0032 | 新增：Android 平台首版（探针里程碑） | Rust + 前端 + Android 工程

- 平台：Tauri 2 同一代码库双平台（macOS + Android arm64），真机 Xiaomi 17 Pro Max 验证通过
- 平台隔离：coreaudio-sys 移入 macOS target 专属依赖；volume 模块/Finder 命令/音量 IPC 按平台条件编译（Android 音量走系统媒体流，get 返回占位值、set 空操作；Finder 定位返回不支持提示）
- 前端：播放源改 convertFileSrc(path,'stream') 按平台生成正确协议形式（macOS=stream://localhost/...，Android=http://stream.localhost/...）
- Android 工程：gen/android（AGP 8.11/gradle 8.14.3），Manifest 固定 screenOrientation=landscape（不随重力）；MainActivity 注入 NativeRotate JS 桥，控制栏新增反转按钮（仅 Android 显示，手动切换横屏 0°/180°）
- 图标：cargo tauri icon 从同源 icon.png 生成 Android 全密度 mipmap（与 macOS 图标一致）
- 环境适配记录（构建链路四层问题）：rustup 镜像缺包→手动安装官方 rust-std；NDK/SDK 组件自动安装被沙盒拦→手动解压/Studio 安装（compileSdkVersion=android-36.1、buildTools 35.0.1 显式适配）；gradle 回调 CLI 的 WS 拒连→cargo 安装 Rust 版 tauri-cli + 脱离式后台进程；Rust 库缺 mobile_entry_point 宏→已补（lib.rs cfg_attr(mobile,...)）
- 已知限制（探针阶段）：打开文件夹/文件的系统选择器返回 content:// URI 与真实路径链路不通（SAF 探针待做）；界面为桌面布局未做移动端适配；dmg 打包仍被沙盒拦截
- 无线调试：adb 配对一次后 mDNS 自动重连（10.193.1.237）

2026-09-04 | v1.6.2 / 0029 | 修复：进度条圆点卡死不跟随播放 | 前端

- 现象：进度条紫色圆点长时间停在点击位置不动，视频照常播放，两者偏差越来越大（高倍速下观感更明显，易误判为变速问题）

- 根因：pointerdown 无条件置 seeking=true，但 WKWebView 下点击位置换算值与当前值相同时不派发 change，标志永久不复位，timeupdate 回写被跳过

- 修复：pointerup/pointercancel 无条件复位 seeking（change 仍负责跳转，职责分离）

- 附注：高倍速下圆点本身存在约一个 timeupdate 间隔（约 250ms×倍速）的步进滞后，属采样固有观感非 bug

- 附带：git 历史清理（剔除误入提交的 test/2.mp4 378MB），仓库推送 GitHub 成功

2026-09-04 | v1.6.1 / 0028 | 修复：stream 协议路径解析 / 切视频倍速恢复 | Rust + 前端

- 修复 stream:// 协议绝对路径解析：解码后 `//Users/...` 用 trim\_start\_matches('/') 移除全部前导斜杠得到相对路径，此前仅因 GUI 进程 cwd=/ 碰巧能播（从其他目录启动即 404）；改为 strip\_prefix('/') 只去一个斜杠

- 修复切换视频倍速错误恢复：换源 loadedmetadata 用 currentRate()（读自定义输入框值）恢复，预设 2x 生效中切集会回退成输入框残留的自定义值（如 1.25x）；改为读生效值 pwcy-rate；currentRate() 随之成为死代码已删除

- 文案修正：打开文件按钮及选择器去掉"音频"承诺（链路实际仅支持 6 种视频格式；stream 协议 MIME 表已含音频类型，待后续音频需求决策）

2026-09-04 | v1.6.0 / 0027 | 优化：UI 四项 | 前端

- 入口按钮视觉层级：打开文件夹（主操作，品牌色）与打开文件（次操作，ghost 透明底+边框）并排区分主次，hover 边框转品牌色

- 吸顶条过渡动画：显隐改 max-height/opacity/visibility 过渡（.show class，border-box 下 max-height:0 完全收起不占位），出现/收起平滑淡入

- 单文件徽章区分：单文件组徽章加 file-badge（品牌弱底色+品牌文字），与普通计数徽章明显区分（列表与吸顶条两处）

- 原生 alert/confirm 全部替换为应用内弹窗（新增 dialog.js：Promise 化、Esc/遮罩取消、按钮聚焦键盘可达；样式与整体深色 UI 统一）

- 弹窗打开时全局快捷键（空格/方向键/倍速 1-5）让位（body.dialog-open 标记），空格此时触发聚焦按钮而非控制播放

2026-09-04 | v1.5.2 / 0026 | 修复：组头吸顶不生效 | 前端

- 现象：文件夹视频列表下滚时组头未固定在顶部（CSS position:sticky 在 WKWebView 该布局下未生效）

- 修复：改为 JS 虚拟吸顶——吸顶条作为滚动容器的直接子元素（sticky 最可靠形态），滚动时实时显示当前顶部所属文件夹（名称/数量/展开状态），点击随时收起/展开；真实组头可见时自动隐藏避免重叠

2026-09-04 | v1.5.1 / 0025 | 修复：moov 在尾部的大 MP4 无法播放 | Rust / 新增 media\_proto

- 现象：378MB、moov atom 在文件尾部的 MP4（未 faststart 的下载/录制文件）在软件中无限加载，QuickTime 可正常播放

- 根因：asset 协议不支持 HTTP Range 流式定位，WebKit 必须先读到尾部 moov 才能起播，大文件下失败

- 修复：新增自定义 stream:// 协议（media\_proto.rs），完整实现 Range/206/Content-Range/Accept-Ranges，按 8MB 分块响应（内存安全），suffix range（bytes=-N）支持读取尾部 moov；播放源全部切换到该协议

- 测试：新增 Range 解析三种形态与边界、MIME 映射单测

2026-09-04 | v1.5.0 / 0025 | 新增：组头吸顶 / 自定义倍速解耦 / 单文件入库 | 前端 + Rust

- 组头吸顶：侧栏向下滚动时当前文件夹组头固定在顶部，随时点箭头收起、切换其他文件夹（CSS sticky）

- 自定义倍速解耦：点预设按钮/快捷键 1-4 不再改写自定义输入框，自定义值独立记忆（pwcy-custom-rate），快捷键 5 随时重新应用；生效倍速为预设时按钮高亮，为自定义时输入框高亮

- 单文件入库：①软件内新增"打开文件"按钮（单选视频/音频，独立成组）②（Finder 双击关联声明因当前 tauri 版本不支持复杂 Info.plist 结构暂缓，入口为软件内按钮）；组头显示"单文件"徽章；已在文件夹组的文件移入单文件组且进度保留（事务）；删除右键文案区分

- 数据层：folders 表新增 kind 列（0=文件夹 1=单文件组），旧库自动迁移（ALTER TABLE）；新增 add\_single\_file（事务：folders upsert + videos 归组）；IPC 新增 add\_single\_file 命令；lib.rs 预留 RunEvent::Opened 处理（显示窗口 + emit open-file，待后续 tauri 升级启用 Finder 关联）

- 测试：新增 single\_file\_group（入库/移动/进度保留/去重）

2026-09-03 | v1.4.1 / 0024 | 修复：About 版本号滞后 | 配置

- 根因：v1.0.0 之后迭代只更新 CHANGELOG 版本，漏改三处代码版本号，About 一直显示 1.0.0

- 修复：package.json / tauri.conf.json / Cargo.toml 同步为 1.4.1

- 流程改进：README"修改前必读"新增版本号同步强制规则

2026-09-02 | v1.4.1 / 0023 | 优化：倍速输入框回车确认并失焦 | 前端交互

- 输入倍速后按 Enter：立即生效并让输入框失焦，空格/左右键随即恢复为暂停/快退/快进全局快捷键

- 按 Esc：放弃编辑（恢复显示当前生效倍速）并失焦

- 失焦（点击别处）时仍走 change 逻辑应用输入值（原行为保留）

2026-09-02 | v1.4.0 / 0022 | 新增：倍速快捷键 1-5 + 开关 | 前端界面

- 数字键 1-4 对应预设倍速 0.5/1/1.5/2，数字键 5 应用自定义输入框中的倍速

- 倍速组左侧新增开关（toggle）：开启/关闭快捷键，状态 localStorage 记忆；输入框聚焦时数字键正常输入不触发

- UI：预设按钮与输入框带 kbd 角标显示对应数字；悬停 title 提示快捷键；开关关闭时角标变暗；toggle 滑块动画（受 reduced-motion 降级）

2026-09-02 | v1.3.2 / 0021 | 新增：在 Finder 中显示 | Rust/前端

- 右键视频条目菜单新增"在 Finder 中显示"：调用 macOS open -R 在访达中定位并选中该文件

- 文件不存在时返回错误提示（可能已被移动或删除）

2026-09-02 | v1.3.1 / 0020 | 优化：uicraft 界面系统打磨 | 前端界面

- 修复：--radius-full 变量缺失导致收起按钮圆角失效（显示方角）

- 可达性：全局 :focus-visible 焦点环；prefers-reduced-motion 动画降级

- 层级与状态：播放主按钮品牌化强调；当前播放条目左侧指示条；倍速预设按钮选中态；危险按钮悬停强化

- 细节：侧栏细滚动条；进度条/音量条悬停增粗与 thumb 放大；空状态线条图标；小字号 11→12px；按钮背景过渡；#sidebar 重复规则合并；字体抗锯齿

2026-09-02 | v1.3.0 / 0019 | 修复：总监架构审查四项风险 | 前端/Rust/DB

- 播放身份由数组索引改为 file\_path（activePath）：列表删除/刷新后按路径重算分组索引，防止高亮错位与连播目标偏移

- 音量监听重绑流程加互斥锁串行化，消除设备切换竞态窗口

- SQLite 删除操作事务化：级联删文件夹与批量删视频改为单事务，失败整体回滚

- 新增播放失败反馈：监听 video error 事件，显示文件名与原因（文件不存在/格式不支持等），提示可右键删除记录

- ARCHITECTURE.md 同步：7 个 IPC 命令、folders 表结构、VideoItem.folder\_path、音量重绑流程

2026-09-02 | 文档审查 | 新增：FEATURES 架构审查文档 | 文档

- 新增 `docs/FEATURES_REVIEW.md`，记录产品功能清单与当前代码架构的符合性、已确认语义及后续优化项

- 明确删除记录后重新导入文件夹会重新添加视频，这是预期的刷新语义，不属于缺陷

2026-09-02 | v1.2.0 / 0015 | 新增：侧栏收起/展开按钮 | 前端界面

- 视频区左上角悬浮按钮：点击收起/展开左侧导航（收起后视频区占满），图标随状态切换方向

- 交互：鼠标悬停按钮放大、移开缩小（scale 过渡）；收起状态 localStorage 记忆

2026-09-02 | v1.1.3 / 0014 | 修复：切换输出设备后音量监听失效 | Rust

- 根因：音量监听只绑定启动时的默认输出设备，切换蓝牙耳机/显示器后新设备上无监听

- 修复：在系统对象上监听 kAudioHardwarePropertyDefaultOutputDevice，默认设备变化时自动把音量监听迁到新设备（移旧注册新），并立即推送新设备当前音量

2026-09-02 | v1.1.0 / 0011 | 新增：文件夹历史 + 删除记录 + 分组折叠 | Rust/前端/DB

- 文件夹历史：新增 folders 表（videos 表零改动），打开过的文件夹持久保存，重启后仍在；旧数据自动迁移（从 videos.folder\_path 去重生成）

- 启动纯读 SQLite 记录（不扫磁盘）：文件被移动后记录保留，播放失败时提示可删记录

- 打开文件夹 = 刷新语义：扫描结果入库（新增 INSERT OR IGNORE 不覆盖已有进度），已删除的记录保留

- 删除记录（不删磁盘文件）：右键视频条目删单条；右键组头删整个文件夹（级联删其下视频记录）；悬停勾选框多选（可跨文件夹）+ 底部"删除所选"按钮；均有确认弹窗

- 侧栏改分组树：文件夹组头（名称+数量+折叠箭头）可收起/展开，折叠状态按路径记忆（localStorage）

- 连播范围限定当前文件夹内（播完下集/列表循环均在组内）；ctx 改 groups 结构

2026-09-01 | v1.0.0 / 0010 | 版本号升级 1.0.0（首个正式版） | 全局

- package.json / tauri.conf.json / Cargo.toml 版本号统一升至 1.0.0

- 功能全量：文件夹视频清单、SQLite 进度记忆续播、四种播放模式、倍速 0.50-2.00 记忆、键盘按住加速、系统音量双向同步、关窗不退应用

2026-09-01 | v0.2.6 / 0009 | 修复：点 X 无法关闭窗口；改为关窗不退应用 | 前端/Rust

- 根因：onCloseRequested 中 win.destroy() 缺少 core:window:allow-destroy 权限被拒，preventDefault 后窗口卡住

- 行为改为 macOS 标准：点 X 保存进度后隐藏窗口（应用留驻 Dock 不退出），点击 Dock 图标恢复窗口（RunEvent::Reopen）

- capabilities 增加 core:window:allow-hide

2026-09-01 | v0.2.5 / 0008 | 优化：应用图标改版 | 图标/脚本

- 图标设计改为：白色底 + 黑色圆角边框 + 中心黑色线条描边（白色填充）播放三角，与界面线条图标风格一致

- gen\_icons.sh 改为 2048 超采样渲染后 sips 缩小，边线更平滑；GitHub 开源准备（MIT LICENSE、copyright、公开仓库）

2026-09-01 | v0.2.4 / 0007 | 修复：审查问题 4-9；新增 Rust 单元测试 | 前端/Rust/文档

- 关窗进度丢失：save() 改为返回 Promise，onCloseRequested 中 await 后再销毁窗口

- 静默吞错：进度保存/音量读写三处空 catch 改为 console.error 输出

- 进度百分比统一 clamp 0-100（db.rs / commands.rs / sidebar.js）

- scan\_folder：目录读取失败返回错误信息（前端显示），不再与"无视频"混淆；路径非目录时报错

- folder.rs 注释修正：如实说明为小写字典序（非数字感知自然排序）

- 文档一致性：ARCHITECTURE.md 更新为 4 个 IPC 命令，补播放模式流程与 pendingResume 续播时序

- 新增 cargo test 单元测试 5 项（db 进度 roundtrip / percent clamp / 扩展名过滤 / 错误路径 / 排序）

- 审查 #10（音量监听句柄）评估后不修改：桌面应用无窗口重载场景，进程退出系统自动回收

2026-09-01 | v0.2.3 / 0006 | 修复：player.js 三处修改丢失（编辑竞态） | 前端

- 用户审查发现并由全文核验确认：listen 未导入（初始化中断）、ended 播放模式逻辑缺失、续播仍在换源后立即设置 currentTime（不可靠）

- 根因：多轮并行编辑同一文件互相覆盖；修复方式为整体重写 player.js 并全文核验

- 流程改进：同一文件多处修改必须串行或整体重写；修改后必须全文验证而非局部抽查

2026-09-01 | v0.2.2 / 0005 | 优化：按钮图标线条化 | 前端界面

- 快进/快退/音量/播放/暂停/播放模式/打开文件夹按钮图标全部由 emoji 改为线条风格内联 SVG（Lucide 风格，stroke=currentColor，随主题变色）

- 播放/暂停、播放模式按钮图标由 JS 动态切换 SVG

2026-09-01 | v0.2.1 / 0004 | 新增：音量条同步系统音量、倍速记忆 | Rust/前端

- 音量条改为系统音量镜像：CoreAudio（coreaudio-sys）读写默认输出设备音量并监听变化，系统快捷键调音量时软件音量条实时跟随，拖动软件音量条同步改系统音量；软件内不再衰减 video.volume（恒为 1.0）

- 倍速记忆：调整后存 localStorage，重启/换源后自动重应用（换源后 playbackRate 会被重置，改为 loadedmetadata 时应用）

- 附带修复：续播位置改为 loadedmetadata 时应用，避免换源后被重置

2026-09-01 | v0.2.0 / 0003 | 新增：四种播放模式 + log 工作流 | 前端/脚本/文档

- 播放模式（控制栏按钮循环切换，localStorage 记忆上次选择，默认"播完下集"）：列表循环 / 单集循环 / 播完暂停 / 播完下集

- log 工作流：log/ 目录 + 每日日志（YYYYMMDD.log），改动前写"进行"、完成后改"完成"；archive.sh 归档后自动写 log

2026-09-01 | v0.1.1 / 0002 | 修复：点击"打开文件夹"无反应 | 前端模块加载

- 根因：无 bundler 的 vanilla 前端不能使用 import from '@tauri-apps/...' 裸模块名，浏览器解析失败导致 main.js 整体未加载，所有按钮事件未绑定

- 修复：tauri.conf.json 启用 app.withGlobalTauri，前端（sidebar.js / player.js）改用 window\.__TAURI__ 全局 API，逻辑不变

2026-09-01 | v0.1.0 / 0001 | 初始版本 | 全部

- 项目创建：Tauri 2 架构（Rust 后端 + 原生 JS 前端）

- 功能：打开文件夹视频清单、SQLite 播放进度记忆与续播、左右键快进快退（按住加速）、空格暂停、0.50-2.00 两位小数倍速、界面按钮操作

- 基础设施：README/文档体系、图标生成脚本、归档脚本（20260901-playerWCY-archive）

