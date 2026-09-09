// 前端入口：组装侧边栏、播放器、键盘事件
// ctx 为模块间共享的库上下文：
//   groups      文件夹分组 [{path, name, videos: []}]（来源 SQLite，持久）
//   activeGroup / activeIdx  当前播放位置（连播范围 = 当前文件夹内）
//   playAt(g, i)  按分组索引播放（由 sidebar.js 填充）
import { initSidebar, clearSelection } from './sidebar.js';
import { initPlayer } from './player.js';
import { initKeyboard } from './keyboard.js';

/* ---- Android 平台标记：必须在 initPlayer/initSidebar 之前设置 ----
 *  （sidebar.js 初始化时按此 flag 注册 SAF 回调与启动恢复，晚了会整段跳过） */
const IS_ANDROID = /android/i.test(navigator.userAgent) && !!window.NativeBridge;
if (IS_ANDROID) {
  window.__PW_ANDROID = true;
  document.body.classList.add('android'); // 平台 CSS 钩子（A1-A5 样式均挂此类）
}

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

btnToggle.addEventListener('click', (e) => {
  e.stopPropagation(); // B5：阻止冒泡到 video-wrap（Android 上会误触沉浸模式切换）
  const hidden = !appEl.classList.contains('sidebar-hidden');
  localStorage.setItem('pwcy-sidebar-hidden', hidden ? '1' : '0');
  applySidebar(hidden);
});
applySidebar(localStorage.getItem('pwcy-sidebar-hidden') === '1');

/* ---- 倍速快捷键开关（数字键 1-5；状态记忆；关闭时角标变暗） ----
 *  Android：无键盘，默认关闭且隐藏开关（A2） */
const hotkeysToggle = document.getElementById('rate-hotkeys');
const speedGroup = document.querySelector('.speed-group');
function applyRateHotkeys(on) {
  localStorage.setItem('pwcy-rate-hotkeys', on ? '1' : '0');
  speedGroup.classList.toggle('no-hotkeys', !on);
}
hotkeysToggle.addEventListener('change', () => applyRateHotkeys(hotkeysToggle.checked));
const savedHotkeys = localStorage.getItem('pwcy-rate-hotkeys');
hotkeysToggle.checked = savedHotkeys !== null ? savedHotkeys !== '0' : !IS_ANDROID;
speedGroup.classList.toggle('no-hotkeys', !hotkeysToggle.checked);

/* ---- Android A5：点击视频区域隐藏/恢复控制栏（沉浸模式，播放不中断） ---- */
if (IS_ANDROID) {
  const controls = document.getElementById('controls');
  document.getElementById('video-wrap').addEventListener('click', () => {
    controls.classList.toggle('hidden-controls');
  });

  /* ---- Android C3：自定义倍速输入框 单击=应用、双击=编辑 ----
   *  mousedown 阻止单击聚焦（防软键盘弹出），dblclick 才 focus 进入编辑 */
  const rateInput = document.getElementById('rate-input');
  rateInput.addEventListener('mousedown', (e) => {
    if (e.detail < 2) e.preventDefault(); // 单击不聚焦
  });
  rateInput.addEventListener('click', (e) => {
    if (e.detail === 1) videoApi.applyRateSlot(5); // 单击 = 应用输入框当前值
  });
  rateInput.addEventListener('dblclick', () => {
    rateInput.focus();
    rateInput.select(); // 双击进入编辑并全选，便于直接输入
  });
}

/* ---- Android 专属：横屏方向反转（MainActivity 注入的 NativeBridge 桥，不随重力） ---- */
const btnRotate = document.getElementById('btn-rotate');
if (IS_ANDROID) {
  btnRotate.hidden = false;
  btnRotate.addEventListener('click', () => window.NativeBridge.rotate());
  // 单文件入口暂不支持（需 OPEN_DOCUMENT 单选+持久化，列入后续计划）
  document.getElementById('btn-open-file').style.display = 'none';
}
