// 自定义 stream:// 媒体协议：完整实现 HTTP Range（206 Partial Content）
// 解决问题：Tauri asset 协议对 moov atom 在尾部的 MP4（未 faststart 的下载/录制文件）
// 无法被 WKWebView 流式定位——WebKit 需要先读到文件末尾的 moov 才能开始播放，
// 大文件下表现为无限加载/播放失败，而 QuickTime 等原生播放器可正常播放。
// 本协议按 Range 分块（默认 8MB/次）响应，WebKit 可自由 seek 读取任意区段。
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use tauri::http::{header, Request, Response};
use tauri::UriSchemeContext;

/// 单次响应最大字节数（8MB）：限制内存占用，WebKit 会按 Content-Range 继续请求后续分块
const MAX_CHUNK: u64 = 8 * 1024 * 1024;

/// 协议处理入口：stream://localhost/<percent-encoded 绝对路径>
pub fn handle<R: tauri::Runtime>(
    _ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    let raw = request.uri().path(); // 形如 /%2FUsers%2Fwcy%2F...%2F2.mp4
    let decoded = percent_decode(raw);
    // 解码后形如 /Users/wcy/...（前导斜杠 + 绝对路径），去掉第一个斜杠恢复绝对路径
    let file_path = decoded.trim_start_matches('/').to_string();
    serve_file(Path::new(&file_path), request.headers().get(header::RANGE))
}

/// 读取文件并按 Range 分块响应
fn serve_file(path: &Path, range_header: Option<&header::HeaderValue>) -> Response<Vec<u8>> {
    let meta = match std::fs::File::open(path).and_then(|f| f.metadata().map(|m| (f, m))) {
        Ok(v) => v,
        Err(_) => return error_response(404, "文件不存在或无法读取"),
    };
    let (mut file, meta) = meta;
    let size = meta.len();
    if size == 0 {
        return error_response(404, "空文件");
    }

    let range = range_header
        .and_then(|v| v.to_str().ok())
        .and_then(|s| parse_range(s, size));

    let (status, start, end) = match range {
        // 请求带合法 Range：按需分块（单块不超过 MAX_CHUNK）
        Some((s, e)) => (206, s, e.min(size - 1).min(s + MAX_CHUNK - 1)),
        // 无 Range 头：返回首块（WebKit/AVFoundation 起播通常带 Range，此为兜底）
        None => (206, 0, (size - 1).min(MAX_CHUNK - 1)),
    };

    let len = end - start + 1;
    let mut buf = vec![0u8; len as usize];
    if file.seek(SeekFrom::Start(start)).is_err() {
        return error_response(500, "读取失败（seek）");
    }
    if file.read_exact(&mut buf).is_err() {
        return error_response(500, "读取失败");
    }

    let ct = content_type(path);
    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, ct)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, len.to_string())
        // 标明本次响应覆盖的字节区间与文件总大小，WebKit 据此发后续 Range 请求
        .header(header::CONTENT_RANGE, format!("bytes {}-{}/{}", start, end, size));
    if status == 206 {
        builder = builder.header("X-Content-Type-Options", "nosniff");
    }
    builder.body(buf).unwrap_or_else(|_| error_response(500, "响应构造失败"))
}

/// 解析 Range 头（bytes=start-end / bytes=start- / bytes=-suffix）
/// 返回 (start, end)（含端点，已按文件大小收敛）；格式非法返回 None
pub fn parse_range(value: &str, size: u64) -> Option<(u64, u64)> {
    let v = value.trim().strip_prefix("bytes=")?;
    let max_end = size - 1;
    if let Some(suffix) = v.strip_prefix('-') {
        // bytes=-N：读最后 N 字节（WebKit 读取尾部 moov 的关键形态）
        let n: u64 = suffix.parse().ok()?;
        if n == 0 {
            return None;
        }
        let start = size.saturating_sub(n);
        return Some((start, max_end));
    }
    let (s, e) = v.split_once('-')?;
    let start: u64 = s.parse().ok()?;
    if start >= size {
        return None; // 起点越界（416 场景，此处按无效处理）
    }
    let end = if e.is_empty() {
        max_end // bytes=start-：读到文件尾
    } else {
        e.parse::<u64>().ok()?.min(max_end)
    };
    if start > end {
        return None;
    }
    Some((start, end))
}

/// 按扩展名返回 MIME 类型（WebKit 依赖 Content-Type 才会将响应当媒体渲染）
fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("mp4") | Some("m4v") => "video/mp4",
        Some("mov") => "video/quicktime",
        Some("webm") => "video/webm",
        Some("mkv") => "video/x-matroska",
        Some("avi") => "video/x-msvideo",
        Some("mp3") => "audio/mpeg",
        Some("m4a") => "audio/mp4",
        Some("aac") => "audio/aac",
        Some("wav") => "audio/wav",
        Some("flac") => "audio/flac",
        Some("ogg") => "audio/ogg",
        _ => "application/octet-stream",
    }
}

/// 简易 percent-decoding（路径由前端 encodeURIComponent 编码）
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() + 1 && i + 2 <= bytes.len() - 1 + 1 {
            let hex = |b: u8| -> Option<u8> {
                match b {
                    b'0'..=b'9' => Some(b - b'0'),
                    b'a'..=b'f' => Some(b - b'a' + 10),
                    b'A'..=b'F' => Some(b - b'A' + 10),
                    _ => None,
                }
            };
            if i + 2 < bytes.len() {
                if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                    out.push(h * 16 + l);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn error_response(status: u16, msg: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(msg.as_bytes().to_vec())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Range 解析：三种形态 + 边界
    #[test]
    fn parse_range_forms() {
        let size = 1000u64;
        assert_eq!(parse_range("bytes=0-99", size), Some((0, 99)));
        assert_eq!(parse_range("bytes=100-", size), Some((100, 999)));
        assert_eq!(parse_range("bytes=-500", size), Some((500, 999))); // 尾部 500 字节
        // end 超出文件大小：收敛到 size-1
        assert_eq!(parse_range("bytes=900-2000", size), Some((900, 999)));
        // 非法：起点越界 / 倒序 / 格式错误
        assert_eq!(parse_range("bytes=1000-", size), None);
        assert_eq!(parse_range("bytes=500-100", size), None);
        assert_eq!(parse_range("chunks=0-99", size), None);
        assert_eq!(parse_range("", size), None);
    }

    /// MIME 映射（大小写不敏感）
    #[test]
    fn content_type_mapping() {
        assert_eq!(content_type(Path::new("/v/a.MP4")), "video/mp4");
        assert_eq!(content_type(Path::new("/v/b.mov")), "video/quicktime");
        assert_eq!(content_type(Path::new("/v/c.xyz")), "application/octet-stream");
    }
}
