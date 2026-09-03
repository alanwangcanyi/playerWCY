// 播放器核心：加载、续播、快进快退、倍速、播放模式、系统音量、进度保存（SQLite）
// 无 bundler：通过 withGlobalTauri 注入的 window.__TAURI__ 访问 API
const { invoke, convertFileSrc } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;
const { listen } = window.__TAURI__.event;

const SAVE_INTERVAL = 5000; // 自动保存间隔（毫秒）
let current = null;         // 当前播放的视频条目
let lastSaveAt = 0;         // 上次保存时间戳
let progressCb = null;      // 进度回调（侧边栏订阅）

/** 初始化播放器，返回控制接口 */
export function initPlayer(ctx) {
  const video = document.getElementById('player');
  const wrap = document.getElementById('video-wrap');
  const btnPlay = document.getElementById('btn-play');
  const btnFwd = document.getElementById('btn-fwd');
  const btnBack = document.getElementById('btn-back');
  const seekBar = document.getElementById('seek-bar');
  const timeCur = document.getElementById('time-cur');
  const timeDur = document.getElementById('time-dur');
  const volume = document.getElementById('volume');
  const rateInput = document.getElementById('rate-input');
  const btnMode = document.getElementById('btn-mode');

  /* ---- 线条图标（Lucide 风格 SVG，样式由 CSS 统一渲染） ---- */
  const ICONS = {
    play: '<svg viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20 6 4"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><line x1="9" y1="5" x2="9" y2="19"/><line x1="15" y1="5" x2="15" y2="19"/></svg>',
    skipForward: '<svg viewBox="0 0 24 24"><polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/></svg>',
    repeat: '<svg viewBox="0 0 24 24"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>',
    repeat1: '<svg viewBox="0 0 24 24"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/><path d="M11 10h1v4"/></svg>',
  };
  btnPlay.innerHTML = ICONS.play;

  /* ---- 播放模式：播完下集 → 列表循环 → 单集循环 → 播完暂停（循环切换，记忆选择） ---- */
  const MODES = [
    { key: 'next', label: '播完下集', icon: ICONS.skipForward },
    { key: 'list-loop', label: '列表循环', icon: ICONS.repeat },
    { key: 'one-loop', label: '单集循环', icon: ICONS.repeat1 },
    { key: 'stop', label: '播完暂停', icon: ICONS.pause },
  ];
  let modeIdx = MODES.findIndex((m) => m.key === localStorage.getItem('pwcy-mode'));
  if (modeIdx < 0) modeIdx = 0; // 默认：播完下集
  const updateModeBtn = () => {
    const m = MODES[modeIdx];
    btnMode.innerHTML = m.icon + '<span>' + m.label + '</span>';
  };
  updateModeBtn();
  btnMode.addEventListener('click', () => {
    modeIdx = (modeIdx + 1) % MODES.length;
    localStorage.setItem('pwcy-mode', MODES[modeIdx].key);
    updateModeBtn();
  });

  /* ---- 倍速记忆：恢复上次调整的倍速（换源后 loadedmetadata 重应用） ---- */
  const savedRate = parseFloat(localStorage.getItem('pwcy-rate'));
  if (!isNaN(savedRate) && savedRate >= 0.5 && savedRate <= 2.0) {
    setRate(savedRate); // 统一走 setRate：同步输入框/预设高亮/记忆
  }

  /* ---- 视频事件 ---- */
  let pendingResume = null; // 换源后待恢复的续播位置（loadedmetadata 前直接设置无效）
  let seeking = false;      // 进度条拖拽/点击中：暂停 timeupdate 回写进度条

  video.addEventListener('loadedmetadata', () => {
    // 时长就绪：回填当前条目并立即保存一次
    if (current) current.duration = video.duration || 0;
    timeDur.textContent = fmt(video.duration);
    // 换源会重置进度与倍速，元数据就绪后重新应用
    if (pendingResume !== null) {
      video.currentTime = pendingResume;
      pendingResume = null;
    }
    video.playbackRate = currentRate();
    save(true);
  });

  video.addEventListener('timeupdate', () => {
    // 进度条与时间显示（拖动/点击进度条期间不回写，避免覆盖用户操作）
    const d = video.duration || 0;
    if (d > 0 && !seeking) seekBar.value = Math.round((video.currentTime / d) * 1000);
    timeCur.textContent = fmt(video.currentTime);
    if (current && progressCb) {
      progressCb(current.file_path, video.currentTime, d);
    }
    save(false); // 节流保存
  });

  video.addEventListener('play', () => (btnPlay.innerHTML = ICONS.pause));
  video.addEventListener('pause', () => {
    btnPlay.innerHTML = ICONS.play;
    save(true); // 暂停立即保存
  });

  // 播放失败反馈：显示文件名与原因（文件被移动/删除/编码不支持等）
  const errorTip = document.getElementById('error-tip');
  const errorMsg = document.getElementById('error-msg');
  const ERROR_REASONS = {
    1: '加载被中断',
    2: '网络错误',
    3: '解码失败',
    4: '格式不受支持或文件不存在',
  };
  video.addEventListener('error', () => {
    if (!current) return;
    const code = video.error ? video.error.code : 0;
    errorMsg.textContent = `无法播放：${current.file_name}（${
      ERROR_REASONS[code] || '未知错误'
    }）`;
    errorTip.hidden = false;
  });

  // 播完处理：按当前播放模式分支
  video.addEventListener('ended', () => {
    save(true);
    const mode = MODES[modeIdx].key;
    if (mode === 'one-loop') {
      // 单集循环：重播本集
      video.currentTime = 0;
      video.play();
      return;
    }
    if (mode === 'stop') return; // 播完暂停：停住
    // 播完下集 / 列表循环：在当前文件夹内切下一集
    const g = ctx.groups[ctx.activeGroup];
    if (!g) return;
    const nextIdx = ctx.activeIdx + 1;
    if (nextIdx < g.videos.length) {
      ctx.playAt(ctx.activeGroup, nextIdx);
    } else if (mode === 'list-loop' && g.videos.length > 0) {
      // 列表循环：末尾回到本组第一集（单文件组直接重播，不走 load 的同文件拦截）
      if (g.videos.length === 1) {
        video.currentTime = 0;
        video.play();
      } else {
        ctx.playAt(ctx.activeGroup, 0);
      }
    }
    // 'next' 到组末尾：停住
  });

  /* ---- 界面操作 ---- */
  btnPlay.addEventListener('click', () => togglePlay());
  btnFwd.addEventListener('click', () => seekBy(5));
  btnBack.addEventListener('click', () => seekBy(-5));

  // 进度条拖拽/点击：input 期间置 seeking，防止 timeupdate 回写覆盖导致首次点击失效
  seekBar.addEventListener('pointerdown', () => (seeking = true));
  seekBar.addEventListener('input', () => (seeking = true));
  seekBar.addEventListener('change', () => {
    const d = video.duration || 0;
    if (d > 0) video.currentTime = (seekBar.value / 1000) * d;
    seeking = false;
  });

  // 音量 = 系统音量（双向同步）：软件内不再衰减，video.volume 恒为 1.0
  video.volume = 1.0;
  const syncVolumeBar = (v) => (volume.value = Math.round(v * 100));
  invoke('get_system_volume')
    .then(syncVolumeBar)
    .catch((e) => console.error('读取系统音量失败:', e));
  listen('system-volume', (e) => syncVolumeBar(e.payload));
  volume.addEventListener('input', () => {
    invoke('set_system_volume', { volume: volume.value / 100 }).catch(
      (e) => console.error('设置系统音量失败:', e)
    );
  });

  // 倍速：预设按钮
  document.querySelectorAll('.btn-rate').forEach((b) => {
    b.addEventListener('click', () => setRate(parseFloat(b.dataset.rate)));
  });

  // 倍速：自定义输入（0.50 - 2.00，最多两位小数）
  rateInput.addEventListener('change', () => {
    const v = parseFloat(rateInput.value);
    if (isNaN(v) || v < 0.5 || v > 2.0) {
      rateInput.value = '';
      rateInput.placeholder = '0.5-2.0';
      return;
    }
    setRate(Math.round(v * 100) / 100);
  });

  // 点 X 关窗：保存进度后隐藏窗口（应用留驻 Dock 不退出；点 Dock 图标恢复窗口）
  const win = getCurrentWindow();
  win.onCloseRequested(async (event) => {
    event.preventDefault();
    await save(true);
    await win.hide();
  });

  return {
    load,
    togglePlay,
    seekBy,
    setRate,
    /** 倍速快捷键槽位：1-4 对应预设按钮，5 应用自定义输入框的值 */
    applyRateSlot(slot) {
      if (slot >= 1 && slot <= 4) {
        const btn = document.querySelector(`.btn-rate[data-slot="${slot}"]`);
        if (btn) setRate(parseFloat(btn.dataset.rate));
      } else if (slot === 5) {
        const v = parseFloat(rateInput.value);
        if (!isNaN(v) && v >= 0.5 && v <= 2.0) setRate(v);
      }
    },
    /** 停止进度跟踪：记录被删除时调用，避免继续播放把记录"复活" */
    stopTracking() {
      current = null;
      pendingResume = null;
      video.pause();
    },
    onProgress(cb) {
      progressCb = cb;
    },
    get filePath() {
      return current ? current.file_path : '';
    },
  };

  /* ---- 接口实现 ---- */

  /** 加载视频并按历史进度续播 */
  function load(item) {
    if (current && current.file_path === item.file_path) {
      // 同一视频：不做任何事（点击/双击当前播放项不重置进度）
      return;
    }
    save(true); // 切换前保存上一个
    current = { ...item };
    video.src = convertFileSrc(item.file_path);
    errorTip.hidden = true; // 清除上一次的失败提示
    wrap.classList.add('playing');
    // 续播：有历史进度且未播完（>3 秒且 <98%）时跳到上次位置
    // 注：换源后直接设 currentTime 无效，待 loadedmetadata 时恢复；倍速同理
    pendingResume =
      item.position > 3 && item.duration > 0 && item.position / item.duration < 0.98
        ? item.position
        : 0;
    video.play();
    lastSaveAt = 0;
  }

  function togglePlay() {
    if (!current) return;
    if (video.paused) video.play();
    else video.pause();
  }

  /** 相对跳转（正为快进、负为快退），自动夹在 0~时长 之间 */
  function seekBy(sec) {
    if (!current || !video.duration) return;
    video.currentTime = Math.min(
      Math.max(0, video.currentTime + sec),
      video.duration - 0.05
    );
  }

  /** 设置倍速（0.50-2.00，两位小数）：同步输入框、预设按钮高亮与记忆 */
  function setRate(rate) {
    const v = Math.round(Math.min(2.0, Math.max(0.5, rate)) * 100) / 100;
    video.playbackRate = v;
    rateInput.value = v.toFixed(2);
    rateInput.classList.add('current');
    document.querySelectorAll('.btn-rate').forEach((b) => {
      b.classList.toggle('active', parseFloat(b.dataset.rate) === v);
    });
    localStorage.setItem('pwcy-rate', v.toFixed(2)); // 记忆用户调整的倍速
  }

  function currentRate() {
    const v = parseFloat(rateInput.value);
    return isNaN(v) ? 1.0 : v;
  }

  /** 保存进度到 SQLite；返回 Promise（关闭窗口时需 await 确保写入完成）；
   *  force=true 立即保存，否则按 SAVE_INTERVAL 节流 */
  function save(force) {
    if (!current || !video.duration) return Promise.resolve();
    const now = Date.now();
    if (!force && now - lastSaveAt < SAVE_INTERVAL) return Promise.resolve();
    lastSaveAt = now;
    return invoke('save_progress', {
      filePath: current.file_path,
      fileName: current.file_name,
      folderPath: current.folder_path || '',
      position: video.currentTime,
      duration: video.duration,
    }).catch((e) => console.error('保存播放进度失败:', e));
  }

  function fmt(sec) {
    if (!isFinite(sec)) return '00:00';
    const s = Math.floor(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    const mm = String(m).padStart(2, '0');
    const sss = String(ss).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${sss}` : `${mm}:${sss}`;
  }
}
