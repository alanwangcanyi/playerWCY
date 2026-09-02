// 系统音量模块：读取/设置默认输出设备音量，监听变化并推送前端（CoreAudio FFI）
// 音量条 = 系统音量的镜像，软件内不再做音量衰减（video.volume 恒为 1.0）
//
// 属性选择（关键）：
// - VirtualMasterVolume（vmvc）：macOS 系统音量快捷键/控制中心实际调节的"虚拟主音量"。
//   读写与监听都以它为准，否则会出现"系统音量变了、软件音量条不动"的失联。
// - VolumeScalar（每声道标量）：仅作为无 vmvc 属性的旧设备兜底。
//
// 设备切换（关键）：
// - 音量监听绑定在"当前默认输出设备"上；另在系统对象上监听
//   kAudioHardwarePropertyDefaultOutputDevice，默认设备变化（蓝牙耳机接入/显示器切换等）
//   时自动把音量监听迁到新设备，并立即推送新设备当前音量。
use coreaudio_sys::*;
use std::ffi::c_void;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter};

/// 全局 AppHandle：CoreAudio 回调线程里向窗口推送事件用
static APP: OnceLock<AppHandle> = OnceLock::new();

/// 当前已注册音量监听的设备 ID（0 = 尚未绑定；音频回调线程与主线程共用，原子访问）
static CURRENT_DEV: AtomicU32 = AtomicU32::new(0);

/// 虚拟主音量属性地址（scope=output, element=main）
fn master_addr() -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress {
        mSelector: kAudioHardwareServiceDeviceProperty_VirtualMasterVolume,
        mScope: kAudioDevicePropertyScopeOutput,
        mElement: kAudioObjectPropertyElementMain,
    }
}

/// 音量监听地址集合：虚拟主音量 + 左右声道（兜底）
fn watch_addrs() -> [AudioObjectPropertyAddress; 3] {
    [
        master_addr(),
        AudioObjectPropertyAddress {
            mSelector: kAudioDevicePropertyVolumeScalar,
            mScope: kAudioDevicePropertyScopeOutput,
            mElement: 1,
        },
        AudioObjectPropertyAddress {
            mSelector: kAudioDevicePropertyVolumeScalar,
            mScope: kAudioDevicePropertyScopeOutput,
            mElement: 2,
        },
    ]
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

/// 把音量监听迁移到当前默认输出设备（设备未变则不动），并推送一次新设备音量
unsafe fn rebind_volume_listeners() {
    let Some(new_dev) = default_output_device() else {
        return;
    };
    let old = CURRENT_DEV.swap(new_dev, Ordering::SeqCst);
    if old == new_dev {
        return; // 设备没变（首次绑定 old=0 且 new_dev 非 0 时正常走后续）
    }
    // 移除旧设备上的音量监听（设备已拔出时调用无害）
    if old != 0 {
        for addr in watch_addrs() {
            AudioObjectRemovePropertyListener(
                old,
                &addr,
                Some(on_volume_changed),
                std::ptr::null_mut(),
            );
        }
    }
    // 在新设备上注册音量监听
    for addr in watch_addrs() {
        if AudioObjectHasProperty(new_dev, &addr) == 0 {
            continue;
        }
        AudioObjectAddPropertyListener(
            new_dev,
            &addr,
            Some(on_volume_changed),
            std::ptr::null_mut(),
        );
    }
    // 立即推送新设备当前音量（不同设备音量不同，前端音量条同步到正确值）
    if let Some(app) = APP.get() {
        let _ = app.emit("system-volume", get_system_volume());
    }
}

/// 默认输出设备变化回调（系统对象上监听，蓝牙耳机接入/显示器切换等触发）
unsafe extern "C" fn on_default_device_changed(
    _obj: AudioObjectID,
    _count: u32,
    _addrs: *const AudioObjectPropertyAddress,
    _client: *mut c_void,
) -> OSStatus {
    rebind_volume_listeners();
    0
}

/// 启动监听：音量监听绑定当前默认设备 + 系统对象上监听默认设备变化（永不过期）
pub fn start_listener(app: AppHandle) {
    let _ = APP.set(app);
    unsafe {
        rebind_volume_listeners(); // 首次绑定当前默认设备
        let addr = AudioObjectPropertyAddress {
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain,
        };
        AudioObjectAddPropertyListener(
            kAudioObjectSystemObject,
            &addr,
            Some(on_default_device_changed),
            std::ptr::null_mut(),
        );
    }
}
