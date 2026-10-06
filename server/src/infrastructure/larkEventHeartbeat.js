// 「最后一次收到飞书事件是什么时候」的记录器（内存 + 落一个本地小文件）。
//
// 为什么要有它：
//   业务负责人今天在飞书开放平台把【事件回调】的请求地址填错过，飞书报「Challenge code
//   没有返回」。侥幸没保存成功——**否则机器人就收不到群消息和卡片点击了，而且没有任何监控**，
//   可能几天后才发现"机器人不回话"，那几天漏的单子就丢了。
//   ⇒ 事件入口每收到一次请求就记一次时间；**过了多久没再收到**就是"机器人可能瞎了"的信号。
//
// 为什么"内存 + 文件"两份：
//   · 内存：health 端点每次都要读，不能每次读盘；
//   · 文件：**重启不丢**，否则每次发版重启都会把"长期没收到事件"重置成"刚收到"，
//     刚好把最该报警的场景掩盖掉。
//
// 为什么不用 JsonTaskStore：那个是"一条记录一个文件"的存储（按 id 建文件），
// 而这里只有**一份全局心跳**，两者形状不同；硬套会让心跳散成一堆文件。
//
// ⚠️ 这是**旁路观测**，不属于任何业务链路：它只记时间，不读写业务表，失败也绝不影响事件处理
//    （recordEvent 同步更新内存，落盘在后台做）。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { logWarn, logError } = require('../utils/logger');
const {
  resolveStaleMinutes,
  resolveHeartbeatFilePath,
  evaluateLarkEventHeartbeat,
} = require('../config/larkEventHeartbeat');

// 默认心跳文件：server/data/lark_event_heartbeat.json（server/data 已 gitignore）。
const DEFAULT_HEARTBEAT_FILE = path.join(__dirname, '../../data/lark_event_heartbeat.json');

// 落盘节流：事件可能成批到达（一次表单提交是多条记录变更），逐条写盘没必要。
// 内存**立刻**更新（health 读的是内存），文件最多落后几秒——对"几分钟/几小时没收到"的判定毫无影响。
const DEFAULT_DEBOUNCE_MS = 1000;

const emptyHeartbeat = () => ({ lastEventAt: null, lastBusinessEventAt: null });

/**
 * 读心跳文件。**宽容**：文件不存在 / 半截 / 坏 JSON 一律当作"没有数据"，
 * 绝不让 health 端点因此 500（监控自己崩掉比没有监控更糟）。
 */
const readHeartbeatFile = (filePath = DEFAULT_HEARTBEAT_FILE) => {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      lastEventAt: typeof parsed?.lastEventAt === 'string' ? parsed.lastEventAt : null,
      lastBusinessEventAt: typeof parsed?.lastBusinessEventAt === 'string' ? parsed.lastBusinessEventAt : null,
    };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logWarn('lark.heartbeat.file_unreadable', { file: filePath, error: error.message });
    }
    return emptyHeartbeat();
  }
};

const toIso = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  if (!Number.isFinite(ms)) return null;
  return date.toISOString();
};

// 只有更新的时间才覆盖（时钟回拨 / 乱序到达时不让心跳倒退）。
const laterIso = (candidate, current) => {
  if (!candidate) return current || null;
  if (!current) return candidate;
  return Date.parse(candidate) >= Date.parse(current) ? candidate : current;
};

class LarkEventHeartbeat {
  constructor(options = {}) {
    this.filePath = options.filePath || resolveHeartbeatFilePath() || DEFAULT_HEARTBEAT_FILE;
    this.now = options.now || (() => new Date());
    this.debounceMs = Number.isFinite(options.debounceMs) ? options.debounceMs : DEFAULT_DEBOUNCE_MS;
    this.state = options.initialState || readHeartbeatFile(this.filePath);
    this.pendingTimer = null;
    this.writeChain = Promise.resolve();
  }

  /**
   * 记一次「收到了事件」。
   * @param {boolean} business 是否**真正带业务内容**（challenge 验证不算；消息/卡片/自有多维表格变更算）
   * @param {Date|string} at   事件时间，默认此刻
   */
  recordEvent({ business = false, at } = {}) {
    const iso = toIso(at === undefined ? this.now() : at);
    if (!iso) return this.snapshot();
    this.state = {
      lastEventAt: laterIso(iso, this.state.lastEventAt),
      // 业务事件同时也是一次"到达"：即便调用方只报了 business，lastEventAt 也不会漏。
      lastBusinessEventAt: business ? laterIso(iso, this.state.lastBusinessEventAt) : this.state.lastBusinessEventAt,
    };
    this._scheduleFlush();
    return this.snapshot();
  }

  snapshot() {
    return { lastEventAt: this.state.lastEventAt, lastBusinessEventAt: this.state.lastBusinessEventAt };
  }

  /** 用**和 health 端点同一把尺子**判定当前状态。 */
  evaluate(options = {}) {
    return evaluateLarkEventHeartbeat(this.snapshot(), {
      staleMinutes: options.staleMinutes === undefined ? resolveStaleMinutes() : options.staleMinutes,
      now: options.now === undefined ? this.now() : options.now,
    });
  }

  _scheduleFlush() {
    if (this.debounceMs <= 0) {
      // 测试/脚本用：立刻排队落盘，用 flush() 等它。
      void this.flush();
      return;
    }
    if (this.pendingTimer) return;
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      this.flush().catch((error) => {
        logError('lark.heartbeat.write_failed', { file: this.filePath, error: error.message });
      });
    }, this.debounceMs);
    if (typeof this.pendingTimer.unref === 'function') this.pendingTimer.unref();
  }

  /** 等待所有排队中的落盘完成（脚本/测试用）。 */
  async flush() {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    const snapshot = this.snapshot();
    this.writeChain = this.writeChain.catch(() => undefined).then(() => this._write(snapshot));
    return this.writeChain;
  }

  async _write(snapshot) {
    const dir = path.dirname(this.filePath);
    await fs.promises.mkdir(dir, { recursive: true });
    // 先写同目录临时文件再 rename：rename 在同一文件系统上是原子的，
    // 读方（health / 自检脚本）不会读到写了一半的 JSON。
    const tempPath = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const payload = JSON.stringify({ ...snapshot, updatedAt: new Date().toISOString() }, null, 2);
    try {
      await fs.promises.writeFile(tempPath, payload, 'utf8');
      await fs.promises.rename(tempPath, this.filePath);
    } catch (error) {
      await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
    return snapshot;
  }
}

module.exports = {
  LarkEventHeartbeat,
  readHeartbeatFile,
  DEFAULT_HEARTBEAT_FILE,
  DEFAULT_DEBOUNCE_MS,
};
