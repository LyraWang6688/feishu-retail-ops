/** 交割单页反馈工具：toast + 客户端 request_id（不写死文案）。 */
export const showToast = (text) => {
  let toast = document.querySelector('.workbench-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'workbench-toast';
    toast.setAttribute('role', 'status');
    document.body.appendChild(toast);
  }
  toast.textContent = text;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.remove(); }, 3000);
};

export const requestId = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const rand = Math.floor(Math.random() * 16);
    return (char === 'x' ? rand : ((rand & 0x3) | 0x8)).toString(16);
  });
};
