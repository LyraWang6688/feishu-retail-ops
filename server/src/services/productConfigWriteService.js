'use strict';

/**
 * 产品配置写入的异步任务（2026-11-19）。
 *
 * 只做编排：HTTP 路由 enqueue，worker 通过既有 gateway 写飞书；
 * 不直接拼写库请求、不绕过 feishuWriteScheduler。
 */
const crypto = require('node:crypto');
const { ASYNC_JOB_TYPES } = require('../config/asyncJobs');
const { SUBMIT_TOAST } = require('../config/submitToast');
const { listProductFeatures, addProductFeatureTag, updateProductFeatureTag, deleteProductFeatureTag } = require('./productFeatureTagService');
const {
  listAccessories, createAccessory, updateAccessory, deleteAccessory, nameKey,
} = require('./accessoryConfigService');
const { addAccessoryCategory, listAccessoryCategories } = require('./accessoryCategoryService');

const RESOURCES = Object.freeze({ feature: 'feature', accessory: 'accessory', accessoryCategory: 'accessoryCategory' });
const ACTIONS = Object.freeze({ create: 'create', update: 'update', delete: 'delete' });
const userError = (message) => Object.assign(new Error(message), { statusCode: 400 });

const featureKey = (value) => String(value || '').trim().toLocaleLowerCase('zh-CN');
const validateBeforeEnqueue = async (gateway, payload) => {
  const data = normalize(payload);
  if (data.resource === RESOURCES.feature) {
    if (data.action === 'delete') return;
    const value = String(data.tag || '').trim();
    if (!value) throw userError('标签不能为空');
    const listed = await listProductFeatures(gateway);
    const dimension = (listed.dimensions || []).find((item) => item.key === data.dimension);
    if (!dimension) throw userError('未知的产品特点维度');
    const duplicate = (dimension.items || []).some((item) => item.recordId !== data.recordId
      && featureKey(item.tag) === featureKey(value));
    if (duplicate) throw userError('这个标签已经存在，不要重复添加');
    return;
  }
  if (data.resource === RESOURCES.accessoryCategory) {
    if (data.action !== 'create') throw userError('种类只支持新增');
    const value = String(data.category || '').trim();
    if (!value) throw userError('种类名称不能为空');
    if (value.length > 50) throw userError('种类名称不能超过 50 个字');
    const listed = await listAccessoryCategories(gateway);
    if (listed.some((item) => featureKey(item) === featureKey(value))) throw userError('这个种类已经存在');
    return;
  }
  if (data.action === 'delete') return;
  const value = String(data.name || '').trim();
  const price = Number(data.price);
  if (!value) throw userError('配品名称不能为空');
  if (data.price === '' || data.price === undefined || !Number.isFinite(price) || price < 0) {
    throw userError('单价必须是非负数字');
  }
  const rows = await listAccessories(gateway);
  const category = String(data.category || '').trim();
  const duplicate = rows.find((item) => item.recordId !== data.recordId
    && item.category === category
    && nameKey(item.name) === nameKey(value));
  if (duplicate) throw userError('同一种类下已经有同名配品');
};


const normalize = (payload = {}) => {
  const resource = String(payload.resource || '').trim();
  const action = String(payload.action || '').trim();
  if (!Object.values(RESOURCES).includes(resource)) throw userError('未知配置资源');
  if (!Object.values(ACTIONS).includes(action)) throw userError('未知配置动作');
  return { ...payload, resource, action };
};

const createProductConfigWriteService = ({ gateway, asyncJobs } = {}) => {
  if (!gateway) throw new Error('ProductConfigWriteService requires gateway');
  if (!asyncJobs) throw new Error('ProductConfigWriteService requires asyncJobs');

  const execute = async (payload = {}) => {
    const data = normalize(payload);
    if (data.resource === RESOURCES.feature) {
      if (data.action === ACTIONS.create) return addProductFeatureTag(gateway, data.dimension, data.tag);
      if (data.action === ACTIONS.update) return updateProductFeatureTag(gateway, data.dimension, data.recordId, data.tag);
      return deleteProductFeatureTag(gateway, data.dimension, data.recordId);
    }
    if (data.resource === RESOURCES.accessoryCategory) return addAccessoryCategory(gateway, data.category);
    if (data.action === ACTIONS.create) return createAccessory(gateway, data);
    if (data.action === ACTIONS.update) return updateAccessory(gateway, data.recordId, data);
    return deleteAccessory(gateway, data.recordId);
  };

  const submit = async ({
    resource, action, submitKey, ownerOpenId = '', operatorName = '', ...fields
  } = {}) => {
    const payload = normalize({ resource, action, ...fields });
    await validateBeforeEnqueue(gateway, payload);
    const key = String(submitKey || '').trim() || crypto.randomUUID();
    const jobId = asyncJobs.jobIdFor(ASYNC_JOB_TYPES.PRODUCT_CONFIG_WRITE, key);
    const { job, created } = await asyncJobs.enqueue({
      jobId,
      type: ASYNC_JOB_TYPES.PRODUCT_CONFIG_WRITE,
      payload,
      ownerOpenId,
      operatorName,
    });
    if (!job) throw new Error('异步任务创建失败');
    if (created) {
      // 不阻塞 HTTP 响应：任务在后台走统一状态机 / 重试 / 通知。
      setImmediate(() => {
        asyncJobs.run({
          jobId,
          run: () => execute(payload),
        }).catch(() => undefined);
      });
    }
    return {
      jobId,
      reused: !created,
      status: job.status,
      toast: SUBMIT_TOAST.text,
    };
  };

  return { submit, execute };
};

module.exports = { createProductConfigWriteService };
