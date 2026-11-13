/**
 * 「货品资料」/「数据配置」页上的**按钮卡动作**（业务负责人 2026-11-10）：
 *   · 卡片：`data-domain-action="sample-image-sync"`（来自 `config/domains.js`）；
 *   · 点击 ⇒ `POST /api/workbench/data-config/sample-image-sync`（启动存量写入，后台跑）；
 *   · 然后轮询 `GET` 同一个路径，把「已处理 x/y、成功 n」写进状态行；
 *   · 卡片刻意**不等请求**（后台可能跑几分钟）：点完立刻显示"正在同步…"，页面可以关。
 *
 * 文案 / 接口路径全在 `config/dataConfig.js`（本文件不写死字符串）。
 * 失败：开始失败 / 轮询失败都写一句人话到状态行（不弹 alert、不阻塞页面）。
 */

import { api } from '../../core/api-client.js';
import { DATA_CONFIG_API, DATA_CONFIG_TEXTS } from '../../config/dataConfig.js';
import { showToast } from '../shared/toast.js';
import { openProductFeatureConfig } from './productFeatureConfig.js';

const fill = (template, values = {}) => String(template || '')
  .replace(/\{(\w+)\}/g, (match, key) => (values[key] === undefined || values[key] === null ? '' : String(values[key])));

const POLL_INTERVAL_MS = 1500;

/**
 * 给一个 `action-cards` 页面挂上点击处理（只处理 `sample-image-sync`；别的动作名不认）。
 * @param {HTMLElement} host 该子页面的宿主（`[data-domain-host]`）
 */
export function bindDomainAction(host) {
  if (!host || host.__domainActionBound) return;
  host.__domainActionBound = true;
  const note = host.querySelector('[data-view="domain-action-note"]');
  const paint = (text) => { if (note) note.textContent = text || ''; };
  let timer = null;
  let toastDone = false;

  const poll = async () => {
    timer = null;
    try {
      const status = await api.get(DATA_CONFIG_API.sampleImageSync);
      if (status?.running) {
        paint(fill(DATA_CONFIG_TEXTS.runningNote, status));
        timer = setTimeout(poll, POLL_INTERVAL_MS);
        return;
      }
      // 页面反馈（轻量 toast）：跑完只弹一次「成功/跳过/失败」计数；**不弹失败警报**
      // （统一异步层规则：失败只发运营群，页面不显示失败提示）
      if (!toastDone) {
        toastDone = true;
        showToast(fill(DATA_CONFIG_TEXTS.finishedToast, status || {}));
      }
      paint(status?.error
        ? fill(DATA_CONFIG_TEXTS.errorNote, status)
        : fill(DATA_CONFIG_TEXTS.doneNote, status || {}));
    } catch (error) {
      paint(DATA_CONFIG_TEXTS.pollFailedNote);
    }
  };

  host.addEventListener('click', async (event) => {
    if (event.target.closest?.('[data-domain-action="product-feature-config"]')) {
      openProductFeatureConfig(host);
      return;
    }
    const voucherButton = event.target.closest?.('[data-domain-action="voucher-catalog-sync"]');
    if (voucherButton) {
      if (voucherButton.disabled) return;
      voucherButton.disabled = true;
      paint(DATA_CONFIG_TEXTS.voucherRunningNote);
      try {
        const result = await api.post(DATA_CONFIG_API.voucherCatalogSync, {});
        showToast(DATA_CONFIG_TEXTS.voucherStartToast);
        paint(fill(DATA_CONFIG_TEXTS.voucherDoneNote, result || {}));
      } catch (error) {
        paint(DATA_CONFIG_TEXTS.voucherFailedNote);
      } finally {
        voucherButton.disabled = false;
      }
      return;
    }
    const button = event.target.closest?.('[data-domain-action="sample-image-sync"]');
    if (!button) return;
    if (button.disabled) return;
    button.disabled = true;
    toastDone = false;
    paint(fill(DATA_CONFIG_TEXTS.runningNote, { done: 0, total: '?', synced: 0 }));
    try {
      await api.post(DATA_CONFIG_API.sampleImageSync, {});
      showToast(DATA_CONFIG_TEXTS.startToast);
      // 立刻查一次（后台可能很快跑完），拿到 total 后继续轮询
      await poll();
    } catch (error) {
      paint(DATA_CONFIG_TEXTS.startFailedNote);
    } finally {
      button.disabled = false;
      if (!timer) timer = setTimeout(poll, POLL_INTERVAL_MS);
    }
  });
}
