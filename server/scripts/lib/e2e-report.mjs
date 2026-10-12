/**
 * 自测脚本的**报告与退出码**（纯函数，唯一的判定处）。
 *
 * 为什么单独一个模块（2026-10-12，独立复核 agent 挑出的 F-1 / F-2）：
 *   ① **退出码必须反映失败**：`failedCount > 0` ⇒ 非零退出。原来"算了失败数但不影响退出码"
 *      ⇒ 未达标也 `exit 0` ⇒ 任何看退出码的自动化都会**假绿** ✗
 *   ② **跳过必须落报告**：跳过只在控制台滚一句、报告里没有字段、汇总只数"跑了的"
 *      ⇒ "8 个场景跑 2 个"读起来像全覆盖 ✗ ⇒ 报告里要有 `skipped: [{ name, reason }]`，
 *      汇总**分别**打印 **跑过 / 跳过 / 失败**。
 *
 * ⚠️ 这个模块**不碰网络、不碰文件**（只拼数据）⇒ 可以被单测直接钉住。
 */

/** 每个场景的判定：`checks` 里有任意一条 `pass === false` ⇒ 这个场景未达标。 */
export const isFailed = (scenario) => Array.isArray(scenario?.checks)
  && scenario.checks.some((row) => row?.pass === false);

/** 汇总：跑过 / 未达标 / 跳过（三者互斥，且**总数对得上**）。 */
export const summarize = ({ scenarios = [], skipped = [] } = {}) => {
  const failed = scenarios.filter(isFailed).length;
  return {
    ran: scenarios.length,
    failed,
    passed: scenarios.length - failed,
    skipped: skipped.length,
    total: scenarios.length + skipped.length,
  };
};

/** 报告体：`scenarios`（跑过的）+ `skipped`（**必须落盘**，带原因）。 */
export const buildReport = ({ generatedAt = new Date().toISOString(), base = '', scenarios = [], skipped = [] } = {}) => ({
  generated_at: generatedAt,
  base,
  summary: summarize({ scenarios, skipped }),
  scenarios,
  skipped: skipped.map((item) => ({
    name: String(item?.name || ''),
    reason: String(item?.reason || ''),
  })),
});

/** 退出码：有失败 ⇒ 1；脚本自己报错 ⇒ 2（调用方传过来）；否则 0。 */
export const exitCodeFor = ({ failed = 0, error = false } = {}) => {
  if (error) return 2;
  return failed > 0 ? 1 : 0;
};

/** 汇总那一行：**分别**说清"跑过 / 跳过 / 失败"（不许只说"跑了几个"）。 */
export const summaryLine = (summary = {}) => {
  const { ran = 0, failed = 0, passed = 0, skipped = 0 } = summary;
  return `场景：跑过 ${ran} 个（通过 ${passed} / 未达标 ${failed}），跳过 ${skipped} 个`;
};
