// 侧边栏：文件夹分组树（可折叠）、勾选多选、右键菜单删除记录、打开文件夹刷新
// 无 bundler：通过 withGlobalTauri 注入的 window.__TAURI__ 访问 API
import { dialogAlert, dialogConfirm } from './dialog.js';

const { open } = window.__TAURI__.dialog;
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const CHEV_SVG =
  '<svg viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg>';

/** 已勾选的视频路径集合（跨文件夹多选） */
const selected = new Set();

/** 折叠状态：localStorage 记忆（按文件夹路径） */
function loadCollapsed() {
  try {
    return new Set(JSON.parse(localStorage.getItem('pwcy-collapsed') || '[]'));
  } catch {
    return new Set();
  }
}
function saveCollapsed(set) {
  localStorage.setItem('pwcy-collapsed', JSON.stringify([...set]));
}

/**
 * 初始化侧边栏
 * @param videoApi 播放器接口（player.js 导出）
 * @param ctx 共享库上下文：groups / activeGroup / activeIdx / playAt（由本函数填充）
 */
export function initSidebar(videoApi, ctx) {
  const btn = document.getElementById('btn-open-folder');
  const listEl = document.getElementById('video-list');
  const selBar = document.getElementById('sel-bar');
  const selCount = document.getElementById('sel-count');
  const menuEl = document.getElementById('ctx-menu');

  /** 按分组索引播放（供点击与播放模式共用）；播放身份记录为 file_path */
  ctx.playAt = (g, i) => {
    const group = ctx.groups[g];
    if (!group || !group.videos[i]) return;
    ctx.activeGroup = g;
    ctx.activeIdx = i;
    ctx.activePath = group.videos[i].file_path;
    videoApi.load(group.videos[i]);
    markActive(listEl, g, i);
  };

  // 启动：纯读 SQLite 记录（不扫磁盘）
  reload(ctx, listEl).catch((e) => console.error('加载库失败:', e));

  // 打开文件夹 = 添加/刷新（扫描入库后整库重载）
  btn.addEventListener('click', async () => {
    try {
      const dir = await open({ directory: true, title: '选择视频文件夹' });
      if (!dir) return; // 用户取消
      await invoke('scan_folder', { folder: dir });
      await reload(ctx, listEl);
    } catch (e) {
      console.error('打开文件夹失败:', e);
      dialogAlert('打开文件夹失败：' + e);
    }
  });

  // 打开文件 = 单个视频独立成组入库（不扫描其所在文件夹），并定位播放
  document.getElementById('btn-open-file').addEventListener('click', async () => {
    try {
      const file = await open({
        multiple: false,
        title: '选择视频文件',
        filters: [{ name: '视频', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi'] }],
      });
      if (!file) return; // 用户取消
      await invoke('add_single_file', { filePath: file });
      await reload(ctx, listEl);
      playPath(ctx, file);
    } catch (e) {
      console.error('打开文件失败:', e);
      dialogAlert('打开文件失败：' + e);
    }
  });

  // Finder 双击视频用本软件打开（Rust 已入库并发事件）：刷新列表并定位播放
  listen('open-file', async (e) => {
    try {
      await reload(ctx, listEl);
      playPath(ctx, e.payload);
    } catch (err) {
      console.error('处理外部打开失败:', err);
    }
  });

  /* ---- 列表交互（事件委托） ---- */
  listEl.addEventListener('click', (e) => {
    // 组头：折叠/展开
    const header = e.target.closest('.group-header');
    if (header) {
      toggleCollapse(header.parentElement, loadCollapsed());
      return;
    }
    // 视频条目：播放（checkbox 点击由 change 处理，不触发播放）
    const item = e.target.closest('.video-item');
    if (item && !e.target.closest('.chk')) {
      ctx.playAt(+item.dataset.g, +item.dataset.i);
    }
  });

  // 勾选变化
  listEl.addEventListener('change', (e) => {
    if (e.target.type !== 'checkbox') return;
    const item = e.target.closest('.video-item');
    if (!item) return;
    const path = item.dataset.path;
    if (e.target.checked) selected.add(path);
    else selected.delete(path);
    item.classList.toggle('checked', e.target.checked);
    updateSelBar(selBar, selCount);
  });

  // 右键菜单
  listEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const header = e.target.closest('.group-header');
    const item = e.target.closest('.video-item');
    if (item) {
      showMenu(menuEl, e, [
        {
          label: '在 Finder 中显示',
          action: () =>
            invoke('reveal_in_finder', { filePath: item.dataset.path }).catch((err) =>
              dialogAlert(String(err), 'Finder 定位失败')
            ),
        },
        {
          label: '删除此条记录（不删文件）',
          action: () => deleteVideos(ctx, listEl, [item.dataset.path], videoApi, selBar, selCount),
        },
      ]);
    } else if (header) {
      const g = +header.parentElement.dataset.g;
      const group = ctx.groups[g];
      const label =
        group && group.kind === 1
          ? `删除单文件记录「${group ? group.name : ''}」（不删文件）`
          : `删除整个文件夹记录「${group ? group.name : ''}」（不删文件）`;
      showMenu(menuEl, e, [
        {
          label,
          action: () =>
            deleteFolder(ctx, listEl, group ? group.path : '', videoApi, selBar, selCount),
        },
      ]);
    }
  });

  // 点击其他地方关闭菜单
  document.addEventListener('click', () => hideMenu(menuEl));

  // 底部多选操作条
  document.getElementById('btn-del-sel').addEventListener('click', async () => {
    const paths = [...selected];
    if (!paths.length) return;
    const ok = await dialogConfirm(
      `删除所选 ${paths.length} 条记录？\n仅删除记录，不会删除文件。`,
      '删除确认'
    );
    if (!ok) return;
    stopIfPlaying(ctx, videoApi, paths);
    invoke('remove_videos', { paths })
      .then(() => {
        selected.clear();
        return reload(ctx, listEl);
      })
      .then(() => updateSelBar(selBar, selCount))
      .catch((e) => dialogAlert('删除失败：' + e));
  });
  document.getElementById('btn-cancel-sel').addEventListener('click', clearSelection);

  // 播放进度变化时，同步更新对应条目显示（按 path 定位，跨组通用）
  videoApi.onProgress((filePath, position, duration) => {
    outer: for (const group of ctx.groups) {
      for (const v of group.videos) {
        if (v.file_path !== filePath) continue;
        v.position = position;
        v.duration = duration;
        // 百分比 clamp 到 0-100，防止异常数据撑破进度条
        v.percent =
          duration > 0
            ? Math.min(100, Math.max(0, Math.round((position / duration) * 1000) / 10))
            : 0;
        const el = listEl.querySelector(`.video-item[data-path="${cssEscape(filePath)}"]`);
        updateItemEl(el, v);
        break outer;
      }
    }
  });

  // 虚拟吸顶：滚动时顶部显示当前所属文件夹条，点击可随时收起/展开
  listEl.addEventListener('scroll', () => updateSticky(listEl, ctx), { passive: true });
}

