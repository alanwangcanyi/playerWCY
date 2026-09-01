// 侧边栏：打开文件夹、渲染视频清单与播放进度
// 无 bundler：通过 withGlobalTauri 注入的 window.__TAURI__ 访问 API
const { open } = window.__TAURI__.dialog;
const { invoke } = window.__TAURI__.core;

/**
 * 初始化侧边栏
 * @param videoApi 播放器接口（player.js 导出）
 * @param ctx 共享列表上下文：items / activeIndex / playAt（由本函数填充）
 */
export function initSidebar(videoApi, ctx) {
  const btn = document.getElementById('btn-open-folder');
  const listEl = document.getElementById('video-list');
  const folderEl = document.getElementById('folder-name');

  /** 按索引播放（供播放模式 ended 逻辑与用户点击共用） */
  ctx.playAt = (i) => {
    if (i < 0 || i >= ctx.items.length) return;
    ctx.activeIndex = i;
    videoApi.load(ctx.items[i]);
    markActive(listEl, listEl.children[i]);
  };

  btn.addEventListener('click', async () => {
    try {
      const dir = await open({ directory: true, title: '选择视频文件夹' });
      if (!dir) return; // 用户取消
      ctx.items = await invoke('scan_folder', { folder: dir });
      ctx.activeIndex = -1;
      folderEl.textContent = dir;
      renderList(listEl, ctx);
    } catch (e) {
      folderEl.textContent = '打开文件夹失败: ' + e;
    }
  });

  // 播放进度变化时，同步更新侧栏对应条目显示
  videoApi.onProgress((filePath, position, duration) => {
    const idx = ctx.items.findIndex((v) => v.file_path === filePath);
    if (idx < 0) return;
    ctx.items[idx].position = position;
    ctx.items[idx].duration = duration;
    // 百分比 clamp 到 0-100，防止异常数据撑破进度条
    ctx.items[idx].percent =
      duration > 0
        ? Math.min(100, Math.max(0, Math.round((position / duration) * 1000) / 10))
        : 0;
    updateItemEl(listEl.children[idx], ctx.items[idx]);
  });
}

/** 渲染完整清单 */
function renderList(listEl, ctx) {
  listEl.innerHTML = '';
  ctx.items.forEach((item, idx) => {
    const li = document.createElement('li');
    li.className = 'video-item';
    li.title = item.file_name;
    li.addEventListener('click', () => ctx.playAt(idx));
    updateItemEl(li, item);
    listEl.appendChild(li);
  });
}

/** 更新单个条目的名称/进度显示 */
function updateItemEl(li, item) {
  if (!li) return;
  const pct = item.duration > 0 ? Math.round(item.percent * 10) / 10 : 0;
  li.innerHTML = `
    <div class="name"></div>
    <div class="meta">
      <div class="pbar"><div style="width:${pct}%"></div></div>
      <span class="pct">${pct}%</span>
    </div>`;
  li.querySelector('.name').textContent = item.file_name;
}

/** 标记当前播放项 */
function markActive(listEl, li) {
  for (const el of listEl.children) el.classList.remove('active');
  li.classList.add('active');
}
