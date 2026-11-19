import {
  FEISHU_APPLINK_WEB_URL_OPEN,
  LINK_APPLINK_ENABLED,
  LINK_APPLINK_MODE,
  LINK_DIRECT_JUMP_ENABLED,
} from '../../config/links.js';

/**
 * 「点一次就到」的跳转装配（2026-10-12 业务负责人定）。
 *
 * ⭐ 2026-11-19：原实现放在 features/query/index.js；该文件的全仓查询卡片已退场，
 *   但「货品上新 / 配品」的直跳仍用同一套规则，故原样迁到这里。
 *   URL 一律来自调用方配置，本文件不写任何业务链接。
 */
export const directJumpEnabled = (options = {}) => (options.enabled ?? LINK_DIRECT_JUMP_ENABLED) === true;

export const applinkEnabled = (options = {}) => (options.applinkEnabled ?? LINK_APPLINK_ENABLED) === true;

const hasLink = (href) => typeof href === 'string' && href.trim() !== '';

export function buildDirectJumpUrl(href, options = {}) {
  const url = hasLink(href) ? String(href).trim() : '';
  if (!url) return '';
  if (!applinkEnabled(options)) return url;
  const mode = options.appLinkMode ?? LINK_APPLINK_MODE;
  return `${FEISHU_APPLINK_WEB_URL_OPEN}?mode=${encodeURIComponent(mode)}&url=${encodeURIComponent(url)}`;
}
