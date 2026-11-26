'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'public', 'workbench');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('人员管理卡片在配置审计 tab，点击打开 staff 页面', () => {
  const domains = read('config/domains.js');
  assert.ok(domains.includes("action: 'staff-attendance'"), '配置审计要有人员管理卡片');
  const action = read('features/domains/dataConfigAction.js');
  assert.ok(action.includes("data-domain-action=\"staff-attendance\""), '点击分发到人员管理');
  assert.ok(action.includes('openStaffPanel(host)'), '打开人员管理面板');
  assert.ok(fs.existsSync(path.join(ROOT, 'features/domains/staff.js')));
});

test('人员管理页面：按权限判断编辑，不写死角色', () => {
  const page = read('features/domains/staff.js');
  const config = read('config/staffPage.js');
  assert.ok(page.includes("'attendance.write'"), '考勤编辑权限');
  assert.ok(page.includes("'staff.write'"), '人员编辑权限');
  assert.ok(page.includes("permissions || []).includes('attendance.write')"), '编辑按钮按权限');
  assert.ok(page.includes("permissions || []).includes('staff.write')"), '角色/在职按权限');
  assert.ok(page.includes('data-staff-from') && page.includes('data-staff-to'), '日期范围');
  assert.ok(page.includes('data-staff-form'), '时间段编辑表单');
  assert.ok(page.includes('api.delete'), '删除考勤');
});
