'use strict';

/**
 * 抖音来客（生活服务）只读接入的出口。
 *
 * 用法：
 *   const { createLaikeClient } = require('../services/douyin');
 *   const client = createLaikeClient();
 *   const token = await client.token();
 *   const records = await client.verifyRecords({ accountId, startTime, endTime });
 */

const { createLaikeClient } = require('./laikeClient');

module.exports = { createLaikeClient };
