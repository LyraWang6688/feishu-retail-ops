class KeyedSerialQueue {
  constructor() {
    this.queues = new Map();
  }

  run(key, work) {
    if (!key) throw new Error('串行任务缺少 key');
    const previous = this.queues.get(key) || Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.queues.set(key, next);
    const cleanup = () => {
      if (this.queues.get(key) === next) this.queues.delete(key);
    };
    next.then(cleanup, cleanup);
    return next;
  }
}

module.exports = { KeyedSerialQueue };
