// 键盘控制：空格暂停、左右键快进快退（按住自动加速）
// 步长档位：连按次数越多步长越大，实现"按住加速"
const STEP_LEVELS = [5, 8, 12, 20];
const SEEK_THROTTLE = 120; // 两次跳转最小间隔（毫秒），防止系统重复速率过快

let holdCount = 0;   // 按住期间触发次数（keyup 重置）
let lastSeekAt = 0;  // 上次跳转时间

export function initKeyboard(videoApi) {
  window.addEventListener('keydown', (e) => {
    // 输入框编辑时不响应全局快捷键
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    switch (e.key) {
      case ' ': // 空格：暂停/播放
        e.preventDefault();
        videoApi.togglePlay();
        break;

      case 'ArrowRight': // 右键：快进（按住加速）
        e.preventDefault();
        doSeek(videoApi, +1);
        break;

      case 'ArrowLeft': // 左键：快退（按住加速）
        e.preventDefault();
        doSeek(videoApi, -1);
        break;
    }
  });

  // 松开方向键：重置加速计数
  window.addEventListener('keyup', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') holdCount = 0;
  });
}

/** 执行一次跳转：首次基础步长，持续按住按档位加速 */
function doSeek(videoApi, dir) {
  const now = Date.now();
  if (now - lastSeekAt < SEEK_THROTTLE) return; // 节流
  lastSeekAt = now;

  holdCount++;
  // 每 4 次升一档：5s → 8s → 12s → 20s 封顶
  const level = Math.min(Math.floor((holdCount - 1) / 4), STEP_LEVELS.length - 1);
  videoApi.seekBy(dir * STEP_LEVELS[level]);
}
