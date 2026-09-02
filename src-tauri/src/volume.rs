// 系统音量模块：读取/设置默认输出设备音量，监听变化并推送前端（CoreAudio FFI）
// 音量条 = 系统音量的镜像，软件内不再做音量衰减（video.volume 恒为 1.0）
//
// 属性选择（关键）：
// - VirtualMasterVolume（vmvc）：macOS 系统音量快捷键/控制中心实际调节的"虚拟主音量"。
//   读写与监听都以它为准，否则会出现"系统音量变了、软件音量条不动"的失联。
// - VolumeScalar（每声道标量）：仅作为无 vmvc 属性的旧设备兜底。
use coreaudio_sys::*;
use std::ffi::c_void;
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter};

/// 全局 AppHandle：CoreAudio 回调线程里向窗口推送事件用
static APP: OnceLock<AppHandle> = OnceLock::new();

/// 虚拟主音量属性地址（scope=output, element=main）
fn master_addr() -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress {
        mSelector: kAudioHardwareServiceDeviceProperty_VirtualMasterVolume,
        mScope: kAudioDevicePropertyScopeOutput,
        mElement: kAudioObjectPropertyElementMain,
    }
}

/// 取默认输出设备 ID（失败返回 None，例如无音频设备）
unsafe fn default_output_device() -> Option<AudioDeviceID> {
    let addr = AudioObjectPropertyAddress {
        mSelector: kAudioHardwarePropertyDefaultOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain,
    };
    if AudioObjectHasProperty(kAudioObjectSystemObject, &addr) == 0 {
        return None;
    }
    let mut id: AudioDeviceID = 0;
    let mut size = std::mem::size_of::<AudioDeviceID>() as u32;
    let st = AudioObjectGetPropertyData(
        kAudioObjectSystemObject,
        &addr,
        0,
        std::ptr::null(),
        &mut size,
        &mut id as *mut _ as *mut c_void,
    );
    if st == 0 {
        Some(id)
    } else {
        None
    }
}

/// 读设备某声道音量（0.0-1.0，标量）；设备/声道不支持时返回 None
unsafe fn channel_volume(dev: AudioDeviceID, ch: u32) -> Option<f32> {
    let addr = AudioObjectPropertyAddress {
        mSelector: kAudioDevicePropertyVolumeScalar,
        mScope: kAudioDevicePropertyScopeOutput,
        mElement: ch,
    };
    if AudioObjectHasProperty(dev, &addr) == 0 {
        return None;
    }
    let mut v: f32 = 0.0;
    let mut size = std::mem::size_of::<f32>() as u32;
    let st = AudioObjectGetPropertyData(
        dev,
        &addr,
        0,
        std::ptr::null(),
        &mut size,
        &mut v as *mut f32 as *mut c_void,
    );
    if st == 0 {
        Some(v)
    } else {
        None
    }
}

/// 读系统音量：优先虚拟主音量；设备不支持时回退声道平均；都读不到返回 1.0
pub fn get_system_volume() -> f32 {
    unsafe {
        let Some(dev) = default_output_device() else {
            return 1.0;
        };
        // 虚拟主音量
        let addr = master_addr();
        if AudioObjectHasProperty(dev, &addr) != 0 {
            let mut v: f32 = 0.0;
            let mut size = std::mem::size_of::<f32>() as u32;
            let st = AudioObjectGetPropertyData(
                dev,
                &addr,
                0,
                std::ptr::null(),
                &mut size,
                &mut v as *mut f32 as *mut c_void,
            );
            if st == 0 {
                return v;
            }
        }
        // 兜底：声道平均
        let l = channel_volume(dev, 1);
        let r = channel_volume(dev, 2);
        match (l, r) {
            (Some(a), Some(b)) => (a + b) / 2.0,
            (Some(a), None) | (None, Some(a)) => a,
            (None, None) => 1.0,
        }
    }
}

/// 设置系统音量（0.0-1.0）：优先虚拟主音量；不支持时写各声道；再不行静默忽略
pub fn set_system_volume(v: f32) {
    unsafe {
        let Some(dev) = default_output_device() else {
            return;
        };
        let v = v.clamp(0.0, 1.0);
        // 虚拟主音量（写入后系统自动映射到各声道）
        let addr = master_addr();
        if AudioObjectHasProperty(dev, &addr) != 0 {
            let st = AudioObjectSetPropertyData(
                dev,
                &addr,
                0,
                std::ptr::null(),
                std::mem::size_of::<f32>() as u32,
                &v as *const f32 as *const c_void,
            );
            if st == 0 {
                return;
            }
        }
        // 兜底：逐声道写
        for ch in [1u32, 2] {
            let addr = AudioObjectPropertyAddress {
                mSelector: kAudioDevicePropertyVolumeScalar,
                mScope: kAudioDevicePropertyScopeOutput,
                mElement: ch,
            };
            if AudioObjectHasProperty(dev, &addr) == 0 {
                continue; // 该声道不支持（如单声道设备的 ch2）
            }
            AudioObjectSetPropertyData(
                dev,
                &addr,
                0,
                std::ptr::null(),
                std::mem::size_of::<f32>() as u32,
                &v as *const f32 as *const c_void,
            );
        }
    }
}

/// CoreAudio 音量变化回调（音频线程，只做轻量 emit）
unsafe extern "C" fn on_volume_changed(
    _dev: AudioObjectID,
    _count: u32,
    _addrs: *const AudioObjectPropertyAddress,
    _client: *mut c_void,
) -> OSStatus {
    if let Some(app) = APP.get() {
        let v = get_system_volume();
        let _ = app.emit("system-volume", v);
    }
    0
}

/// 启动系统音量监听：虚拟主音量（系统快捷键调节的就是它）+ 左右声道（兜底设备）
/// 变化时实时推送 system-volume 事件到前端
pub fn start_listener(app: AppHandle) {
    let _ = APP.set(app);
    unsafe {
        let Some(dev) = default_output_device() else {
            return;
        };
        let mut addrs: Vec<AudioObjectPropertyAddress> = vec![master_addr()];
        for ch in [1u32, 2] {
            addrs.push(AudioObjectPropertyAddress {
                mSelector: kAudioDevicePropertyVolumeScalar,
                mScope: kAudioDevicePropertyScopeOutput,
                mElement: ch,
            });
        }
        for addr in &addrs {
            if AudioObjectHasProperty(dev, addr) == 0 {
                continue;
            }
            AudioObjectAddPropertyListener(
                dev,
                addr,
                Some(on_volume_changed),
                std::ptr::null_mut(),
            );
        }
    }
}
