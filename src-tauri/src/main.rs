// 防止 Windows release 版本弹出控制台窗口（macOS 无影响，保持官方模板写法）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    playerwcy_lib::run()
}
