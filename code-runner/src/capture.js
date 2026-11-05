'use strict';

/**
 * Bounded sinks for what comes out of a container (design §9.1: results are
 * read out as capped byte streams; logs are cut to a 32 KiB head/tail per
 * step). Nothing a step prints can make the runner buffer more than these.
 */

const STEP_LOG_HEAD_BYTES = 32 * 1024;
const STEP_LOG_TAIL_BYTES = 32 * 1024;

/**
 * Keeps the first `headBytes` and the last `tailBytes` of a stream. Build
 * errors and failing assertions land at the end of a log, so the tail matters
 * as much as the head.
 */
class HeadTail {
  constructor({ headBytes = STEP_LOG_HEAD_BYTES, tailBytes = STEP_LOG_TAIL_BYTES } = {}) {
    this.headBytes = headBytes;
    this.tailBytes = tailBytes;
    this.head = [];
    this.headLength = 0;
    this.tail = [];
    this.tailLength = 0;
    this.totalBytes = 0;
  }

  write(chunk) {
    let buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.totalBytes += buf.length;
    const room = this.headBytes - this.headLength;
    if (room > 0) {
      const take = buf.subarray(0, room);
      this.head.push(Buffer.from(take));
      this.headLength += take.length;
      buf = buf.subarray(take.length);
    }
    if (buf.length === 0) return true;
    // Keep a copy so the caller's buffer can be reused.
    this.tail.push(Buffer.from(buf.length > this.tailBytes ? buf.subarray(buf.length - this.tailBytes) : buf));
    this.tailLength += Math.min(buf.length, this.tailBytes);
    if (this.tailLength > 2 * this.tailBytes) this.compactTail();
    return true;
  }

  compactTail() {
    const joined = Buffer.concat(this.tail);
    const keep = joined.subarray(Math.max(0, joined.length - this.tailBytes));
    this.tail = [Buffer.from(keep)];
    this.tailLength = keep.length;
  }

  /** Bytes currently held (bounded by head + 2 x tail + one chunk). */
  retainedBytes() {
    return this.headLength + this.tailLength;
  }

  snapshot() {
    const head = Buffer.concat(this.head);
    const joined = Buffer.concat(this.tail);
    const tail = joined.subarray(Math.max(0, joined.length - this.tailBytes));
    return { head, tail, totalBytes: this.totalBytes, omittedBytes: this.totalBytes - head.length - tail.length };
  }

  /** The JSON form a step record carries: text decoded as UTF-8. */
  toJSON() {
    const { head, tail, totalBytes, omittedBytes } = this.snapshot();
    const text = omittedBytes > 0
      ? `${head.toString('utf8')}\n[... ${omittedBytes} bytes omitted ...]\n${tail.toString('utf8')}`
      : Buffer.concat([head, tail]).toString('utf8');
    return { text, totalBytes, omittedBytes };
  }
}

/**
 * Keeps at most `maxBytes`; `write` returns false once more arrived, so the
 * reader can stop the producer.
 */
class Capped {
  constructor(maxBytes) {
    if (!Number.isInteger(maxBytes) || maxBytes < 0) throw new TypeError('maxBytes must be a non-negative integer');
    this.maxBytes = maxBytes;
    this.chunks = [];
    this.length = 0;
    this.totalBytes = 0;
    this.overLimit = false;
  }

  write(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.totalBytes += buf.length;
    const room = this.maxBytes - this.length;
    if (room > 0) {
      const take = buf.subarray(0, room);
      this.chunks.push(Buffer.from(take));
      this.length += take.length;
    }
    if (this.totalBytes > this.maxBytes) this.overLimit = true;
    return !this.overLimit;
  }

  bytes() {
    return Buffer.concat(this.chunks);
  }
}

/**
 * Keeps the first `maxBytes` of a stream and counts the rest, but never
 * stops the producer: `write` always returns true. For a step's output that
 * the runner reads (git's answers, forge's JUnit) while the program runs to
 * its own exit code. (Capped stops the producer, which suits `cat`, not a
 * program whose exit code matters: killing the docker CLI does not kill the
 * process inside the container.) `truncated` says bytes were dropped.
 */
class Prefix {
  constructor(maxBytes) {
    if (!Number.isInteger(maxBytes) || maxBytes < 0) throw new TypeError('maxBytes must be a non-negative integer');
    this.maxBytes = maxBytes;
    this.chunks = [];
    this.length = 0;
    this.totalBytes = 0;
  }

  get truncated() {
    return this.totalBytes > this.maxBytes;
  }

  write(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.totalBytes += buf.length;
    const room = this.maxBytes - this.length;
    if (room > 0 && buf.length > 0) {
      const take = buf.subarray(0, room);
      this.chunks.push(Buffer.from(take));
      this.length += take.length;
    }
    return true;
  }

  bytes() {
    return Buffer.concat(this.chunks);
  }
}

module.exports = { HeadTail, Capped, Prefix, STEP_LOG_HEAD_BYTES, STEP_LOG_TAIL_BYTES };
