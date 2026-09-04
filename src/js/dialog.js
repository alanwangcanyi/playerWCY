// 应用内弹窗组件：替代原生 alert/confirm（样式与整体 UI 统一，Promise 化）
// 用法：dialogAlert('消息');  const ok = await dialogConfirm('确定？');

let overlay = null;
let titleEl = null;
let msgEl = null;
let btnBox = null;
let resolver = null;

/** 初始化弹窗 DOM（首次调用时懒创建） */
function ensure() {
  if (overlay) return;
  overlay = document.createElement('div');
  overlay.className = 'app-dialog-overlay';
  overlay.innerHTML = `
    <div class="app-dialog" role="dialog" aria-modal="true">
      <div class="app-dialog-title"></div>
      <div class="app-dialog-msg"></div>
      <div class="app-dialog-btns"></div>
    </div>`;
  document.body.appendChild(overlay);
  titleEl = overlay.querySelector('.app-dialog-title');
  msgEl = overlay.querySelector('.app-dialog-msg');
  btnBox = overlay.querySelector('.app-dialog-btns');
  overlay.addEventListener('click', (e) => {
    // 点遮罩 = 取消（仅确认框生效；提示框需点按钮）
    if (e.target === overlay && resolver) close(null);
  });
  // Esc = 取消；同时 body 标记弹窗打开，让全局快捷键（空格/方向键）让位
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('show')) close(null);
  });
}

/** 关闭并 resolve 结果 */
function close(value) {
  overlay.classList.remove('show');
  document.body.classList.remove('dialog-open');
  if (resolver) {
    resolver(value);
    resolver = null;
  }
}

/**
 * 通用弹窗
 * @param {Object} opts
 * @param {string} opts.title 标题
 * @param {string} opts.message 正文（支持 \n 换行）
 * @param {Array<{label:string,value:*,danger?:boolean,primary?:boolean}>} opts.buttons 按钮组
 * @returns {Promise<*>} 点击按钮的 value；点遮罩/取消返回 null
 */
export function showDialog({ title, message, buttons }) {
  ensure();
  titleEl.textContent = title || '';
  msgEl.textContent = message || '';
  msgEl.style.display = message ? '' : 'none';
  titleEl.style.display = title ? '' : 'none';
  btnBox.innerHTML = '';
  for (const b of buttons) {
    const btn = document.createElement('button');
    btn.className = 'app-dialog-btn' + (b.danger ? ' danger' : '') + (b.primary ? ' primary' : '');
    btn.textContent = b.label;
    btn.addEventListener('click', () => close(b.value));
    btnBox.appendChild(btn);
  }
  overlay.classList.add('show');
  document.body.classList.add('dialog-open');
  // 焦点移到第一个按钮，键盘 Enter/Esc 可操作
  const first = btnBox.querySelector('button');
  if (first) first.focus();
  return new Promise((resolve) => {
    resolver = resolve;
  });
}

/** 提示框（替代 alert）：单"知道了"按钮 */
export function dialogAlert(message, title = '提示') {
  return showDialog({
    title,
    message,
    buttons: [{ label: '知道了', value: true, primary: true }],
  });
}

/** 确认框（替代 confirm）：确定返回 true，取消/遮罩返回 false */
export async function dialogConfirm(message, title = '请确认', danger = true) {
  const v = await showDialog({
    title,
    message,
    buttons: [
      { label: '取消', value: false },
      { label: '确定', value: true, danger, primary: !danger },
    ],
  });
  return v === true;
}
