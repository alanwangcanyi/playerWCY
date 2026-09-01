// 前端入口：组装侧边栏、播放器、键盘事件
// ctx 为模块间共享的列表上下文（items 清单 / activeIndex 当前索引 / playAt 按索引播放）
import { initSidebar } from './sidebar.js';
import { initPlayer } from './player.js';
import { initKeyboard } from './keyboard.js';

const ctx = { items: [], activeIndex: -1, playAt: () => {} };

const videoApi = initPlayer(ctx);
initSidebar(videoApi, ctx);
initKeyboard(videoApi);
