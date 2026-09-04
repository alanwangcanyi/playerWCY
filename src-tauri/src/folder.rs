// 文件夹扫描：过滤视频文件、排序、错误传播
use serde::Serialize;
use std::path::Path;

/// 支持的视频扩展名（mkv/avi 尽力支持，实际能否播放取决于编码，见 README 风险说明）
const VIDEO_EXTS: [&str; 6] = ["mp4", "mov", "m4v", "webm", "mkv", "avi"];

/// 扫描结果条目
#[derive(Serialize, Debug, PartialEq)]
pub struct VideoInfo {
    pub file_path: String,
    pub file_name: String,
}

/// 判断文件是否为支持的视频扩展名（大小写不敏感；单文件打开入库复用）
pub fn is_video_ext(ext: &str) -> bool {
    VIDEO_EXTS.contains(&ext.to_ascii_lowercase().as_str())
}

/// 扫描目录（仅一层，不递归），返回按文件名小写排序的视频清单
/// 注意：这是简单的小写字典序（"ep10" < "ep2"），非数字感知的自然排序
/// 读取目录失败（无权限/路径不存在等）返回 Err，便于前端区分"没有视频"与"读取失败"
pub fn scan_videos(dir: &str) -> Result<Vec<VideoInfo>, String> {
    let path = Path::new(dir);
    if !path.is_dir() {
        return Err(format!("路径不存在或不是文件夹: {}", dir));
    }
    let entries = std::fs::read_dir(path)
        .map_err(|e| format!("读取文件夹失败({}): {}", dir, e))?;

    let mut list: Vec<VideoInfo> = Vec::new();
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else {
            continue; // 单个条目元数据读取失败时跳过，不影响整体
        };
        if !meta.is_file() {
            continue;
        }
        let p = entry.path();
        let Some(ext) = p.extension().and_then(|e| e.to_str()) else {
            continue;
        };
        if !is_video_ext(ext) {
            continue;
        }
        let Some(name) = p.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        list.push(VideoInfo {
            file_path: p.to_string_lossy().to_string(),
            file_name: name.to_string(),
        });
    }
    // 简单小写字典序：保证稳定的显示顺序（非数字感知自然排序）
    list.sort_by(|a, b| a.file_name.to_lowercase().cmp(&b.file_name.to_lowercase()));
    Ok(list)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ext_filter_case_insensitive() {
        assert!(is_video_ext("mp4"));
        assert!(is_video_ext("MP4"));
        assert!(is_video_ext("Mov"));
        assert!(!is_video_ext("txt"));
        assert!(!is_video_ext(""));
        assert!(!is_video_ext("mp4x"));
    }

    #[test]
    fn scan_error_on_missing_dir() {
        // 不存在的路径应返回 Err（而非空列表）
        let r = scan_videos("/nonexistent_path_xyz_123");
        assert!(r.is_err());
    }

    #[test]
    fn scan_returns_sorted_videos() {
        // 临时目录：写入若干文件，验证过滤与排序
        let dir = std::env::temp_dir().join("pwcy_test_scan");
        std::fs::create_dir_all(&dir).unwrap();
        for name in ["b.MP4", "a.mp4", "c.txt", "d.mov", "e.mkv"] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        let list = scan_videos(dir.to_str().unwrap()).unwrap();
        let names: Vec<&str> = list.iter().map(|v| v.file_name.as_str()).collect();
        assert_eq!(names, vec!["a.mp4", "b.MP4", "d.mov", "e.mkv"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
