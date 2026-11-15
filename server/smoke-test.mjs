// 冒烟测试：自动起一个中继服务器，模拟两个玩家加入、互发状态、退出。
// 运行：node server/smoke-test.mjs   （需要 Node ≥ 21，用原生 WebSocket）
import {spawn} from 'node:child_process';

const PORT = 8791;
const relay = spawn(process.execPath, ['server/server.mjs', String(PORT)], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
relay.stderr.on('data', d => process.stderr.write('[relay!] ' + d));
await new Promise(r => setTimeout(r, 500));

const url = `ws://127.0.0.1:${PORT}`;
let failed = 0;
const check = (cond, msg) => {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + msg);
  if (!cond) failed++;
};

function openClient(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const got = [];
    ws.onopen = () => ws.send(JSON.stringify({t: 'join', name}));
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      got.push(m);
      if (m.t === 'welcome') resolve({ws, got, id: m.id});
    };
    ws.onerror = e => reject(new Error('ws error: ' + (e && e.message)));
    setTimeout(() => reject(new Error(name + ' join timeout')), 4000);
  });
}
const waitMsg = (c, t, timeout = 3000) =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      const m = c.got.find(x => x.t === t && !x._seen);
      if (m) { m._seen = true; clearInterval(timer); resolve(m); }
      else if (Date.now() - t0 > timeout) { clearInterval(timer); reject(new Error('timeout waiting ' + t)); }
    }, 20);
  });

try {
  const A = await openClient('Alice');
  check(A.id && A.got[0].t === 'welcome' && A.got[0].peers.length === 0, 'A 加入，welcome 且 peers 为空');

  const B = await openClient('Bob');
  check(B.id !== A.id, 'A/B 分配不同 id');
  check(B.got[0].peers.length === 1 && B.got[0].peers[0].id === A.id, 'B 的 welcome 含 A');

  const joinB = await waitMsg(A, 'peer_join');
  check(joinB.id === B.id && joinB.name === 'Bob', 'A 收到 B 加入');

  // B 发状态 → A 应收到
  const stateB = [10, 20, 30, 1.5, 0.2, -0.4, 33];
  B.ws.send(JSON.stringify({t: 'state', d: stateB}));
  const pB = await waitMsg(A, 'p');
  check(pB.id === B.id && pB.d[0] === 10 && Math.abs(pB.d[3] - 1.5) < 1e-9, 'B 状态转发到 A，数值一致');

  // A 发状态 → B 应收到
  A.ws.send(JSON.stringify({t: 'state', d: [1, 2, 3, 0.1, 0.2, 0.3, 15]}));
  const pA = await waitMsg(B, 'p');
  check(pA.id === A.id && pA.d[6] === 15, 'A 状态转发到 B');

  // 广播不回流：A 不应收到自己的 p
  check(!A.got.some(x => x.t === 'p' && x.id === A.id), 'A 未收到自己的状态回声');

  // B 关闭 → A 收到 peer_leave
  B.ws.close();
  const leave = await waitMsg(A, 'peer_leave');
  check(leave.id === B.id, 'B 断开后 A 收到 peer_leave');

  // 心跳帧不应导致报错/断开（等待期间不应出现任何新消息）
  const before = A.got.length;
  A.ws.send('{"t":"hb"}');
  await new Promise(r => setTimeout(r, 300));
  check(A.got.length === before, '心跳后 A 未被误踢（无新消息）');

  A.ws.close();
} catch (e) {
  console.error('ERROR: ' + e.message);
  failed++;
} finally {
  relay.kill();
  await new Promise(r => setTimeout(r, 200));
  console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
  process.exit(failed ? 1 : 0);
}