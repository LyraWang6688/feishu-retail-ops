'use strict';

/**
 * 扫码页的「这一页是谁 / 这一页在取什么 / 回跳到哪」上下文（阶段 5b 从 index.js 搬出）。
 * 只做纯拼装，不读写远端。
 */
const createPageContext = ({
  config, DEFAULT_REALM, getSessionUser, roleOf, setTraceFields, pageSessionKeyOfRequest,
}) => {
  const openIdOf = (req) => {
    const openId = String(req.workbenchUser?.open_id || getSessionUser(req)?.open_id || '');
    if (openId) setTraceFields({ role: roleOf(openId) });
    return openId;
  };

  const sessionIdOf = (req, openId = openIdOf(req)) => pageSessionKeyOfRequest(req, openId);

  const isRecordBase = () => true;
  const scanTargetOf = (req) => {
    const value = decodeURIComponent(String(req.params?.recordId ?? ''));
    return { mode: 'recordId', value };
  };
  const backTargetFor = (req) => scanTargetOf(req);
  const lookupInputOf = (req) => ({ recordId: scanTargetOf(req).value });

  const postActionFor = (target, realm = DEFAULT_REALM) => {
    const resolved = target && typeof target === 'object' ? target : { value: target };
    const basePath = String(config.route.recordBasePath || '');
    const path = `${basePath}/${encodeURIComponent(String(resolved.value || ''))}`;
    return realm && realm !== DEFAULT_REALM ? `${path}?from=${encodeURIComponent(realm)}` : path;
  };

  return {
    openIdOf, sessionIdOf, isRecordBase, scanTargetOf, backTargetFor, lookupInputOf, postActionFor,
  };
};

module.exports = { createPageContext };
