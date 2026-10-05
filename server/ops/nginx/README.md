# 服务器运维配置（Nginx）

这个目录存放**我们改动过的 Nginx 配置片段**。

## 为什么要放在仓库里

服务器上的 Nginx 配置**不在版本库里**。改在服务器上就等于：

- 没有记录，没人能 review
- 换机器 / 重装 / 迁服时**直接丢失**
- 下一个接手的人不知道服务器上被改过什么

所以凡是改动的部分，都在这里留一份，并写清怎么应用。

## 当前片段

| 文件 | 作用 | 服务器上的位置 |
| --- | --- | --- |
| `allowlist.conf` | **白名单公共基础片段**：ACME 校验放行 + 兜底 `location / { return 444; }`（不写访问日志） | `/etc/nginx/snippets/allowlist.conf` |
| `allowlist-api.conf` | `api.bamamei.online` 白名单（本项目 Express 应用，→ 127.0.0.1:5000） | `/etc/nginx/snippets/allowlist-api.conf` |
| `allowlist-workbench.conf` | `workbench.bamamei.online` 白名单（同一个 Express 应用） | `/etc/nginx/snippets/allowlist-workbench.conf` |
| `allowlist-meeting.conf` | `meeting.bamamei.online` 白名单（**不是本项目**，Next.js 容器 → 127.0.0.1:3011） | `/etc/nginx/snippets/allowlist-meeting.conf` |
| `proxy-meeting.conf` | meeting 站点的上游转发参数（被 `allowlist-meeting.conf` 里每条 location 复用） | `/etc/nginx/snippets/proxy-meeting.conf` |
| `block-scanners.conf` | **历史留档，已不再被任何 server 块 include**：2026-10-05 那一版黑名单 | 仅存档 |

## 白名单设计（2026-10-05 起）

### 为什么从黑名单改成白名单

黑名单（`block-scanners.conf`）只拒绝"已知的扫描路径"，**盖不全**：它匹配不到
`/.env` 的前缀变体，`/admin/.env`、`/config/.env`、`/api/.env` 之类照样打到应用。
实测改造前 8 小时内仍有 **1107 条垃圾请求**进到 Express（`/.env` 到应用返回 401，
`admin/.env` 这类 404），业务日志被埋掉。

白名单没有这个问题：**没写进白名单的路径默认拒绝**——`444`（不回任何响应、
直接断连接，curl 看到 http_code `000`）且 `access_log off`（不写访问日志）。

### location 优先级（改配置前必读）

```
1. location = /exact        精确匹配            ← 优先级最高
2. location ^~ /prefix/     前缀匹配（带 ^~）    ← 命中后不再尝试任何正则
3. location ~ ... / ~* ...  正则匹配            ← 按在配置里出现的先后顺序
4. location /prefix         普通前缀匹配        ← 取最长匹配的那一条
5. location /               普通前缀「兜底」    ← 优先级最低
```

兜底的 `location /` 抢不走 `=` 和 `^~` 的请求，所以"白名单 + 兜底 444"这个结构是
安全的。本方案**只用 `=` 和 `^~`**，不依赖"正则谁写在前面"，避免以后有人插一条
正则把规则顺序搞乱。

三个容易踩的坑：

- `^~ /workbench/` 只匹配带斜杠的 `/workbench/xxx`，匹配不到 `/workbench` 本身，
  所以要单独写一条 `location = /workbench`。
- 一个 server 块里**只能有一个 `location /`**，否则 `nginx -t` 报
  `duplicate location`（所以站点文件里不要自己再写 `location /`）。
- `include` 是纯文本展开：片段里的 location 就是这个 server 块的 location。

### 三个站点的白名单差异

