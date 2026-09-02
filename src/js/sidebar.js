// 侧边栏：文件夹分组树（可折叠）、勾选多选、右键菜单删除记录、打开文件夹刷新
// 无 bundler：通过 withGlobalTauri 注入的 window.__TAURI__ 访问 API
const { open } = window.__TAURI__.dialog;
const { invoke } = window.__TAURI__.core;

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

  /** 按分组索引播放（供点击与播放模式共用） */
  ctx.playAt = (g, i) => {
    const group = ctx.groups[g];
    if (!group || !group.videos[i]) return;
    ctx.activeGroup = g;
    ctx.activeIdx = i;
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
      alert('打开文件夹失败: ' + e);
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
          label: '删除此条记录（不删文件）',
          action: () => deleteVideos(ctx, listEl, [item.dataset.path], videoApi, selBar, selCount),
        },
      ]);
    } else if (header) {
      const g = +header.parentElement.dataset.g;
      const group = ctx.groups[g];
      showMenu(menuEl, e, [
        {
          label: `删除整个文件夹记录「${group ? group.name : ''}」（不删文件）`,
          action: () =>
            deleteFolder(ctx, listEl, group ? group.path : '', videoApi, selBar, selCount),
        },
      ]);
    }
  });

  // 点击其他地方关闭菜单
  document.addEventListener('click', () => hideMenu(menuEl));

  // 底部多选操作条
  document.getElementById('btn-del-sel').addEventListener('click', () => {
    const paths = [...selected];
    if (!paths.length) return;
    if (!confirm(`删除所选 ${paths.length} 条记录？（仅删除记录，不会删除文件）`)) return;
    stopIfPlaying(ctx, videoApi, paths);
    invoke('remove_videos', { paths })
      .then(() => {
        selected.clear();
        return reload(ctx, listEl);
      })
      .then(() => updateSelBar(selBar, selCount))
      .catch((e) => alert('删除失败: ' + e));
  });
  document.getElementById('btn-cancel-sel').addEventListener('click', () => {
    selected.clear();
    listEl.querySelectorAll('.video-item.checked').forEach((el) => {
      el.classList.remove('checked');
      el.querySelector('input').checked = false;
    });
    updateSelBar(selBar, selCount);
  });

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
}

/* ---- 库加载与渲染 ---- */

/** 从 SQLite 重载全部文件夹分组并渲染 */
async function reload(ctx, listEl) {
  ctx.groups = await invoke('list_library');
  // 校正当前播放索引（记录可能被删）
  if (ctx.activeGroup >= 0) {
    const cur = ctx.groups[ctx.activeGroup];
    if (!cur || !cur.videos[ctx.activeIdx]) {
      ctx.activeGroup = -1;
      ctx.activeIdx = -1;
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
    header.className = 'group-header';
    header.title = group.path;
    header.innerHTML = `<span class="chev">${CHEV_SVG}</span>
      <span class="gname"></span><span class="gcount">${group.videos.length}</span>`;
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
  // 恢复当前播放高亮
  if (ctx.activeGroup >= 0) markActive(listEl, ctx.activeGroup, ctx.activeIdx);
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
function deleteVideos(ctx, listEl, paths, videoApi, selBar, selCount) {
  if (!paths.length) return;
  if (!confirm(`删除 ${paths.length} 条记录？（仅删除记录，不会删除文件）`)) return;
  stopIfPlaying(ctx, videoApi, paths);
  invoke('remove_videos', { paths })
    .then(() => {
      paths.forEach((p) => selected.delete(p));
      return reload(ctx, listEl);
    })
    .then(() => updateSelBar(selBar, selCount))
    .catch((e) => alert('删除失败: ' + e));
}

function deleteFolder(ctx, listEl, folder, videoApi, selBar, selCount) {
  if (!folder) return;
  const g = ctx.groups.find((x) => x.path === folder);
  const n = g ? g.videos.length : 0;
  if (!confirm(`删除文件夹记录「${g ? g.name : folder}」（含 ${n} 条视频记录）？\n仅删除记录，不会删除磁盘文件。`)) return;
  // 当前播放在该文件夹内则停止跟踪，避免记录复活
  if (ctx.activeGroup >= 0 && ctx.groups[ctx.activeGroup] && ctx.groups[ctx.activeGroup].path === folder) {
    videoApi.stopTracking();
    ctx.activeGroup = -1;
    ctx.activeIdx = -1;
  }
  invoke('remove_folder', { folder })
    .then(() => {
      (g ? g.videos : []).forEach((v) => selected.delete(v.file_path));
      return reload(ctx, listEl);
    })
    .then(() => updateSelBar(selBar, selCount))
    .catch((e) => alert('删除失败: ' + e));
}

/** 若正在播放的条目被删除，停止进度跟踪（防止自动保存把记录写回来） */
function stopIfPlaying(ctx, videoApi, paths) {
  if (paths.includes(videoApi.filePath)) {
    videoApi.stopTracking();
    ctx.activeGroup = -1;
    ctx.activeIdx = -1;
  }
}

/** CSS 选择器转义（路径含特殊字符时安全） */
function cssEscape(s) {
  return (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&');
}
