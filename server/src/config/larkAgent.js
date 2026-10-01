const getLarkAgentCredentials = () => {
  const agentAppId = process.env.LARK_AGENT_APP_ID || '';
  const agentAppSecret = process.env.LARK_AGENT_APP_SECRET || '';
  if (!agentAppId || !agentAppSecret) {
    throw new Error('新飞书应用必须同时配置 LARK_AGENT_APP_ID 和 LARK_AGENT_APP_SECRET，禁止回退到旧租户凭证');
  }
  return {
    appId: agentAppId,
    appSecret: agentAppSecret,
    source: 'lark_agent',
  };
};

module.exports = {
  getLarkAgentCredentials,
};
