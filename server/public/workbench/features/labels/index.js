/**
 * 工作台「货品 → 标签打印」页面 —— 现在**只服务「扫码打印」这一个入口**：
 *   「扫码打印」→ `/workbench/label-print.html?scan=1`：
 *     进页只挂**扫码聚焦屏**（`scan-print.js`：JSAPI 扫一扫 ⇒ 扫到的那一张**直接排进打印队列**）。
 *
 * 🔴 2026-11-09（业务负责人）：
 *   ① 旧「筛选 + 批量预览」那一屏、旧批量后端逻辑「完全删除」；批量打印改成**飞书表单**
 *      （后端监听「标签打印」表新增记录自动打印，另一条链路）；
 *   ② 「**选择编号打印**」也删了 —— 她的原话：「**选择编号打印**那个页面也不需要了，可以直接删除，
 *      因为点击批量打印的时候，**只选择一个就可以了**」⇒ 它的入口 / 页面渲染 / 后端批量查询端点
 *      （`GET /api/workbench/labels`、`GET /api/workbench/products/numbers`）**全部物理删除**；
 *   ③ 不带 `?scan=1` 打开本页 ⇒ **什么都不渲染**（正常入口永远带参数）。
 *
 * ⚠️ 页面文件仍是 `label-print.html`（`standalone.js` 的注册表不变）—— 只是里面不再有
 *    单品打印的 A4 预览 / 浏览器打印 / 「打印到店里那台电脑」队列面板（那些随单品打印一起删了）。
 * ⚠️ 「扫码打印」这条链路**一个字没改**：仍复用既有 `/api/label-print/*` 队列与
 *    `labelForRecord`（后端标签生成保留，按记录 ID 出**恰好那一张**）。
 */
import { api } from '../../core/api-client.js';
import { createScanPrintAction, mountScanOnlyPage, wantsScanFromSearch } from './scan-print.js';
import { mountPrintJobStatus } from './printJobStatus.js';

export function createLabelPrintModule() {
  /** ⭐ 扫码打印那一块（扫码 ⇒ 直接排进既有队列；与「扫码页」共用同一份实现）。 */
  const scanPrint = createScanPrintAction({ api });

  return {
    mount(container) {
      // 只有「扫码打印」带 `?scan=1` 进来；其余情况（收藏 / 旧链接 / 后退）不渲染任何内容。
      if (wantsScanFromSearch(typeof window === 'undefined' ? '' : window.location.search)) {
        const params = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);
        const printJobId = String(params.get('print_job') || '').trim();
        // 自动提交完打印任务后进来：先显示刚才那张的打印状态，不立刻唤起相机。
        const panel = mountScanOnlyPage(container, scanPrint, { autoOpen: !printJobId });
        if (printJobId) mountPrintJobStatus(panel, printJobId, { api });
        return;
      }
    },
  };
}
