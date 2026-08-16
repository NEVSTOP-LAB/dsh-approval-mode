#!/usr/bin/env node
/**
 * listen-only.mjs — 只监听 DSH mux 事件流中的审批帧（不应答）。
 * 用于验证「绕过审批」模式下 approval/requested 是否被 Host 应答器抢先拦截。
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
const require = createRequire(import.meta.url);
const clientPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "./dshClient.js");
const { DshClient } = require(clientPath);

const port = Number(process.argv[2] ?? 56231);
const client = new DshClient({ host: "127.0.0.1", port, log: (m) => console.log("[probe-log]", m) });

let asked = 0;
let requested = 0;
let decided = 0;
const timer = setTimeout(() => {
  console.log(`[listen] 超时退出：asked=${asked} requested=${requested} decided=${decided}`);
  client.stopMux();
  process.exit(0);
}, 90000);

client.onFrame = (frame) => {
  const p = frame.payload;
  if (!p || typeof p !== "object") return;
  if (p.type === "session/event" && p.event?.type === "approval/asked") {
    asked += 1;
    console.log(`[listen] approval/asked: ${JSON.stringify(p.event.data)}`);
  } else if (p.type === "approval/requested") {
    requested += 1;
    console.log(`[listen] approval/requested 帧出现（绕过未生效！）: ${JSON.stringify(p)}`);
  } else if (p.type === "session/event" && p.event?.type === "approval/decided") {
    decided += 1;
    console.log(`[listen] approval/decided: ${JSON.stringify(p.event.data)}`);
  }
};

client.startMux();
console.log("[listen] 监听中：等待审批事件…");
