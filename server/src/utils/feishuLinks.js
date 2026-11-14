// 飞书多维表格的**记录链接**：让用户点一下就能打开那条记录去补充信息。
//
// 域名与 Base token 都从配置读，不写死——换租户/换 Base 时只改环境变量。
// 记录链接形如：
//   https://<租户域名>/base/<Base token>?table=<表 ID>&record=<记录 ID>
const DEFAULT_TENANT_DOMAIN = 'https://scnzoiwpgxik.feishu.cn';

const tenantDomain = (env = process.env) => {
  const raw = String(env.FEISHU_TENANT_DOMAIN || '').trim() || DEFAULT_TENANT_DOMAIN;
  return raw.replace(/\/+$/, '');
};

/**
 * ⭐ 2026-11-14（业务负责人）：「需要你用『货品信息填写』这个视图的记录链接」——
 *   记录链接可以带 `view` 参数：打开时落在指定视图里（该视图无筛选，全部货品都在）。
 *   `viewId` **可选**：不传 / 空串 ⇒ 链接形状与改前**逐字一致**（不带 view）。
 */
const recordUrl = ({ appToken, tableId, viewId, recordId }, env = process.env) => {
  if (!appToken || !tableId || !recordId) return '';
  const params = new URLSearchParams({ table: tableId });
  const view = String(viewId || '').trim();
  if (view) params.set('view', view);
  params.set('record', recordId);
  return `${tenantDomain(env)}/base/${appToken}?${params.toString()}`;
};

module.exports = { recordUrl, tenantDomain };
