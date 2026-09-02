// SQLite 数据层：初始化、文件夹记录、进度查询与保存（rusqlite bundled，静态编译进二进制）
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// 单个视频的播放进度记录
#[derive(Debug, Clone)]
pub struct VideoProgress {
    pub position: f64,
    pub duration: f64,
}

/// 文件夹记录
#[derive(Debug, Clone, Serialize)]
pub struct FolderRecord {
    pub path: String,
    pub name: String,
}

/// 初始化数据库连接并建表（含旧数据迁移）
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
        );
        CREATE TABLE IF NOT EXISTS folders (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            path           TEXT UNIQUE NOT NULL,
            name           TEXT NOT NULL,
            added_at       TEXT NOT NULL DEFAULT (datetime('now','localtime')),
            last_opened_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );",
    )?;
    // 一次性迁移：旧版本 videos 已有数据但 folders 为空时，从 folder_path 去重补建记录
    // （名称计算放 Rust 侧，避免复杂 SQL 出错）
    let paths: Vec<String> = {
        let mut stmt =
            conn.prepare("SELECT DISTINCT folder_path FROM videos WHERE folder_path != ''")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    for p in paths {
        let name = folder_display_name(&p);
        let _ = conn.execute(
            "INSERT OR IGNORE INTO folders (path, name) VALUES (?1, ?2)",
            params![p, name],
        );
    }
    Ok(conn)
}

/// 打开/刷新文件夹：upsert 记录并更新时间
pub fn touch_folder(conn: &Connection, path: &str) -> Result<(), rusqlite::Error> {
    let name = folder_display_name(path);
    conn.execute(
        "INSERT INTO folders (path, name) VALUES (?1, ?2)
         ON CONFLICT(path) DO UPDATE SET last_opened_at = datetime('now','localtime')",
        params![path, name],
    )?;
    Ok(())
}

/// 路径显示名：取最后一段（去尾斜杠）
pub fn folder_display_name(path: &str) -> String {
    let p = path.trim_end_matches('/');
    match p.rfind('/') {
        Some(i) => p[i + 1..].to_string(),
        None => p.to_string(),
    }
}

/// 全部文件夹记录（按添加顺序）
pub fn list_folders(conn: &Connection) -> Result<Vec<FolderRecord>, rusqlite::Error> {
    let mut stmt = conn.prepare("SELECT path, name FROM folders ORDER BY id")?;
    let rows = stmt.query_map([], |row| {
        Ok(FolderRecord {
            path: row.get(0)?,
            name: row.get(1)?,
        })
    })?;
    rows.collect()
}

/// 某文件夹下的全部视频记录（file_path/file_name/position/duration/percent）
#[derive(Debug, Serialize)]
pub struct VideoRow {
    pub file_path: String,
    pub file_name: String,
    pub position: f64,
    pub duration: f64,
    pub percent: f64,
}

pub fn list_videos_by_folder(
    conn: &Connection,
    folder: &str,
) -> Result<Vec<VideoRow>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT file_path, file_name, position, duration, percent
         FROM videos WHERE folder_path = ?1
         ORDER BY file_name COLLATE NOCASE",
    )?;
    let rows = stmt.query_map(params![folder], |row| {
        Ok(VideoRow {
            file_path: row.get(0)?,
            file_name: row.get(1)?,
            position: row.get(2)?,
            duration: row.get(3)?,
            percent: row.get(4)?,
        })
    })?;
    rows.collect()
}

/// 打开文件夹扫描时入库：新视频插入（不覆盖已有进度），已知视频不动
pub fn ensure_video(
    conn: &Connection,
    file_path: &str,
    file_name: &str,
    folder_path: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT OR IGNORE INTO videos (file_path, file_name, folder_path)
         VALUES (?1, ?2, ?3)",
        params![file_path, file_name, folder_path],
    )?;
    Ok(())
}

/// 删除整个文件夹记录（级联删其下视频记录；不动磁盘文件）
/// 事务保证：两条删除要么全部成功要么整体回滚
pub fn delete_folder_records(conn: &mut Connection, folder: &str) -> Result<(), rusqlite::Error> {
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM videos WHERE folder_path = ?1", params![folder])?;
    tx.execute("DELETE FROM folders WHERE path = ?1", params![folder])?;
    tx.commit()
}

/// 删除多条视频记录（不动磁盘文件）；单事务批量执行，失败整体回滚
pub fn delete_video_records(conn: &mut Connection, paths: &[String]) -> Result<(), rusqlite::Error> {
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare("DELETE FROM videos WHERE file_path = ?1")?;
        for p in paths {
            stmt.execute(params![p])?;
        }
    }
    tx.commit()
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

/// 建表语句（测试共用）
#[cfg(test)]
pub(crate) fn create_tables(conn: &Connection) -> Result<(), rusqlite::Error> {
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
        );
        CREATE TABLE IF NOT EXISTS folders (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            path           TEXT UNIQUE NOT NULL,
            name           TEXT NOT NULL,
            added_at       TEXT NOT NULL DEFAULT (datetime('now','localtime')),
            last_opened_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );",
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        create_tables(&conn).unwrap();
        conn
    }

    /// 内存库：建表 → 保存 → 查询 round-trip
    #[test]
    fn save_and_get_progress_roundtrip() {
        let conn = db();
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
        let conn = db();
        for (path, pos, dur, want) in [
            ("/v/odd.mp4", 150.0, 100.0, 100.0),
            ("/v/neg.mp4", -5.0, 100.0, 0.0),
            ("/v/zero.mp4", 10.0, 0.0, 0.0),
        ] {
            save_progress(&conn, path, "x.mp4", "/v", pos, dur).unwrap();
            let percent: f64 = conn
                .query_row("SELECT percent FROM videos WHERE file_path = ?1", params![path], |r| r.get(0))
                .unwrap();
            assert_eq!(percent, want);
        }
    }

    /// 文件夹记录：touch / list / 级联删除
    #[test]
    fn folder_records_lifecycle() {
        let mut conn = db();
        touch_folder(&conn, "/media/movies").unwrap();
        touch_folder(&conn, "/media/series").unwrap();
        touch_folder(&conn, "/media/movies").unwrap(); // 重复打开只更新时间
        let folders = list_folders(&conn).unwrap();
        assert_eq!(folders.len(), 2);
        assert_eq!(folders[0].name, "movies");
        assert_eq!(folders[1].name, "series");

        // 视频入组 + 列表查询
        ensure_video(&conn, "/media/movies/a.mp4", "a.mp4", "/media/movies").unwrap();
        ensure_video(&conn, "/media/movies/a.mp4", "a.mp4", "/media/movies").unwrap(); // 不覆盖
        let rows = list_videos_by_folder(&conn, "/media/movies").unwrap();
        assert_eq!(rows.len(), 1);

        // 级联删除文件夹：视频记录一并删除（事务）
        delete_folder_records(&mut conn, "/media/movies").unwrap();
        assert!(list_folders(&conn).unwrap().len() == 1);
        assert!(list_videos_by_folder(&conn, "/media/movies").unwrap().is_empty());
    }

    /// 删除多条视频记录（事务）
    #[test]
    fn delete_video_records_batch() {
        let mut conn = db();
        touch_folder(&conn, "/v").unwrap();
        for n in ["a.mp4", "b.mp4", "c.mp4"] {
            ensure_video(&conn, &format!("/v/{}", n), n, "/v").unwrap();
        }
        delete_video_records(&mut conn, &["/v/a.mp4".into(), "/v/b.mp4".into()]).unwrap();
        let rows = list_videos_by_folder(&conn, "/v").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].file_name, "c.mp4");
    }
}
