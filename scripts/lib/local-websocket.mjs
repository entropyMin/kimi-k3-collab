import { createHash, randomBytes } from "node:crypto";
import http from "node:http";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

function encodeFrame(opcode, value) {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  const mask = randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | payload.length;
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  header[0] = 0x80 | opcode;
  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    masked[index] = payload[index] ^ mask[index % 4];
  }
  return Buffer.concat([header, mask, masked]);
}

export class LocalWebSocket {
  constructor(socket, initialData = Buffer.alloc(0)) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.fragmentOpcode = null;
    this.fragments = [];
    this.fragmentBytes = 0;
    this.messages = [];
    this.waiters = [];
    this.closed = false;
    socket.on("data", (chunk) => this.#consume(chunk));
    socket.on("error", (error) => this.#finish(error));
    socket.on("close", () => this.#finish(new Error("Kimi WebSocket closed.")));
    if (initialData.length > 0) this.#consume(initialData);
  }

  sendJson(value) {
    this.socket.write(encodeFrame(0x1, JSON.stringify(value)));
  }

  async nextMessage(timeoutMs) {
    if (this.messages.length > 0) {
      return this.messages.shift();
    }
    if (this.closed) {
      throw new Error("Kimi WebSocket is closed.");
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item !== waiter);
        resolve(null);
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      this.socket.end(encodeFrame(0x8, Buffer.alloc(0)));
    } finally {
      this.#finish(new Error("Kimi WebSocket is closed."));
    }
  }

  #emit(message) {
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else {
      this.messages.push(message);
    }
  }

  #finish(error) {
    if (!this.closed) {
      this.closed = true;
    }
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  #consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const final = Boolean(first & 0x80);
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const wideLength = this.buffer.readBigUInt64BE(2);
        if (wideLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          this.#finish(new Error("Kimi WebSocket frame is too large."));
          return;
        }
        length = Number(wideLength);
        offset = 10;
      }
      if (length > MAX_FRAME_BYTES) {
        this.socket.destroy(new Error("Kimi WebSocket frame is too large."));
        return;
      }
      const maskLength = masked ? 4 : 0;
      if (this.buffer.length < offset + maskLength + length) return;
      const mask = masked ? this.buffer.subarray(offset, offset + 4) : null;
      offset += maskLength;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      this.buffer = this.buffer.subarray(offset + length);
      if (mask) {
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] ^= mask[index % 4];
        }
      }
      if (opcode === 0x8) {
        this.socket.end(encodeFrame(0x8, payload));
        this.#finish(new Error("Kimi WebSocket closed."));
        return;
      }
      if (opcode === 0x9) {
        this.socket.write(encodeFrame(0xa, payload));
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x0) {
        if (this.fragmentOpcode == null) continue;
        this.fragmentBytes += payload.length;
        if (this.fragmentBytes > MAX_FRAME_BYTES) {
          this.socket.destroy(new Error("Kimi WebSocket message is too large."));
          return;
        }
        this.fragments.push(payload);
        if (final) {
          this.#emit(Buffer.concat(this.fragments).toString("utf8"));
          this.fragmentOpcode = null;
          this.fragments = [];
          this.fragmentBytes = 0;
        }
        continue;
      }
      if (opcode !== 0x1) continue;
      if (final) {
        this.#emit(payload.toString("utf8"));
      } else {
        this.fragmentOpcode = opcode;
        this.fragments = [payload];
        this.fragmentBytes = payload.length;
      }
    }
  }
}

export function connectLocalWebSocket({ host, port, headers = {}, pathname = "/api/v1/ws", timeoutMs = 5000 }) {
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(host)) {
    throw new Error(`Refusing non-loopback WebSocket host: ${host}`);
  }
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString("base64");
    const request = http.request({
      host,
      port,
      path: pathname,
      headers: {
        ...headers,
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": key,
        "Sec-WebSocket-Version": "13"
      }
    });
    const timer = setTimeout(() => request.destroy(new Error("Kimi WebSocket handshake timed out.")), timeoutMs);
    request.once("upgrade", (response, socket, head) => {
      clearTimeout(timer);
      const expected = createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
      if (response.headers["sec-websocket-accept"] !== expected) {
        socket.destroy();
        reject(new Error("Kimi WebSocket handshake verification failed."));
        return;
      }
      const websocket = new LocalWebSocket(socket, head);
      resolve(websocket);
    });
    request.once("response", (response) => {
      clearTimeout(timer);
      response.resume();
      reject(new Error(`Kimi WebSocket upgrade failed with HTTP ${response.statusCode}.`));
    });
    request.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.end();
  });
}