/* ---- 库加载与渲染 ---- */

/** 从 SQLite 重载全部文件夹分组并渲染 */
async function reload(ctx, listEl) {
  ctx.groups = await invoke('list_library');
  // 播放身份 = file_path：删除/刷新后按路径重算分组索引，防止索引偏移
  // 导致高亮错位或"播完下集"切错目标
  ctx.activeGroup = -1;
  ctx.activeIdx = -1;
  if (ctx.activePath) {
    outer: for (let g = 0; g < ctx.groups.length; g++) {
      const vs = ctx.groups[g].videos;
      for (let i = 0; i < vs.length; i++) {
        if (vs[i].file_path === ctx.activePath) {
          ctx.activeGroup = g;
          ctx.activeIdx = i;
          break outer;
        }
      }
    }
  }
  renderList(listEl, ctx);
}

/** 渲染分组树 */
function renderList(listEl, ctx) {
  const collapsed = loadCollapsed();
  listEl.innerHTML = '';
  ctx.groups.forEach((group, g) => {
    const li = document.createElement('li');
    li.className = 'folder-group' + (collapsed.has(group.path) ? ' collapsed' : '');
    li.dataset.g = g;

    const header = document.createElement('div');
    header.className = 'group-header' + (group.kind === 1 ? ' file-group' : '');
    header.title = group.path;
    // kind=1 单文件组：徽章显示"单文件"并加 file-badge 样式区分；普通文件夹显示视频数量
    header.innerHTML = `<span class="chev">${CHEV_SVG}</span>
      <span class="gname"></span><span class="gcount${
        group.kind === 1 ? ' file-badge' : ''
      }">${group.kind === 1 ? '单文件' : group.videos.length}</span>`;
    header.querySelector('.gname').textContent = group.name;
    li.appendChild(header);

    const ul = document.createElement('ul');
    ul.className = 'group-videos';
    group.videos.forEach((v, i) => {
      const item = document.createElement('li');
      item.className = 'video-item';
      item.dataset.g = g;
      item.dataset.i = i;
      item.dataset.path = v.file_path;
      item.title = v.file_name;
      if (selected.has(v.file_path)) item.classList.add('checked');
      item.innerHTML = `<label class="chk"><input type="checkbox" ${
        selected.has(v.file_path) ? 'checked' : ''
      }/></label><div class="name"></div>
        <div class="meta"><div class="pbar"><div style="width:0%"></div></div><span class="pct">0%</span></div>`;
      item.querySelector('.name').textContent = v.file_name;
      updateItemEl(item, v);
      ul.appendChild(item);
    });
    li.appendChild(ul);
    listEl.appendChild(li);
  });
  buildSticky(listEl, ctx);
  // 恢复当前播放高亮
  if (ctx.activeGroup >= 0) markActive(listEl, ctx.activeGroup, ctx.activeIdx);
}

