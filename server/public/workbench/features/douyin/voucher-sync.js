import { api } from '../../core/api-client.js';
import { escapeHtml } from '../../core/formatters.js';

/**
 * 货品 → 数据配置：**抖音团购券目录同步**（业务负责人 2026-11-10）。
 *
 * 不是定时任务 —— 这里只有一颗按钮：点一下 ⇒ 调抖音商品接口 ⇒ 把接口返回的字段写回「团购券管理」。
 * 文案只在本文件（页面文案不进 src）。
 */
export function createVoucherSyncModule({ texts = {} } = {}) {
  const label = texts.button || '同步团购券数据';
  const idle = texts.idle || '点一下按钮，从抖音读取券目录并写回「团购券管理」。';
  const running = texts.running || '正在读取抖音券目录…';
  const doneOf = texts.done || ((result) => `已同步 ${result.catalogProducts} 张券，写回 ${result.written} 条`
    + `${result.failedWrites ? `，失败 ${result.failedWrites} 条` : ''}`);

  return {
    mount(host) {
      host.innerHTML = `
        <section class="panel voucher-sync-panel">
          <button class="btn btn-primary" type="button" data-voucher-sync>${escapeHtml(label)}</button>
          <p class="voucher-sync-hint" data-voucher-sync-hint>${escapeHtml(idle)}</p>
        </section>`;
      const button = host.querySelector('[data-voucher-sync]');
      const hint = host.querySelector('[data-voucher-sync-hint]');
      button.addEventListener('click', async () => {
        button.disabled = true;
        hint.textContent = running;
        try {
          const result = await api.post('/api/workbench/douyin/voucher-catalog-sync', {});
          hint.textContent = typeof doneOf === 'function' ? doneOf(result) : doneOf;
        } catch (error) {
          hint.textContent = error.message || '同步失败';
        } finally {
          button.disabled = false;
        }
      });
    },
  };
}
