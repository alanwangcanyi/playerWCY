// playerWCY 应用入口：注册插件、初始化数据库、挂载命令、启动系统音量监听
mod commands;
mod db;
mod folder;
mod media_proto;
mod volume;

use std::sync::Mutex;
use tauri::{Emitter, Manager};

/// 全局共享状态：SQLite 连接（Mutex 保证多线程安全）
pub struct AppState {
    pub db: Mutex<rusqlite::Connection>,
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // 自定义 stream:// 媒体协议：完整 HTTP Range 支持，
        // 解决 asset 协议无法播放 moov 在尾部的大 MP4（无限加载）问题
        .register_uri_scheme_protocol("stream", media_proto::handle)
        .setup(|app| {
            // 在系统应用数据目录初始化数据库：~/Library/Application Support/com.wcy.playerwcy/
            let conn = db::init_db(app.handle())?;
            app.manage(AppState {
                db: Mutex::new(conn),
            });
            // 启动系统音量监听（音量条与系统音量双向同步）
            volume::start_listener(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::scan_folder,
            commands::list_library,
            commands::remove_folder,
            commands::remove_videos,
            commands::save_progress,
            commands::get_system_volume,
            commands::set_system_volume,
            commands::reveal_in_finder,
            commands::add_single_file
        ])
        .build(tauri::generate_context!())
        .expect("playerWCY 启动失败")
        .run(|_app, _event| {
            // macOS：点 X 后窗口仅隐藏（应用留驻 Dock）；点击 Dock 图标时恢复主窗口
            #[cfg(target_os = "macos")]
            {
                if let tauri::RunEvent::Reopen { .. } = _event {
                    if let Some(win) = _app.get_webview_window("main") {
                        let _ = win.show();
                    }
                }
                // Finder 双击视频用本软件打开：单文件入库 + 显示窗口 + 通知前端定位播放
                if let tauri::RunEvent::Opened { urls } = _event {
                    for url in urls {
                        if let Ok(path) = url.to_file_path() {
                            let file_path = path.to_string_lossy().to_string();
                            if let Some(state) = _app.try_state::<AppState>() {
                                if let Ok(conn) = state.db.lock() {
                                    let name = path
                                        .file_name()
                                        .and_then(|n| n.to_str())
                                        .unwrap_or_default()
                                        .to_string();
                                    let _ = db::add_single_file(&conn, &file_path, &name);
                                }
                            }
                            if let Some(win) = _app.get_webview_window("main") {
                                let _ = win.show();
                            }
                            let _ = _app.emit("open-file", &file_path);
                        }
                    }
                }
            }
        });
}