/* ---- 虚拟吸顶（组头吸附） ---- */

/** 当前吸顶条元素 */
let stickyEl = null;

/** 创建吸顶条（列表第一个子元素，sticky 最可靠形态），点击 = 收起/展开当前顶部组
 *  显隐由 .show class 过渡（CSS max-height/opacity 动画），初始隐藏态由样式默认值保证 */
function buildSticky(listEl, ctx) {
  stickyEl = document.createElement('li');
  stickyEl.className = 'group-header sticky-ghost';
  stickyEl.title = '点击收起/展开当前文件夹';
  stickyEl.innerHTML = `<span class="chev">${CHEV_SVG}</span>
    <span class="gname"></span><span class="gcount"></span>`;
  stickyEl.addEventListener('click', () => {
    const g = stickyEl.dataset.g;
    const li = listEl.querySelector(`.folder-group[data-g="${g}"]`);
    if (li) {
      toggleCollapse(li, loadCollapsed());
      updateSticky(listEl, ctx);
    }
  });
  listEl.insertBefore(stickyEl, listEl.firstChild);
  updateSticky(listEl, ctx);
}

/** 滚动时更新吸顶条：显示列表顶部当前所属的文件夹；真实组头可见时隐藏避免重叠 */
function updateSticky(listEl, ctx) {
  if (!stickyEl) return;
  const listTop = listEl.getBoundingClientRect().top;
  let current = null;
  let header = null;
  // 找第一个尚未完全滚出顶部的组（即当前占据列表顶部的组）
  for (const li of listEl.querySelectorAll('.folder-group')) {
    if (li.getBoundingClientRect().bottom > listTop + 1) {
      current = li;
      header = li.querySelector('.group-header');
      break;
    }
  }
  if (!current || !header) {
    stickyEl.classList.remove('show');
    return;
  }
  // 组头自身还可见（未滚过顶）→ 不显示吸顶条
  if (header.getBoundingClientRect().bottom > listTop + 2) {
    stickyEl.classList.remove('show');
    return;
  }
  const g = +current.dataset.g;
  const group = ctx.groups[g];
  if (!group) {
    stickyEl.classList.remove('show');
    return;
  }
  stickyEl.dataset.g = g;
  stickyEl.querySelector('.gname').textContent = group.name;
  const cnt = stickyEl.querySelector('.gcount');
  cnt.textContent = group.kind === 1 ? '单文件' : group.videos.length;
  cnt.classList.toggle('file-badge', group.kind === 1);
  stickyEl.classList.toggle('st-collapsed', current.classList.contains('collapsed'));
  stickyEl.classList.add('show');
}

/** 按文件路径定位并播放（外部打开/单文件打开后使用） */
function playPath(ctx, path) {
  outer: for (let g = 0; g < ctx.groups.length; g++) {
    const vs = ctx.groups[g].videos;
    for (let i = 0; i < vs.length; i++) {
      if (vs[i].file_path === path) {
        ctx.playAt(g, i);
        break outer;
      }
    }
  }
}

/** 更新单个条目的进度显示 */
function updateItemEl(li, item) {
  if (!li) return;
  const pct = item.duration > 0 ? Math.min(100, Math.max(0, item.percent)) : 0;
  li.querySelector('.pbar > div').style.width = pct + '%';
  li.querySelector('.pct').textContent = pct + '%';
}

/** 标记当前播放项 */
function markActive(listEl, g, i) {
  listEl.querySelectorAll('.video-item.active').forEach((el) => el.classList.remove('active'));
  const el = listEl.querySelector(`.video-item[data-g="${g}"][data-i="${i}"]`);
  if (el) el.classList.add('active');
}

