"use strict";
/**
 * dshClient.js — DeepSeek Harness (DSH) loopback API client.
 *
 * Talks to the DSH Web instance over its documented /api carrier:
 *   - POST /api/<method>          unary RPC  (client-request / server-response)
 *   - POST /api/respond           approval / question answer (client-response)
 *   - WS   /api/events.mux        server→client event stream (approval/requested …)
 *
 * Zero runtime dependencies: HTTP uses global fetch (Node 18+), the WebSocket
 * downlink uses a small RFC 6455 client built on node:http.
 *
 * Protocol reference: doc/design.md in this repository.
 */

const http = require("node:http");
const crypto = require("node:crypto");

/** Error carrying an optional machine-readable code. */
class DshError extends Error {
  constructor(message, code = "error") {
    super(message);
    this.name = "DshError";
    this.code = code;
  }
}

/** Default ports probed when the extension is configured with port 0. */
const DEFAULT_PROBE_PORTS = [56231, 56232, 56230, 56233, 56229, 56234];

/** JSON envelope type constants (wire contract). */
const ENVELOPE = Object.freeze({
  CLIENT_REQUEST: "client-request",
  SERVER_RESPONSE: "server-response",
  SERVER_REQUEST: "server-request",
  CLIENT_RESPONSE: "client-response"
});

/**
 * Minimal RFC 6455 WebSocket client (text frames, masking, ping/pong, close,
 * continuation frames, fragmented messages). Server is a trusted loopback DSH.
 */
class MiniWebSocket {
  constructor(url, handlers) {
    this.url = url;
    this.handlers = handlers;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.closed = false;
    this.connecting = false;
  }

  connect() {
    if (this.connecting || (this.socket && !this.socket.destroyed)) return;
    this.connecting = true;
    const u = new URL(this.url);
    const key = crypto.randomBytes(16).toString("base64");
    const req = http.request({
      hostname: u.hostname,
      port: u.port === "" ? 80 : Number(u.port),
      path: `${u.pathname}${u.search}`,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": key
      }
    });
    req.on("upgrade", (_res, socket, head) => {
      this.connecting = false;
      this.socket = socket;
      socket.on("data", (chunk) => this.feed(chunk));
      socket.on("error", (err) => this.handlers.onError?.(err));
      socket.on("close", () => {
        const socketRef = this.socket;
        this.socket = null;
        this.buffer = Buffer.alloc(0);
        this.fragments = [];
        this.handlers.onClose?.(socketRef?.closeCode ?? 1006, socketRef?.closeReason ?? "");
      });
      if (head && head.length > 0) this.feed(head);
      this.handlers.onOpen?.();
    });
    req.on("error", (err) => {
      this.connecting = false;
      this.handlers.onError?.(err);
    });
    req.on("close", () => {
      if (this.connecting) {
        this.connecting = false;
        this.handlers.onClose?.(1006, "");
      }
    });
    req.end();
  }

  feed(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const frame = this.takeFrame();
      if (frame === null) break;
      this.handleFrame(frame);
      if (this.socket === null || this.socket.destroyed) break;
    }
  }

  takeFrame() {
    const buf = this.buffer;
    if (buf.length < 2) return null;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) return null;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return null;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new DshError("ws frame too large");
      len = Number(big);
      offset = 10;
    }
    let mask = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      mask = buf.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + len) return null;
    const payload = Buffer.from(buf.subarray(offset, offset + len));
    if (mask) {
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
    }
    this.buffer = buf.subarray(offset + len);
    return { fin, opcode, payload };
  }

  handleFrame(frame) {
    switch (frame.opcode) {
      case 0x0: {
        if (frame.fin) {
          const parts = [...this.fragments, frame.payload];
          this.fragments = [];
          this.emitMessage(Buffer.concat(parts));
        } else {
          this.fragments.push(frame.payload);
        }
        break;
      }
      case 0x1: {
        if (frame.fin) {
          this.emitMessage(frame.payload);
        } else {
          this.fragments = [frame.payload];
        }
        break;
      }
      case 0x8: {
        const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005;
        const reason = frame.payload.length > 2 ? frame.payload.subarray(2).toString("utf8") : "";
        try {
          this.sendFrame(0x8, frame.payload);
        } catch { /* socket already gone */ }
        this.closed = true;
        if (this.socket) {
          this.socket.closeCode = code;
          this.socket.closeReason = reason;
          this.socket.destroy();
        }
        break;
      }
      case 0x9:
        try { this.sendFrame(0xa, frame.payload); } catch { /* ignore */ }
        break;
      case 0x2:
      default:
        break;
    }
  }

  emitMessage(payload) {
    try {
      this.handlers.onMessage?.(payload.toString("utf8"));
    } catch (err) {
      this.handlers.onError?.(err);
    }
  }

  sendFrame(opcode, payload) {
    const socket = this.socket;
    if (!socket || socket.destroyed) throw new DshError("ws not open");
    const mask = crypto.randomBytes(4);
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    const maskedPayload = Buffer.from(payload);
    for (let i = 0; i < maskedPayload.length; i += 1) maskedPayload[i] ^= mask[i & 3];
    socket.write(Buffer.concat([header, mask, maskedPayload]));
  }

  sendText(text) {
    this.sendFrame(0x1, Buffer.from(text, "utf8"));
  }

  close(code = 1000, reason = "") {
    this.closed = true;
    try {
      const body = Buffer.alloc(2);
      body.writeUInt16BE(code, 0);
      this.sendFrame(0x8, Buffer.concat([body, Buffer.from(reason, "utf8")]));
    } catch { /* ignore */ }
    if (this.socket) this.socket.destroy();
    this.socket = null;
  }
}

