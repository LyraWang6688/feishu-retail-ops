# 侧边栏「待确认」插件 —— 交接规格（可直接发给别的 AI 做）

**目标**：把「需要业务负责人拍板的事」放进**侧边栏面板**（需要时弹窗），她点「同意/不同意」把结果写回 ⇒ 不再被会话轮数淹没。

## 一、插槽坐标（用运行时 Inspect 查证过 ✓ 不是猜的）

| 放什么 | 用哪个 Slot | 注册参数 |
| --- | --- | --- |
| 侧边栏的**面板图标** | **`sidebar.panellist`**（list） | 需 `id` |
| 侧边栏页脚一个按钮 | `sidebar.footer.action`（list） | 需 `id` |
| 设置里一个整页 | `settings.section`（list） | 需 `id` |
| **弹窗 / 浮层**（跨整帧） | **`shell.overlay`**（list） | 需 `id` |
| 面板内容（中央） | `main`（keyed） | 需 `key`（`conversation` 已被占 ⇒ 自取新 key） |

**作用域**：`scope:"root"` = **整个界面（所有会话都看得到）** ✓ ← 要这个；`scope:"session"` = 只当前会话 ✗

## 二、怎么变成「全软件都有」
把它打成 **bundle** 后做 profile 级安装：`plugin_manager install_bundle { target: "<包名或本地 bundle 路径>" }`
（其说明逐字：「**Changes affect every session in this profile**」✓）
- 装/卸需要**当次批准**（本会话「批准弹窗已禁用」⇒ 需她手动批准或改策略 ✓）
- 客户端改动：**HMR 只在同一 checkout 同时跑 `pnpm run dev:web` 时自动重载** ✓ 否则**刷新页面** ✓
- 只改客户端插件 ⇒ **不需要重启服务** ✓

## 三、MVP（先做这个，别做大 ✗）
1. **数据源**：先读工作区一份文件（如 `docs/pending-confirmations.md`：每条 = 背景一句话 ＋ 选项 ＋ 「你的选择」栏）
2. **面板**：`sidebar.panellist` 注册图标（未决 > 0 给**角标数字**）⇒ 点开在 `main` 用新 key 渲染清单；每条给 **同意 / 不同意 / 其它（备注框）**
3. **回写**：点选项 ⇒ 写回文件的「你的选择」栏（进阶再接 Host Service）
4. **提醒**：未决且**卡住**时在 `shell.overlay` 弹**一次**（可关，不纠缠 ✓）

## 四、验收（**能真红** ✓ 照本仓纪律）
- 清单空 ⇒ 面板显示「暂无待确认」且**无角标** ✓
- 有 1 条 ⇒ 角标 = 1 ✓；点「同意」⇒ 文件里该条被写成「同意」＋ 角标 −1 ✓
- **塞回一条已答复的 ⇒ 不许再出现在未决列表**（反向钉住 ✓）
- 弹窗**同一会话只弹一次** ✓
- 探针：把「角标 / 回写 / 去重」任一删掉 ⇒ 对应判据红 ✓

## 五、红线
不改业务 Service · 不动 `server/**` · 不写生产 Base · **不自行部署** · 主题色用主题 token（不写死颜色 ✗）

## 六、自查用的 Inspect 方法
```
cordis_inspect_list
cordis_inspect_query {platform:"client", provider:"Slots", method:"listSubTree"}   # 插槽与注册参数
cordis_inspect_query {platform:"client", provider:"Theme", method:"listTokens"}    # 主题 token
cordis_inspect_query {platform:"host",   provider:"Service", method:"listService"} # 可用 Host Service
```

## 七、已生效的替代方案（不必等插件 ✓）
工作区已有 `docs/pending-confirmations.md`（每条含「你的选择」栏）＋ Lead 每次回话**把清单放最上面**＋ **要她拍板就弹窗**（本会话已在用 ✓）。
