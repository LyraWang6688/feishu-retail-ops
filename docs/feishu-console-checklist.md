# 飞书开放平台配置清单（业务负责人照着做）

> ⭐ **为什么有这个文件**：三个地址、三个不同的位置，**放错的后果很重**（其中一条会让机器人哑掉）。
> 2026-10-06 已因此踩过一次：把「网页登录回调」填进了「事件回调」，飞书报
> 「Challenge code 没有返回」。

## ⚠️ 一句话：三个地址，三个位置，别放错

| 要填的地址 | 填在【哪个位置】 | 放错的后果 |
| --- | --- | --- |
| `https://api.bamamei.online/api/lark/events` | 【事件与回调 → 回调配置 → 请求地址】 | 🔴 **机器人收不到消息和卡片点击** |
| `https://workbench.bamamei.online/api/auth/feishu/callback` | 【安全设置 → 重定向 URL 白名单】 | 🔴 工作台登录被弹到飞书报错页 |
| `https://workbench.bamamei.online/workbench/` | 【应用功能 → 网页应用 → 主页地址】<br>＋【聊天框 "+" 菜单 → 跳转链接（移动端）】 | 🔴 聊天框菜单点不开工作台 |

## ⭐ 怎么分辨你正在看哪个页面

- 看到「**订阅方式 / 将回调发送至开发者服务器**」→ 那是**【事件回调】**
  → 填 `api.bamamei.online/api/lark/events`
- 看到「**重定向 URL / OAuth / 安全设置**」→ 那是**【登录回调】**
  → 填 `workbench.bamamei.online/api/auth/feishu/callback`
- 看到「**主页地址 / 可信域名**」→ 那是**【网页应用】**
  → 填 `workbench.bamamei.online/workbench/`

## ⚠️ 两个域名的区别（最容易混）

- `api.bamamei.online` —— **机器人收消息用的**（飞书推给我们）
- `workbench.bamamei.online` —— **工作台网页用的**（她在浏览器里打开）

## 🔴 填错的信号（看到就停手，别点保存）

- 【事件回调】填错 → 飞书报「**Challenge code 没有返回**」
  → ⚠️ **别保存**，改回 `api.bamamei.online/api/lark/events`
- 【重定向 URL】没配 → 工作台登录后跳飞书报错页
  （代码里那句提示是「飞书登录未完成（可能是应用回调地址未配置）」）
- 【网页应用】没配 → 聊天框菜单报「链接格式与指向的应用不正确」

## ⭐ 做完全部之后建议验一遍

1. 群里 @机器人 说一句话 → 机器人应有「收到」表情（**证明事件回调是通的**）
2. 浏览器打开 `https://workbench.bamamei.online/workbench/` → 能进工作台
3. 飞书聊天框点 "+" → 能看到工作台入口并能打开
