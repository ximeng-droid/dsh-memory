import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { extractConversation, firstUser } from './sessions.js';

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/** 把多帧 zstd 拼起来解压成 Buffer（宿主每一批都是独立帧） */
export function decodeZstdFrames(buf) {
  const parts = [];
  let i = 0;
  while (i <= buf.length - 4) {
    const isMagic = buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3];
    if (!isMagic) { i += 1; continue; }
    let j = buf.length;
    for (let k = i + 4; k <= buf.length - 4; k += 1) {
      if (buf[k] === MAGIC[0] && buf[k + 1] === MAGIC[1] && buf[k + 2] === MAGIC[2] && buf[k + 3] === MAGIC[3]) { j = k; break; }
    }
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(i, j))); } catch { /* 半截帧跳过 */ }
    i = j;
  }
  return Buffer.concat(parts);
}

/** 宿主会话目录：<dshHome>/sessions/<工作区>/<会话id>/session.v4.jsonl.zstd */
export function listHostSessions(dshHome, { maxBytes = 40 * 1024 * 1024 } = {}) {
  const root = path.join(dshHome, 'sessions');
  const out = [];
  let workspaces = [];
  try { workspaces = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return out; }
  for (const ws of workspaces) {
    const wsDir = path.join(root, ws.name);
    let sessions = [];
    try { sessions = fs.readdirSync(wsDir, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { continue; }
    for (const s of sessions) {
      const file = path.join(wsDir, s.name, 'session.v4.jsonl.zstd');
      try {
        const st = fs.statSync(file);
        if (st.size === 0 || st.size > maxBytes) continue;
        out.push({ id: s.name, workspace: ws.name, file, bytes: st.size, mtime: st.mtime.toISOString() });
      } catch { /* 没有会话文件 */ }
    }
  }
  return out.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
}

/** 读一个宿主会话，抽出真人对话（只认 user/message 与 assistant/message 的 text 部分） */
export function readHostSession(file, { isInjected = () => false, max = 400 } = {}) {
  const raw = decodeZstdFrames(fs.readFileSync(file));
  const events = [];
  for (const line of raw.toString('utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const rec = JSON.parse(s);
      if (rec?.type) events.push({ type: rec.type, time: rec.time, data: rec.data });
    } catch { /* 坏行跳过 */ }
  }
  const records = extractConversation(events, { isInjected, max });
  const title = firstUser(events, { isInjected }).slice(0, 40);
  return { records, title, events: events.length };
}
