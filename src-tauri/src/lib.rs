// playerWCY 应用入口：注册插件、初始化数据库、挂载命令、启动系统音量监听
mod commands;
mod db;
mod folder;
mod volume;

use std::sync::Mutex;
use tauri::Manager;

/// 全局共享状态：SQLite 连接（Mutex 保证多线程安全）
pub struct AppState {
    pub db: Mutex<rusqlite::Connection>,
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
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
            commands::save_progress,
            commands::get_system_volume,
            commands::set_system_volume
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
            }
        });
}
