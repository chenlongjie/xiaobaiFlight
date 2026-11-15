// flight-real 联机中继服务器（零依赖，node server.mjs [port]）
// 只有职责：转发"玩家状态"。世界是确定性的，每个客户端本地生成，服务器不需要知道地形。
// 协议（JSON 文本帧）：
//   客户端 → {t:'join', name}              加入
//           {t:'state', d:[x,y,z,yaw,pitch,roll,speed]}   状态（客户端权威，15Hz）
//           {t:'hb'}                       心跳（每 20s）
//   服务器 → {t:'welcome', id, peers:[{id,name,d}]}        加入成功 + 现有玩家
//           {t:'peer_join', id, name, d}   有新玩家进来
//           {t:'p', id, d}                 某玩家状态
//           {t:'peer_leave', id}           某玩家离开
import {createServer} from 'node:http';
import {createHash,randomBytes} from 'node:crypto';

const port = parseInt(process.argv[2] || '8791', 10);
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const STALE_MS = 90000;   // 超过 90s 没任何消息视为掉线
const clients = new Map(); // ws socket -> {id,name,d,lastSeen}

const server = createServer((_req, res) => {
  res.writeHead(200, {'content-type': 'text/plain;charset=utf-8'});
  res.end('flight-real relay is running. Connect WebSocket to this port.\n');
});

/* ---------- 帧编解码（服务器端只处理客户端的掩码帧，发送不需要掩码） ---------- */
function frame(opcode, payload) { // payload: Buffer
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode; header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode; header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function sendText(ws, obj) { ws.write(frame(0x1, Buffer.from(JSON.stringify(obj)))); }

function broadcast(obj, except) {
  for (const ws of clients.keys()) if (ws !== except) sendText(ws, obj);
}

/* ---------- 收帧：累积缓冲 + 状态机，逐条吐完整帧 ---------- */
function onData(conn, chunk) {
  conn.buf = Buffer.concat([conn.buf, chunk]);
  conn.lastSeen = Date.now();
  for (;;) {
    const b = conn.buf;
    if (b.length < 2) return;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) {
      if (b.length < 10) return;
      const big = b.readBigUInt64BE(2);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) { conn.socket.destroy(); return; }
      len = Number(big); off = 10;
    }
    const masked = (b[1] & 0x80) !== 0;
    let mask;
    if (masked) { if (b.length < off + 4) return; mask = b.subarray(off, off + 4); off += 4; }
    if (b.length < off + len) return;
    let payload = b.subarray(off, off + len);
    if (masked) { payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]; }
    conn.buf = b.subarray(off + len);
    handleFrame(conn, fin, opcode, payload);
    if (conn.closed) return;
  }
}

/* ---------- 帧处理（支持分片拼接，浏览器把小于 64KB 的文本通常直接一帧发出） ---------- */
function handleFrame(conn, fin, opcode, payload) {
  if (opcode === 0x8) {                       // close：回 close 帧再断
    conn.socket.end(frame(0x8, payload.subarray(0, 2)));
    leave(conn);
    return;
  }
  if (opcode === 0x9) { conn.socket.write(frame(0xA, payload)); return; } // ping -> pong
  if (opcode === 0xA) return;                 // pong 忽略
  if (opcode === 0x0) {                       // 续帧
    conn.frag = Buffer.concat([conn.frag || Buffer.alloc(0), payload]);
    if (fin) {
      const total = conn.frag; conn.frag = null;
      handleText(conn, total.toString('utf8'));
    }
    return;
  }
  if (opcode === 0x1) {                       // 文本帧
    if (!fin) { conn.frag = Buffer.concat([(conn.frag || Buffer.alloc(0)), payload]); return; }
    handleText(conn, payload.toString('utf8'));
    return;
  }
  // 0x2 二进制等一律忽略
}

function handleText(conn, text) {
  let msg;
  try { msg = JSON.parse(text); } catch { return; }

  if (conn.id === null && msg.t === 'join') {
    conn.id = randomBytes(4).toString('hex');
    conn.name = String(msg.name || '旅人').slice(0, 24);
    conn.d = Array.isArray(msg.d) ? msg.d.map(Number) : [0, 46, 0, Math.PI, 0, 0, 14];
    sendText(conn.socket, {
      t: 'welcome', id: conn.id,
      peers: [...clients.values()].map(c => ({id: c.id, name: c.name, d: c.d})),
    });
    clients.set(conn.socket, conn);
    broadcast({t: 'peer_join', id: conn.id, name: conn.name, d: conn.d}, conn.socket);
  } else if (conn.id !== null && msg.t === 'state' && Array.isArray(msg.d) && msg.d.length >= 6) {
    conn.d = msg.d.slice(0, 7).map(Number);
    broadcast({t: 'p', id: conn.id, d: conn.d}, conn.socket);
  }
  // 'hb' 只用来刷新 lastSeen（已在 onData 处理），无需发消息
}

function leave(conn) {
  if (conn.closed) return;
  conn.closed = true;
  if (clients.has(conn.socket)) {
    clients.delete(conn.socket);
    if (conn.id !== null) broadcast({t: 'peer_leave', id: conn.id}, conn.socket);
  }
}

/* ---------- 握手升级 ---------- */
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  const conn = {socket, id: null, name: null, d: null, buf: Buffer.alloc(0), frag: null, lastSeen: Date.now(), closed: false};
  socket.on('data', d => onData(conn, d));
  socket.on('error', () => {});
  socket.on('close', () => leave(conn));
});

/* ---------- 掉线清理 ---------- */
setInterval(() => {
  const now = Date.now();
  for (const [ws, conn] of clients) {
    if (now - conn.lastSeen > STALE_MS) { ws.destroy(); leave(conn); }
  }
}, 30000).unref();

server.listen(port, () => console.log(`flight-real relay on ws://0.0.0.0:${port}`));