/** 折叠/展开分组并持久化 */
function toggleCollapse(groupEl, collapsed) {
  // 从 DOM 拿组路径（header.title 存了 path）
  const path = groupEl.querySelector('.group-header').title;
  const nowCollapsed = !groupEl.classList.contains('collapsed');
  groupEl.classList.toggle('collapsed', nowCollapsed);
  if (nowCollapsed) collapsed.add(path);
  else collapsed.delete(path);
  saveCollapsed(collapsed);
}

/** 底部多选操作条显示状态 */
function updateSelBar(selBar, selCount) {
  const n = selected.size;
  selBar.hidden = n === 0;
  selCount.textContent = n;
}

/* ---- 右键菜单 ---- */
function showMenu(menuEl, e, items) {
  menuEl.innerHTML = '';
  for (const it of items) {
    const div = document.createElement('div');
    div.className = 'ctx-item';
    div.textContent = it.label;
    div.addEventListener('click', (ev) => {
      ev.stopPropagation();
      hideMenu(menuEl);
      it.action();
    });
    menuEl.appendChild(div);
  }
  menuEl.hidden = false;
  const x = Math.min(e.clientX, window.innerWidth - 240);
  const y = Math.min(e.clientY, window.innerHeight - items.length * 36 - 16);
  menuEl.style.left = x + 'px';
  menuEl.style.top = y + 'px';
}
function hideMenu(menuEl) {
  menuEl.hidden = true;
}

/* ---- 删除记录（不删磁盘文件） ---- */
async function deleteVideos(ctx, listEl, paths, videoApi, selBar, selCount) {
  if (!paths.length) return;
  const ok = await dialogConfirm(
    `删除 ${paths.length} 条记录？\n仅删除记录，不会删除文件。`,
    '删除确认'
  );
  if (!ok) return;
  stopIfPlaying(ctx, videoApi, paths);
  invoke('remove_videos', { paths })
    .then(() => {
      paths.forEach((p) => selected.delete(p));
      return reload(ctx, listEl);
    })
    .then(() => updateSelBar(selBar, selCount))
    .catch((e) => dialogAlert('删除失败：' + e));
}

async function deleteFolder(ctx, listEl, folder, videoApi, selBar, selCount) {
  if (!folder) return;
  const g = ctx.groups.find((x) => x.path === folder);
  const n = g ? g.videos.length : 0;
  const isFile = g && g.kind === 1;
  const tip = isFile
    ? `删除单文件记录「${g ? g.name : folder}」？\n仅删除记录，不会删除磁盘文件。`
    : `删除文件夹记录「${g ? g.name : folder}」（含 ${n} 条视频记录）？\n仅删除记录，不会删除磁盘文件。`;
  if (!(await dialogConfirm(tip, '删除确认'))) return;
  // 当前播放在该文件夹内则停止跟踪，避免记录复活
  if (ctx.activeGroup >= 0 && ctx.groups[ctx.activeGroup] && ctx.groups[ctx.activeGroup].path === folder) {
    videoApi.stopTracking();
    ctx.activeGroup = -1;
    ctx.activeIdx = -1;
    ctx.activePath = '';
  }
  invoke('remove_folder', { folder })
    .then(() => {
      (g ? g.videos : []).forEach((v) => selected.delete(v.file_path));
      return reload(ctx, listEl);
    })
    .then(() => updateSelBar(selBar, selCount))
    .catch((e) => dialogAlert('删除失败：' + e));
}

/** 若正在播放的条目被删除，停止进度跟踪（防止自动保存把记录写回来） */
function stopIfPlaying(ctx, videoApi, paths) {
  if (paths.includes(videoApi.filePath)) {
    videoApi.stopTracking();
    ctx.activeGroup = -1;
    ctx.activeIdx = -1;
    ctx.activePath = '';
  }
}

/** 清空多选（收起侧栏时也调用：退出多选模式，避免勾选状态悬空） */
export function clearSelection() {
  selected.clear();
  const listEl = document.getElementById('video-list');
  const selBar = document.getElementById('sel-bar');
  const selCount = document.getElementById('sel-count');
  if (!listEl) return;
  listEl.querySelectorAll('.video-item.checked').forEach((el) => {
    el.classList.remove('checked');
    const input = el.querySelector('input');
    if (input) input.checked = false;
  });
  updateSelBar(selBar, selCount);
}

/** CSS 选择器转义（路径含特殊字符时安全） */
function cssEscape(s) {
  return (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&');
}
