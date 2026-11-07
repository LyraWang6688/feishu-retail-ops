# 用 iPhone 镜像 + 相册二维码做真实端到端测试（2026-11-07）

> 适用场景：需要在**真实 iPhone** 上走扫码销售页，但 iPhone 镜像里**相机不可用**
> （提示 `iPhone camera is not available from Mac`），用「相册里的二维码」代替现场扫码。
>
> 本文只描述 **UI 自动化 + 测试**，不涉及手机相册数据 API、不授权删除照片。

## 一、前提

| 项 | 要求 |
|---|---|
| 手机 | iPhone，已开启 iPhone 镜像并在 Mac 上完成连接 |
| Mac | 已安装并运行「iPhone Mirroring」 |
| 权限 | 终端 / DSH 具备「屏幕录制」与「辅助功能」权限 |
| 工具 | `osascript`、`screencapture`、`cliclick`、`ffmpeg`（本机已具备） |
| 测试数据 | 二维码图片由业务负责人提前存进手机相册；或由 Mac 侧导出后人工存入 |
| 环境 | 明确是测试 Base 还是生产 Base；**生产 Base 提交会生成真实销售单** |

## 二、正确操作路径（手机镜像）

从手机工作台开始：

```text
工作台
→ 销售
→ 鞋类
→ 扫一扫（会提示 iPhone camera is not available from Mac）
→ 点 OK
→ 点底部「相册」
→ 在「最近项目」里选二维码图片
→ 自动打开对应扫码页（标题形如「0225 · 扫码」）
```

关键点：

- **不要**直接去 Photos 里找二维码后点 Live Text；这条路径不会进入扫码页。
- 正确入口是**扫码页自己的「相册」按钮**。
- 镜像中相机不可用是预期行为；相册路径就是替代方案。

## 三、Mac 侧自动化命令

以下命令只操作 iPhone Mirroring 窗口，不直接读写手机相册。

### 1. 读取窗口位置与大小

```bash
osascript -e 'tell application "System Events" to tell process "iPhone Mirroring" to get {position of window 1, size of window 1}'
```

典型结果：

```text
905, 32, 361, 795
```

### 2. 截图

```bash
screencapture -x -R905,32,361,795 /tmp/iphone.png
```

### 3. 坐标换算

`-R` 截图是 2 倍图（例如 722×1590），Mac 窗口是 361×795：

```text
Mac 横坐标 = 窗口 x + 手机截图横坐标 / 2
Mac 纵坐标 = 窗口 y + 手机截图纵坐标 / 2
```

例如手机截图里点「相册」按钮在 `(360, 1465)`：

```bash
cliclick c:1085,764
```

### 4. 点击 / 输入

```bash
cliclick c:1085,764          # 单击
cliclick dc:1085,764         # 双击
cliclick t:"文本"            # 输入
```

### 5. 回到主屏

菜单方式最稳：

```bash
osascript -e 'tell application "System Events" to tell process "iPhone Mirroring" to click menu item "Home Screen" of menu 1 of menu bar item "View" of menu bar 1'
```

## 四、录制真实操作路径（学习 / 复盘）

```bash
# 开始录制 iPhone Mirroring 窗口（后台运行）
screencapture -v -R905,32,361,795 /tmp/iphone-path.mov
```

操作结束后停止录制（Ctrl+C，或对进程发 SIGINT）：

```bash
kill -INT <screencapture_pid>
```

拆帧：

```bash
ffmpeg -v error -i /tmp/iphone-path.mov -vf fps=1 /tmp/iphone-frames/f%03d.png
```

生成缩略图拼图，快速定位路径：

```bash
ffmpeg -v error -i /tmp/iphone-path.mov -vf "fps=1,scale=180:-1,tile=5x6" -frames:v 1 /tmp/iphone-path-contact.png
```

## 五、进入扫码页后的端到端测试

进入扫码页后，按业务要求填写：

```text
选择尺码
→ 填写实收金额（如页面要求）
→ 提交
```

提交后必须同时检查：

```text
1. 手机镜像页面是否出现成功 toast
2. 后台是否收到 scan.session / scan.page / 提交日志
3. 生产 / 测试 Base 是否产生对应销售单、明细、收款、库存流水
```

### 安全边界

- **生产 Base 只在业务负责人明确要求时提交真实测试单**；
- 能用测试 Base 的，优先测试 Base；
- 提交前确认货号、尺码、金额、环境；
- 不做批量提交，不伪造数据。

## 六、清理手机相册（明确不做自动删除）

iPhone 镜像只能看到屏幕，读不到相册数据库；删除照片属于不可逆操作。

正确流程：

```text
截图/预览候选
→ 人工确认
→ 手动删除
```

禁止：

```text
自动点删除
自动清空相册
按文件名/日期批量删除
```

## 七、常见问题

| 现象 | 处理 |
|---|---|
| `iPhone camera is not available from Mac` | 正常，走扫码页底部「相册」 |
| 点击没反应 | 先 `activate` iPhone Mirroring，再确认窗口坐标未变 |
| 截图尺寸与窗口不一致 | 按 2 倍图换算；先打印窗口位置和截图尺寸 |
| 相册选图后没进扫码页 | 确认选中的是二维码图片，不是普通截图 |
| 页面停在旧状态 | 用 View → Home Screen 回主屏，重新走路径 |
| 提交后后台无日志 | 先看手机页面 toast/错误，再查 PM2 日志，不要重复提交 |

## 八、给其他 Agent 的检查清单

```text
[ ] iPhone Mirroring 正在运行，窗口可见
[ ] 读取窗口位置/大小，截图成功
[ ] 确认走「扫码页 → 相册」而不是 Photos Live Text
[ ] 确认二维码图片对应测试货品
[ ] 确认目标 Base 是测试还是生产
[ ] 提交前获得明确授权
[ ] 提交后同时核对页面 + 后台日志 + Base
[ ] 不自动删除手机照片
```
