// Tauri 命令层：前后端唯一桥接（对应架构图中的 IPC）
use crate::{db, folder, volume, AppState};
use serde::Serialize;
use tauri::State;

/// 返回给前端的视频条目：文件信息 + 播放进度
#[derive(Serialize)]
pub struct VideoItem {
    pub file_path: String,
    pub file_name: String,
    pub folder_path: String,
    /// 上次播放位置（秒）
    pub position: f64,
    /// 视频总时长（秒）
    pub duration: f64,
    /// 播放百分比 0-100
    pub percent: f64,
}

/// 库视图：文件夹 + 其下视频记录（启动时纯读库，不扫磁盘）
#[derive(Serialize)]
pub struct FolderGroup {
    pub path: String,
    pub name: String,
    pub videos: Vec<VideoItem>,
}

/// 扫描文件夹视频清单：合并 SQLite 历史进度，并入库保存文件夹与新视频记录
/// （打开文件夹 = 添加/刷新：新文件入库，已有进度不覆盖，手动删除的记录保留）
#[tauri::command]
pub fn scan_folder(state: State<AppState>, folder: String) -> Result<Vec<VideoItem>, String> {
    let videos = folder::scan_videos(&folder)?;
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::touch_folder(&conn, &folder).map_err(|e| e.to_string())?;
    let items = videos
        .into_iter()
        .map(|v| {
            // 新视频入库（INSERT OR IGNORE，不覆盖已有进度）
            db::ensure_video(&conn, &v.file_path, &v.file_name, &folder)
                .map_err(|e| e.to_string())?;
            let prog = db::get_progress(&conn, &v.file_path);
            let position = prog.as_ref().map(|p| p.position).unwrap_or(0.0);
            let duration = prog.as_ref().map(|p| p.duration).unwrap_or(0.0);
            // 百分比 clamp 到 0-100
            let percent = if duration > 0.0 {
                (((position / duration) * 100.0 * 10.0).round() / 10.0).clamp(0.0, 100.0)
            } else {
                0.0
            };
            Ok(VideoItem {
                file_path: v.file_path,
                file_name: v.file_name,
                folder_path: folder.clone(),
                position,
                duration,
                percent,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(items)
}

/// 启动加载：返回全部文件夹及其视频记录（纯读 SQLite，不扫磁盘）
#[tauri::command]
pub fn list_library(state: State<AppState>) -> Result<Vec<FolderGroup>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let folders = db::list_folders(&conn).map_err(|e| e.to_string())?;
    let groups = folders
        .into_iter()
        .map(|f| {
            let rows = db::list_videos_by_folder(&conn, &f.path).map_err(|e| e.to_string())?;
            let folder_path = f.path.clone(); // 供闭包使用，避免移动后使用
            Ok(FolderGroup {
                path: f.path,
                name: f.name,
                videos: rows
                    .into_iter()
                    .map(|r| VideoItem {
                        file_path: r.file_path,
                        file_name: r.file_name,
                        folder_path: folder_path.clone(),
                        position: r.position,
                        duration: r.duration,
                        percent: r.percent,
                    })
                    .collect(),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(groups)
}

/// 删除整个文件夹记录（级联删其下视频记录；不删除磁盘文件）
#[tauri::command]
pub fn remove_folder(state: State<AppState>, folder: String) -> Result<(), String> {
    let mut conn = state.db.lock().map_err(|e| e.to_string())?;
    db::delete_folder_records(&mut conn, &folder).map_err(|e| e.to_string())
}

/// 删除多条视频记录（不删除磁盘文件）
#[tauri::command]
pub fn remove_videos(state: State<AppState>, paths: Vec<String>) -> Result<(), String> {
    let mut conn = state.db.lock().map_err(|e| e.to_string())?;
    db::delete_video_records(&mut conn, &paths).map_err(|e| e.to_string())
}

/// 保存当前视频播放进度
#[tauri::command]
pub fn save_progress(
    state: State<AppState>,
    file_path: String,
    file_name: String,
    folder_path: String,
    position: f64,
    duration: f64,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    // 前端未传 folder_path 时，从文件路径推导父目录（按文件夹分组的依据）
    let folder_path = if folder_path.trim().is_empty() {
        std::path::Path::new(&file_path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default()
    } else {
        folder_path
    };
    db::save_progress(&conn, &file_path, &file_name, &folder_path, position, duration)
        .map_err(|e| e.to_string())
}

/// 读取系统音量（0.0-1.0）
#[tauri::command]
pub fn get_system_volume() -> f32 {
    volume::get_system_volume()
}

/// 设置系统音量（0.0-1.0）
#[tauri::command]
pub fn set_system_volume(volume: f64) {
    volume::set_system_volume(volume as f32);
}

/// 在 Finder 中显示文件（macOS open -R：打开访达并定位选中该文件）
#[tauri::command]
pub fn reveal_in_finder(file_path: String) -> Result<(), String> {
    let path = std::path::Path::new(&file_path);
    if !path.exists() {
        return Err(format!("文件不存在，可能已被移动或删除：{}", file_path));
    }
    std::process::Command::new("open")
        .arg("-R")
        .arg(&file_path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("打开 Finder 失败: {}", e))
}
