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