| | `api.bamamei.online` | `workbench.bamamei.online` | `meeting.bamamei.online` |
| --- | --- | --- | --- |
| 上游 | 127.0.0.1:5000（本项目） | 127.0.0.1:5000（本项目） | 127.0.0.1:3011（Next.js 容器） |
| `/` | 应用首页（工作台 HTML 回落） | → 应用内 `/workbench/` | Next 307 → `/feishu-config` |
| `/health` | ✅ 健康检查 JSON | ❌ 改造前就是 404，不新增入口 | ❌ 不适用 |
| `/api/` | ✅ 整段（飞书回调 + 飞书登录 + 工作台接口 + 其余 API_KEY 保护接口）  | ✅ 整段（工作台登录与查询接口） | ❌ 逐条列（见下） |
| `/workbench/` | ✅（改造前该域名就能打开工作台） | ✅ 工作台静态资源 | — |
| 其它 | 全部 `444` | 全部 `444` | 按构建产物逐条列，其余 `444` |
| `/.well-known/acme-challenge/` | ✅ | ✅ | ✅（三个站点都放行，续期不能断） |

**meeting 为什么逐条列而不放行整段 `/api/`**：它是别的项目，白名单按它自己的
构建产物（容器内 `/app/.next/app-path-routes-manifest.json` 与 `/app/public/`）
定：页面 `/`、`/feishu-config`、`/login`、`/report[/<id>|/v2/<id>]`，静态
`/_next/`、`/file.svg` 等 5 个 public 文件，接口 `/api/auth/`、`/api/analyze[/…]`、
`/api/feishu/`、`/api/client-log`、`/api/feedback`、`/api/project-org-targets/active`。
**故意不写 `^~ /api/`**：整段放行会让 `/api/.env` 这类扫描路径又打到应用。

### 三个 server 文件改成了什么样

三个站点文件里的 `include …/block-scanners.conf;` 全部**替换**成对应的
`allowlist-*.conf`，同时**删掉原来手写的 `location /` 转发块**（白名单片段里已经
包含了这些 location；重复定义会让 `nginx -t` 报 duplicate location）：

- `/etc/nginx/sites-available/box2bitable`（api 的 443 + 80 两个 server 块）
- `/etc/nginx/sites-available/meeting.bamamei.online`（meeting 的 443 + 80 两个 server 块）
- `/etc/nginx/sites-enabled/workbench.conf`（`:80 default_server` + workbench 443 + workbench 80）

每个 443 块最终就是「`include` 白名单片段 + `server_name` + 证书四行」。

**`:80 default_server`（裸 IP，`server_name _`）**：`include allowlist.conf;`，
即"只放行 `/.well-known/acme-challenge/`，其余 444"。它原来的
`root /var/www/html + location / { try_files …; }`（会 403）已删除，
`location /` 由片段提供。

**两个 Certbot 的 `:80` 重定向块（api / meeting / workbench）**：保持原样、**不加**
白名单，只把黑名单 include 去掉。原因：块里的
`if ($host = …) { return 301 https://…; }` 在 server 级 rewrite 阶段执行，**早于
location 匹配**，所有请求（包括 ACME 校验）都会被 301 到 HTTPS，白名单在这里是
死代码。改造前那个黑名单 include 在这两个块里同样是死代码
（实测 `http://api.bamamei.online/.env` 返回 301，不是 444）。

**ACME 与证书续期**：certbot 用的是 nginx 插件（`authenticator = nginx`，见
`/etc/letsencrypt/renewal/*.conf`），续期时它会自己临时注入校验用的 server 块。
由于上面那条 `:80` 的 301 会把 challenge 也重定向到 HTTPS，`allowlist.conf` 里
**在 HTTPS 侧也放行了** `/.well-known/acme-challenge/`（`root /var/www/html`，
`try_files $uri =404`）。改造前该路径在 HTTPS 侧被转发给应用、返回 404——等于
续期只能靠 certbot 临时注入这一条路；现在两条路都能过。

## 怎么应用（新机器 / 重装时照做）

