// Tauri 命令层：前后端唯一桥接（对应架构图中的 IPC）
use crate::{db, folder, volume, AppState};
use serde::Serialize;
use tauri::State;

/// 返回给前端的视频条目：文件信息 + 播放进度
#[derive(Serialize)]
pub struct VideoItem {
    pub file_path: String,
    pub file_name: String,
    /// 上次播放位置（秒）
    pub position: f64,
    /// 视频总时长（秒）
    pub duration: f64,
    /// 播放百分比 0-100
    pub percent: f64,
}

/// 扫描文件夹视频清单，并合并 SQLite 中的历史进度
#[tauri::command]
pub fn scan_folder(state: State<AppState>, folder: String) -> Result<Vec<VideoItem>, String> {
    let videos = folder::scan_videos(&folder)?;
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let items = videos
        .into_iter()
        .map(|v| {
            // duration 先取历史记录；新视频首次加载后由前端回写真实时长
            let prog = db::get_progress(&conn, &v.file_path);
            let position = prog.as_ref().map(|p| p.position).unwrap_or(0.0);
            let duration = prog.as_ref().map(|p| p.duration).unwrap_or(0.0);
            // 百分比 clamp 到 0-100
            let percent = if duration > 0.0 {
                (((position / duration) * 100.0 * 10.0).round() / 10.0).clamp(0.0, 100.0)
            } else {
                0.0
            };
            VideoItem {
                file_path: v.file_path,
                file_name: v.file_name,
                position,
                duration,
                percent,
            }
        })
        .collect();
    Ok(items)
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
