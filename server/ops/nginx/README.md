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
| `block-scanners.conf` | 拒绝互联网扫描器探测（`/.env`、`/wp-config.php` 等），并且不写访问日志 | `/etc/nginx/snippets/block-scanners.conf` |

### 背景：为什么需要它

服务器暴露在公网后，会被**无差别扫描**——脚本自动找配置文件，密度实测约 **3.5 次/秒、24 小时不间断**：

```text
/.env  /.env.bak  /.env.old  /wp-config.php  /docker-compose.yml
/k8s/secrets  /root/.aws/credentials  /phpunit/eval-stdin.php  ...
```

这些请求原本会被转发到 node 应用，把业务日志埋掉——2026-10-04 排查一笔销售单时，
就是在几千条垃圾里翻出来的。加上这个片段之后：**5 分钟只剩 6 条真实请求，扫描器类 0 条**。

## 怎么应用（新机器 / 重装时照做）

```bash
# 1 备份（改之前永远先备份）
sudo mkdir -p /etc/nginx/backups
sudo tar czf /etc/nginx/backups/nginx-conf.$(date +%Y%m%d-%H%M%S).tar.gz \
  -C /etc nginx/nginx.conf nginx/sites-enabled nginx/sites-available nginx/conf.d

# 2 放片段
sudo cp server/ops/nginx/block-scanners.conf /etc/nginx/snippets/block-scanners.conf

# 3 在每个需要保护的 server 块里 include 它（插在 `server {` 之后即可）
#   本部署涉及这三个文件：
#     /etc/nginx/sites-available/box2bitable            （api.bamamei.online）
#     /etc/nginx/sites-available/meeting.bamamei.online （meeting.bamamei.online）
#     /etc/nginx/sites-enabled/workbench.conf           （workbench + 默认 server）
#   要加的行：
#     include /etc/nginx/snippets/block-scanners.conf;

# 4 校验（一定要先校验，语法错会让 nginx 起不来）
sudo nginx -t

# 5 生效（reload 不中断现有连接，不要用 restart）
sudo systemctl reload nginx
```

## 怎么验证生效

```bash
# 真实入口必须照常
curl -sS https://api.bamamei.online/health          # → JSON
curl -sS -o /dev/null -w '%{http_code}\n' https://workbench.bamamei.online/   # → 200

# 扫描路径必须被断开（HTTP 000 = 连接被 444 断掉，不是超时）
curl -sS -o /dev/null -w '%{http_code}\n' -k https://api.bamamei.online/.env  # → 000
```

## 另一个相关的加固：应用只监听回环

Nginx 转发到 `127.0.0.1:5000`，所以 node **不应该**监听所有网卡。
`app.listen(port)` 会绑 `0.0.0.0`（等于绕过 Nginx 把 Express 暴露出去），
已在代码里改为 `app.listen(port, HOST)`，`HOST` 默认 `127.0.0.1`（见 `src/app.js`）。

验证：

```bash
sudo ss -tlnp | grep :5000     # 必须是 127.0.0.1:5000，不是 *:5000 或 0.0.0.0:5000
```