```bash
# 1 备份（改之前永远先备份）
sudo mkdir -p /etc/nginx/backups
sudo tar czf /etc/nginx/backups/nginx-conf.$(date +%Y%m%d-%H%M%S).tar.gz \
  -C /etc nginx/nginx.conf nginx/sites-enabled nginx/sites-available nginx/conf.d

# 2 放片段（5 个）
sudo cp server/ops/nginx/allowlist.conf           /etc/nginx/snippets/
sudo cp server/ops/nginx/allowlist-api.conf       /etc/nginx/snippets/
sudo cp server/ops/nginx/allowlist-workbench.conf /etc/nginx/snippets/
sudo cp server/ops/nginx/allowlist-meeting.conf   /etc/nginx/snippets/
sudo cp server/ops/nginx/proxy-meeting.conf       /etc/nginx/snippets/

# 3 改三个站点文件
#   把 `include …/block-scanners.conf;` 换成对应的 allowlist-*.conf，
#   并删掉原来手写的 location / 转发块（见上面「三个 server 文件改成了什么样」）：
#     /etc/nginx/sites-available/box2bitable            → allowlist-api.conf
#     /etc/nginx/sites-available/meeting.bamamei.online → allowlist-meeting.conf
#     /etc/nginx/sites-enabled/workbench.conf           → allowlist-workbench.conf
#                                                        + default_server 用 allowlist.conf

# 4 校验（必须先校验；不通过就回滚，绝不 reload）
sudo nginx -t

# 5 生效（reload 不中断现有连接，不要用 restart）
sudo systemctl reload nginx
```

回滚：

```bash
sudo tar xzf /etc/nginx/backups/nginx-conf.<时间戳>.tar.gz -C /etc
sudo nginx -t && sudo systemctl reload nginx
```

## 怎么验证生效

```bash
# 真实入口必须照常
curl -sS https://api.bamamei.online/health                       # → JSON
curl -sS https://api.bamamei.online/api/lark/events/health       # → JSON（飞书回调健康检查）
curl -sS -o /dev/null -w '%{http_code}\n' https://workbench.bamamei.online/            # → 200
curl -sS -o /dev/null -w '%{http_code}\n' https://workbench.bamamei.online/workbench/main.js  # → 200（静态资源，404 就是白屏）

# meeting 保持改造前行为
curl -sS -o /dev/null -w '%{http_code}\n' https://meeting.bamamei.online/               # → 307

# 白名单之外的必须被断开（HTTP 000 = 444 断连接，不是超时；且不该有新的访问日志）
for p in /.env /admin/.env /robots.txt /some/random/path; do
  curl -sS -o /dev/null -w "$p %{http_code}\n" -k "https://api.bamamei.online$p"
done

# 确认真实入口没被挡（飞书 URL 验证用的 challenge 回显）
curl -sS -X POST -H 'Content-Type: application/json' \
  -d '{"challenge":"probe"}' https://api.bamamei.online/api/lark/events   # → {"challenge":"probe"}
```

## ⚠️ 加新入口时要记得加白名单

**这是白名单方案唯一的使用成本**：应用新增一个页面、静态资源目录或接口前缀时，
必须回到对应的 `allowlist-*.conf` 加一条 location，再 `nginx -t` + `reload`。
否则新入口会被兜底的 `444` 挡掉，现象是**连不上（000）而不是 404**，很容易被当成
"应用挂了"去排查半天。

需要特别留意的改动：

- 工作台新增静态目录时，确认它在 `/workbench/` 前缀下（整段已放行），否则要加条目。
- meeting 是别的项目、改它不经过我们，**它新增页面/接口时必须同步加白名单**。
- 换 ACME 的 webroot 目录时，`allowlist.conf` 里的 `root /var/www/html` 要一起改。

## 另一个相关的加固：应用只监听回环

Nginx 转发到 `127.0.0.1:5000`，所以 node **不应该**监听所有网卡。
`app.listen(port)` 会绑 `0.0.0.0`（等于绕过 Nginx 把 Express 暴露出去），
已在代码里改为 `app.listen(port, HOST)`，`HOST` 默认 `127.0.0.1`（见 `src/app.js`）。

验证：

```bash
sudo ss -tlnp | grep :5000     # 必须是 127.0.0.1:5000，不是 *:5000 或 0.0.0.0:5000
```
