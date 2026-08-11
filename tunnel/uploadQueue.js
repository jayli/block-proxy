/**
 * 上行帧重排序队列（简化版 Xray upload_queue.go）
 *
 * 客户端通过多个独立 HTTP POST 发送上行帧，每个 POST 带一个递增的 seq。
 * 由于 HTTP 请求可能乱序到达，本队列按 seq 重排序后按序交付给消费方。
 *
 * 接口：
 *   push(seq, payload)   — 推入帧，按序触发交付
 *   async read()         — 按序读取下一帧（阻塞等待）
 *   close()              — 关闭队列，唤醒所有等待者
 */

'use strict';

class UploadQueue {
  /**
   * @param {number} maxBuffered — 最大乱序缓冲帧数（防止内存泄漏）
   */
  constructor(maxBuffered = 64) {
    /** @type {Array<{seq: number, payload: Buffer}>} min-heap by seq */
    this._heap = [];
    /** 下一个期望的 seq */
    this._nextSeq = 0;
    /** 已排序、等待消费的帧 */
    this._ready = [];
    /** 等待 read() 的 resolve 回调 */
    this._waiters = [];
    /** 队列是否已关闭 */
    this._closed = false;
    /** 最大乱序缓冲数 */
    this._maxBuffered = maxBuffered;
  }

  /**
   * 推入一帧。如果 seq 恰好是下一个期望的，立即交付；
   * 否则插入堆中等待。
   *
   * @param {number} seq — 帧序号（从 0 递增）
   * @param {Buffer} payload — 帧数据（含 2-byte length prefix）
   * @returns {boolean} 是否成功（队列已关闭时返回 false）
   */
  push(seq, payload) {
    if (this._closed) return false;

    // 乱序检查：太旧的帧丢弃（重复到达）
    if (seq < this._nextSeq) {
      return true; // 已消费过，静默丢弃
    }

    if (seq === this._nextSeq) {
      // 正好是下一个，立即交付
      this._deliver(payload);
      this._nextSeq++;

      // 检查堆中是否有连续的后续帧
      this._drainHeap();
    } else {
      // 乱序到达，插入堆
      if (this._heap.length >= this._maxBuffered) {
        console.warn(`[UploadQueue] Buffer overflow: ${this._heap.length} >= ${this._maxBuffered}, closing`);
        this.close();
        return false;
      }
      this._heapPush({ seq, payload });
    }

    return true;
  }

  /**
   * 按序读取下一帧。如果有已交付的帧立即返回，
   * 否则阻塞等待直到有帧到达或队列关闭。
   *
   * @returns {Promise<Buffer|null>} 帧数据，null 表示队列已关闭
   */
  async read() {
    // 先检查 ready 队列
    if (this._ready.length > 0) {
      return this._ready.shift();
    }

    if (this._closed) return null;

    // 等待新帧
    return new Promise((resolve) => {
      this._waiters.push(resolve);
    });
  }

  /**
   * 关闭队列，唤醒所有等待者。
   */
  close() {
    if (this._closed) return;
    this._closed = true;

    // 唤醒所有等待者
    const waiters = this._waiters.splice(0);
    for (const resolve of waiters) {
      resolve(null);
    }

    // 清空堆
    this._heap = [];
  }

  /** 队列中待消费的帧数 */
  get readyCount() {
    return this._ready.length;
  }

  /** 是否已关闭 */
  get closed() {
    return this._closed;
  }

  // ── 内部方法 ──────────────────────────────────────────────────────

  /**
   * 交付一帧到 ready 队列或直接给等待者。
   * @param {Buffer} payload
   */
  _deliver(payload) {
    const waiter = this._waiters.shift();
    if (waiter) {
      waiter(payload);
    } else {
      this._ready.push(payload);
    }
  }

  /**
   * 从堆中连续取出 seq 连续的帧并交付。
   */
  _drainHeap() {
    while (this._heap.length > 0 && this._heap[0].seq === this._nextSeq) {
      const frame = this._heapShift();
      this._deliver(frame.payload);
      this._nextSeq++;
    }
  }

  // ── Min-heap 操作（按 seq 排序）──────────────────────────────────

  _heapPush(item) {
    this._heap.push(item);
    this._heapBubbleUp(this._heap.length - 1);
  }

  _heapShift() {
    const top = this._heap[0];
    const last = this._heap.pop();
    if (this._heap.length > 0 && last) {
      this._heap[0] = last;
      this._heapBubbleDown(0);
    }
    return top;
  }

  _heapBubbleUp(i) {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this._heap[i].seq < this._heap[parent].seq) {
        [this._heap[i], this._heap[parent]] = [this._heap[parent], this._heap[i]];
        i = parent;
      } else {
        break;
      }
    }
  }

  _heapBubbleDown(i) {
    const n = this._heap.length;
    while (true) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < n && this._heap[left].seq < this._heap[smallest].seq) {
        smallest = left;
      }
      if (right < n && this._heap[right].seq < this._heap[smallest].seq) {
        smallest = right;
      }
      if (smallest !== i) {
        [this._heap[i], this._heap[smallest]] = [this._heap[smallest], this._heap[i]];
        i = smallest;
      } else {
        break;
      }
    }
  }
}

module.exports = UploadQueue;
