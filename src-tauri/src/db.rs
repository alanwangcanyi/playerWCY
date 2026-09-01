// SQLite 数据层：初始化、进度查询、进度保存（rusqlite bundled，静态编译进二进制）
use rusqlite::{params, Connection, OptionalExtension};
use tauri::{AppHandle, Manager};
use std::path::PathBuf;

/// 单个视频的播放进度记录
#[derive(Debug, Clone)]
pub struct VideoProgress {
    pub position: f64,
    pub duration: f64,
}

/// 初始化数据库连接并建表
pub fn init_db(app: &AppHandle) -> Result<Connection, Box<dyn std::error::Error>> {
    let dir: PathBuf = app.path().app_data_dir()?;
    std::fs::create_dir_all(&dir)?;
    let conn = Connection::open(dir.join("data.db"))?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS videos (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            file_path   TEXT UNIQUE NOT NULL,
            file_name   TEXT NOT NULL,
            folder_path TEXT NOT NULL,
            duration    REAL NOT NULL DEFAULT 0,
            position    REAL NOT NULL DEFAULT 0,
            percent     REAL NOT NULL DEFAULT 0,
            updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );",
    )?;
    Ok(conn)
}

/// 查询单个视频的进度（不存在返回 None）
pub fn get_progress(conn: &Connection, file_path: &str) -> Option<VideoProgress> {
    conn.query_row(
        "SELECT position, duration FROM videos WHERE file_path = ?1",
        params![file_path],
        |row| {
            Ok(VideoProgress {
                position: row.get(0)?,
                duration: row.get(1)?,
            })
        },
    )
    .optional()
    .ok()
    .flatten()
}

/// 保存播放进度（存在则更新，不存在则插入）
pub fn save_progress(
    conn: &Connection,
    file_path: &str,
    file_name: &str,
    folder_path: &str,
    position: f64,
    duration: f64,
) -> Result<(), rusqlite::Error> {
    // 百分比保留一位小数并 clamp 到 0-100；时长无效时记为 0，避免除零
    let percent = if duration > 0.0 {
        (((position / duration) * 100.0 * 10.0).round() / 10.0).clamp(0.0, 100.0)
    } else {
        0.0
    };
    conn.execute(
        "INSERT INTO videos (file_path, file_name, folder_path, position, duration, percent)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(file_path) DO UPDATE SET
            position  = excluded.position,
            duration  = excluded.duration,
            percent   = excluded.percent,
            updated_at = datetime('now','localtime')",
        params![file_path, file_name, folder_path, position, duration, percent],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 内存库：建表 → 保存 → 查询 round-trip
    #[test]
    fn save_and_get_progress_roundtrip() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS videos (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                file_path   TEXT UNIQUE NOT NULL,
                file_name   TEXT NOT NULL,
                folder_path TEXT NOT NULL,
                duration    REAL NOT NULL DEFAULT 0,
                position    REAL NOT NULL DEFAULT 0,
                percent     REAL NOT NULL DEFAULT 0,
                updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
            );",
        )
        .unwrap();

        save_progress(&conn, "/v/a.mp4", "a.mp4", "/v", 30.0, 100.0).unwrap();
        let p = get_progress(&conn, "/v/a.mp4").unwrap();
        assert_eq!(p.position, 30.0);
        assert_eq!(p.duration, 100.0);

        // 更新（upsert 路径）
        save_progress(&conn, "/v/a.mp4", "a.mp4", "/v", 50.0, 100.0).unwrap();
        let p = get_progress(&conn, "/v/a.mp4").unwrap();
        assert_eq!(p.position, 50.0);
    }

    /// 百分比 clamp：position 超过 duration 时不超过 100；duration 无效时为 0
    #[test]
    fn percent_clamped_to_0_100() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS videos (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                file_path   TEXT UNIQUE NOT NULL,
                file_name   TEXT NOT NULL,
                folder_path TEXT NOT NULL,
                duration    REAL NOT NULL DEFAULT 0,
                position    REAL NOT NULL DEFAULT 0,
                percent     REAL NOT NULL DEFAULT 0,
                updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
            );",
        )
        .unwrap();

        save_progress(&conn, "/v/odd.mp4", "odd.mp4", "/v", 150.0, 100.0).unwrap();
        let percent: f64 = conn
            .query_row("SELECT percent FROM videos WHERE file_path = '/v/odd.mp4'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(percent, 100.0);

        save_progress(&conn, "/v/neg.mp4", "neg.mp4", "/v", -5.0, 100.0).unwrap();
        let percent: f64 = conn
            .query_row("SELECT percent FROM videos WHERE file_path = '/v/neg.mp4'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(percent, 0.0);

        save_progress(&conn, "/v/zero.mp4", "zero.mp4", "/v", 10.0, 0.0).unwrap();
        let percent: f64 = conn
            .query_row("SELECT percent FROM videos WHERE file_path = '/v/zero.mp4'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(percent, 0.0);
    }
}
