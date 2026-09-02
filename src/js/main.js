// 前端入口：组装侧边栏、播放器、键盘事件
// ctx 为模块间共享的库上下文：
//   groups      文件夹分组 [{path, name, videos: []}]（来源 SQLite，持久）
//   activeGroup / activeIdx  当前播放位置（连播范围 = 当前文件夹内）
//   playAt(g, i)  按分组索引播放（由 sidebar.js 填充）
import { initSidebar } from './sidebar.js';
import { initPlayer } from './player.js';
import { initKeyboard } from './keyboard.js';

const ctx = {
  groups: [],
  activeGroup: -1,
  activeIdx: -1,
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
}

btnToggle.addEventListener('click', () => {
  const hidden = !appEl.classList.contains('sidebar-hidden');
  localStorage.setItem('pwcy-sidebar-hidden', hidden ? '1' : '0');
  applySidebar(hidden);
});
applySidebar(localStorage.getItem('pwcy-sidebar-hidden') === '1');