/**
 * High-level DSH client: unary RPC + approval responding + mux event stream.
 */
class DshClient {
  constructor(options) {
    this.host = options.host || "127.0.0.1";
    this.port = options.port || 0;
    this.onFrame = options.onFrame;
    this.onConnectionChange = options.onConnectionChange;
    this.log = options.log || (() => {});
    this.rpcSeq = 0;
    this.connected = false;
    this.hostInfo = null;
    this.ws = null;
    this.wsStarted = false;
    this.reconnectTimer = null;
    this.reconnectDelayMs = 1000;
  }

  get baseUrl() {
    return `http://${this.host}:${this.port}`;
  }

  get muxUrl() {
    return `ws://${this.host}:${this.port}/api/events.mux`;
  }

  async discover() {
    if (this.port !== 0) {
      try {
        return await this.rpc("host.describe", {});
      } catch {
        return null;
      }
    }
    for (const port of DEFAULT_PROBE_PORTS) {
      try {
        const info = await this.rpc("host.describe", {}, { basePort: port });
        this.port = port;
        return info;
      } catch {
        // try next port
      }
    }
    return null;
  }

  async rpc(method, payload = {}, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 10000;
    const basePort = opts.basePort ?? this.port;
    if (basePort === 0) throw new DshError("DSH port is not configured", "not-configured");
    const rpcId = crypto.randomUUID();
    const body = JSON.stringify({
      type: ENVELOPE.CLIENT_REQUEST,
      rpcId,
      method,
      payload
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`http://${this.host}:${basePort}/api/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: controller.signal
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new DshError(`DSH API ${method} failed: HTTP ${res.status} ${text.slice(0, 200)}`, "http");
      }
      const envelope = await res.json();
      if (envelope.type !== ENVELOPE.SERVER_RESPONSE || envelope.rpcId !== rpcId) {
        throw new DshError(`DSH API ${method} returned an invalid envelope`, "protocol");
      }
      if (!envelope.result.ok) {
        const err = envelope.result.error ?? {};
        throw new DshError(`DSH API ${method}: ${err.message ?? "business error"}`, err.code ?? "business");
      }
      return envelope.result.value;
    } catch (err) {
      if (err instanceof DshError) throw err;
      if (controller.signal.aborted) throw new DshError(`DSH API ${method} timed out after ${timeoutMs}ms`, "timeout");
      throw new DshError(`DSH API ${method} transport error: ${err.message}`, "transport");
    } finally {
      clearTimeout(timer);
    }
  }

  async respondApproval(frame, outcome) {
    const payload = frame.payload;
    const body = JSON.stringify({
      type: ENVELOPE.CLIENT_RESPONSE,
      rpcId: frame.rpcId,
      result: {
        ok: true,
        value: {
          sessionId: payload.sessionId,
          approvalId: payload.approvalId,
          outcome
        }
      }
    });
    const res = await fetch(`${this.baseUrl}/api/respond`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body
    });
    if (!res.ok) throw new DshError(`respond failed: HTTP ${res.status}`, "http");
    return res.json();
  }

  async executeCommand(sessionId, line) {
    return this.rpc("commands/execute", { args: { agentId: sessionId, line } });
  }

  async listSessions() {
    const value = await this.rpc("session.list", {});
    return Array.isArray(value.items) ? value.items : [];
  }

  startMux() {
    if (this.wsStarted) return;
    this.wsStarted = true;
    this.connectMux();
  }

  connectMux() {
    const ws = new MiniWebSocket(this.muxUrl, {
      onOpen: () => {
        this.reconnectDelayMs = 1000;
        this.log(`mux 已连接 ${this.muxUrl}`);
      },
      onMessage: (text) => {
        let frame;
        try {
          frame = JSON.parse(text);
        } catch (err) {
          this.log(`mux 帧解析失败: ${err.message}`);
          return;
        }
        if (frame && frame.type === ENVELOPE.SERVER_REQUEST) {
          try {
            this.onFrame?.(frame);
          } catch (err) {
            this.log(`mux 帧处理失败: ${err.message}`);
          }
        }
      },
      onError: (err) => {
        this.log(`mux 错误: ${err.message}`);
      },
      onClose: () => {
        if (!this.wsStarted) return;
        if (!this.reconnectTimer) {
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connectMux();
          }, this.reconnectDelayMs);
          this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30000);
        }
      }
    });
    this.ws = ws;
    ws.connect();
  }

  stopMux() {
    this.wsStarted = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

module.exports = { DshClient, DshError, DEFAULT_PROBE_PORTS, MiniWebSocket };
