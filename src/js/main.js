// 前端入口：组装侧边栏、播放器、键盘事件
// ctx 为模块间共享的库上下文：
//   groups      文件夹分组 [{path, name, videos: []}]（来源 SQLite，持久）
//   activeGroup / activeIdx  当前播放位置（连播范围 = 当前文件夹内）
//   playAt(g, i)  按分组索引播放（由 sidebar.js 填充）
import { initSidebar, clearSelection } from './sidebar.js';
import { initPlayer } from './player.js';
import { initKeyboard } from './keyboard.js';
import { dialogAlert } from './dialog.js';

const ctx = {
  groups: [],
  activeGroup: -1,
  activeIdx: -1,
  activePath: '', // 播放身份 = 文件路径（列表刷新/删除后按路径重算索引，防偏移）
  playAt: () => {},
};

const videoApi = initPlayer(ctx);
initSidebar(videoApi, ctx);
initKeyboard(videoApi);

/* ---- 侧栏收起/展开按钮（视频区左上角，悬停放大移开缩小，状态记忆） ---- */
const ICONS_TOGGLE = {
  left: '<svg viewBox="0 0 24 24"><polyline points="11 17 6 12 11 7"/><polyline points="18 17 13 12 18 7"/></svg>',
  right: '<svg viewBox="0 0 24 24"><polyline points="13 17 18 12 13 7"/><polyline points="6 17 11 12 6 7"/></svg>',
};
const btnToggle = document.getElementById('btn-toggle-sidebar');
const appEl = document.getElementById('app');

function applySidebar(hidden) {
  appEl.classList.toggle('sidebar-hidden', hidden);
  btnToggle.innerHTML = hidden ? ICONS_TOGGLE.right : ICONS_TOGGLE.left;
  // 收起侧栏 = 退出多选模式，避免"删除所选"操作条不可达但勾选仍悬空
  if (hidden) clearSelection();
}

btnToggle.addEventListener('click', () => {
  const hidden = !appEl.classList.contains('sidebar-hidden');
  localStorage.setItem('pwcy-sidebar-hidden', hidden ? '1' : '0');
  applySidebar(hidden);
});
applySidebar(localStorage.getItem('pwcy-sidebar-hidden') === '1');

/* ---- 倍速快捷键开关（数字键 1-5；状态记忆；关闭时角标变暗） ---- */
const hotkeysToggle = document.getElementById('rate-hotkeys');
const speedGroup = document.querySelector('.speed-group');
function applyRateHotkeys(on) {
  localStorage.setItem('pwcy-rate-hotkeys', on ? '1' : '0');
  speedGroup.classList.toggle('no-hotkeys', !on);
}
hotkeysToggle.addEventListener('change', () => applyRateHotkeys(hotkeysToggle.checked));
hotkeysToggle.checked = localStorage.getItem('pwcy-rate-hotkeys') !== '0';
speedGroup.classList.toggle('no-hotkeys', !hotkeysToggle.checked);

/* ---- Android 专属：横屏方向反转（MainActivity 注入的 NativeBridge 桥，不随重力） ---- */
const btnRotate = document.getElementById('btn-rotate');
if (/android/i.test(navigator.userAgent) && window.NativeBridge) {
  btnRotate.hidden = false;
  btnRotate.addEventListener('click', () => window.NativeBridge.rotate());
}

/* ---- Android 专属：SAF 探针（选文件夹/列视频/stream 播放，验证重启持久化） ----
 *  旧"打开文件夹/打开文件"按钮在 Android 上隐藏（系统选择器链路不通，避免误点无反应） */
const safProbe = document.getElementById('saf-probe');
if (/android/i.test(navigator.userAgent) && window.NativeBridge) {
  document.querySelector('.open-actions').style.display = 'none';
  safProbe.hidden = false;
  document.getElementById('btn-saf-pick').addEventListener('click', () => {
    document.getElementById('player').pause();
    window.NativeBridge.pickFolder();
  });
  document.getElementById('btn-saf-saved').addEventListener('click', () => {
    // 点击立即变字：证明 JS listener 已执行（若没变说明前端绑定崩了）
    const b = document.getElementById('btn-saf-saved');
    b.textContent = '已触发…';
    document.getElementById('player').pause();
    window.NativeBridge.playFirst();
  });
  window.__safProbe = (r) => {
    if (!r.ok) {
      dialogAlert('SAF 探针失败：' + r.error);
      return;
    }
    if (r.mode === 'stage') {
      dialogAlert('阶段：' + r.msg);
      return;
    }
    if (r.mode === 'play') {
      // 探针二期：cache 真实路径 → stream 协议（验证自定义协议在 Android WebView 可用）
      const { convertFileSrc } = window.__TAURI__.core;
      const v = document.getElementById('player');
      const url = convertFileSrc(r.path, 'stream');
      v.onerror = () => {
        dialogAlert(
          'video 错误 code=' + (v.error ? v.error.code : '?') + ' ' + (v.error ? v.error.message : '')
        );
        v.onerror = null;
      };
      v.src = url;
      v.play().catch((e) => dialogAlert('play() 被拒：' + e));
      v.addEventListener(
        'loadeddata',
        () => dialogAlert('stream 协议播放成功 ✓'),
        { once: true }
      );
      return;
    }
    const names = r.items.slice(0, 5).map((v) => v.name).join('\n');
    dialogAlert(`SAF 探针成功：找到 ${r.count} 个视频\n${names}${r.count > 5 ? '\n…' : ''}`);
  };
}
