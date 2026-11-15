// 联机客户端：连接中继服务器、15Hz 上报自己的飞行状态、接收他人的状态并插值渲染。
// 世界是确定性的，每个客户端本地生成，这里只关心"别的玩家在哪"。
import * as THREE from 'three';
import {buildRider} from './rider.js';

const SEND_HZ = 15;       // 状态上报频率
const HB_MS = 20000;      // 心跳间隔（服务器按 90s 无消息判死）
const RECONNECT_MS = 3000;
const SMOOTH_K = 9;       // 位置阻尼系数（越大越快贴目标）

export class Net {
  constructor(url, {scene, name, onStatus, getState} = {}) {
    this.url = url;
    this.scene = scene;
    this.name = name;
    this.onStatus = onStatus;
    this.getState = getState; // () => [x,y,z,yaw,pitch,roll,speed]，加入与上报共用
    this.ws = null;
    this.open = false;
    this.id = null;
    this.players = new Map(); // id -> RemotePlayer
    this.lastSend = 0;
    this.reconnectT = 0;
    this.manualClose = false;
    this.hbTimer = null;
  }

  connect() {
    this.manualClose = false;
    if (this.ws) return;
    let ws;
    try { ws = new WebSocket(this.url); } catch (e) { this._status('error'); return; }
    this.ws = ws;
    // 心跳用独立定时器而不是游戏主循环：
    // 页面切到后台时 requestAnimationFrame 会被浏览器暂停，心跳必须继续，否则服务器会误判掉线
    if (!this.hbTimer) {
      this.hbTimer = setInterval(() => {
        if (this.open && this.ws) { try { this.ws.send('{"t":"hb"}'); } catch (_) {} }
      }, HB_MS);
    }
    ws.onopen = () => {
      this.open = true;
      // join 时带上真实出生位置：其他玩家第一时间就能看到，而不是先闪现到(0,46,0)
      const d = this.getState ? this.getState() : null;
      ws.send(JSON.stringify(Array.isArray(d) ? {t: 'join', name: this.name, d} : {t: 'join', name: this.name}));
      this._status('connecting');
    };
    ws.onmessage = e => { try { this._onMsg(JSON.parse(e.data)); } catch (_) {} };
    ws.onclose = () => this._gone(false);
    ws.onerror = () => { this.open = false; };
  }

  disconnect() {
    this.manualClose = true;
    this.ws && this.ws.close();
    this.ws = null;
    this.open = false;
    if (this.hbTimer) { clearInterval(this.hbTimer); this.hbTimer = null; }
    this._purgeAll();
  }

  _gone(byError) {
    const wasOpen = this.open;
    this.open = false;
    this.ws = null;
    if (!this.manualClose) {
      this._purgeAll();
      this._status(byError ? 'error' : 'closed');
      if (wasOpen && !this.manualClose) this.reconnectT = RECONNECT_MS; // 掉线后重连
    }
  }

  _purgeAll() {
    for (const p of this.players.values()) p.dispose();
    this.players.clear();
    this.id = null;
  }

  _status(s) { this.onStatus && this.onStatus(s); }

  _onMsg(m) {
    if (m.t === 'welcome') {
      this.id = m.id;
      for (const p of (m.peers || [])) this._addPlayer(p);
      this._status('online');
    } else if (m.t === 'peer_join') {
      this._addPlayer(m);
    } else if (m.t === 'p') {
      const p = this.players.get(m.id);
      if (p) p.setTarget(m.d);
    } else if (m.t === 'peer_leave') {
      const p = this.players.get(m.id);
      if (p) { p.dispose(); this.players.delete(m.id); }
    }
  }

  _addPlayer({id, name, d}) {
    if (!id || id === this.id || this.players.has(id)) return;
    const p = new RemotePlayer(id, name, d, this.scene);
    this.players.set(id, p);
    this._status('online'); // 人数变了，刷新提示
  }

  /** 主循环每帧调用：上报自己的状态（内部限频） */
  sendState(now) {
    if (!this.open || !this.ws) return;
    if (now - this.lastSend < 1 / SEND_HZ) return;
    this.lastSend = now;
    const st = this.getState ? this.getState() : null;
    if (!Array.isArray(st) || st.length < 7) return;
    const d = [
      +st[0].toFixed(2), +st[1].toFixed(2), +st[2].toFixed(2),
      +st[3].toFixed(4), +st[4].toFixed(4), +st[5].toFixed(4), +st[6].toFixed(2),
    ];
    this.ws.send(JSON.stringify({t: 'state', d}));
  }

  /** 主循环每帧调用：远程玩家插值 + 掉线自动重连（心跳由独立定时器负责） */
  update(dt) {
    if (!this.manualClose && !this.open && this.reconnectT > 0) {
      this.reconnectT -= dt;
      if (this.reconnectT <= 0) { this.connect(); return; }
    }
    if (this.players.size) {
      for (const p of this.players.values()) p.update(dt);
    }
  }

  get count() { return this.players.size; }
}

class RemotePlayer {
  constructor(id, name, d, scene) {
    this.id = id;
    this.name = name;
    this.scene = scene;
    this.group = buildRider({shadow: false}).group;
    this.group.traverse(o => { if (o.isMesh) o.castShadow = false; });
    // 名字标签：挂在角色上方，穿透遮挡始终可见，几百米外也能定位到人
    const tag = makeNameTag(name);
    if (tag) this.group.add(tag);
    scene.add(this.group);
    // 当前渲染值
    this.x = 0; this.y = 0; this.z = 0; this.yaw = 0; this.pitch = 0; this.roll = 0;
    // 目标值
    this.tx = 0; this.ty = 0; this.tz = 0; this.tyaw = 0; this.tpitch = 0; this.troll = 0;
    this._haveTarget = false;
    if (Array.isArray(d)) this.setTarget(d);
  }

  setTarget(d) {
    if (!Array.isArray(d) || d.length < 6) return;
    this.tx = d[0]; this.ty = d[1]; this.tz = d[2];
    this.tyaw = d[3]; this.tpitch = d[4]; this.troll = d[5];
    if (!this._haveTarget) { // 首帧直接跳过去，避免从原点飞来
      this.x = this.tx; this.y = this.ty; this.z = this.tz;
      this.yaw = this.tyaw; this.pitch = this.tpitch; this.roll = this.troll;
      this._haveTarget = true;
      this._apply();
      return;
    }
  }

  update(dt) {
    if (!this._haveTarget) return;
    const k = Math.min(1, 1 - Math.exp(-SMOOTH_K * dt));
    this.x += (this.tx - this.x) * k;
    this.y += (this.ty - this.y) * k;
    this.z += (this.tz - this.z) * k;
    // 偏航是环绕角，用归一化差值避免转大圈
    let dy = this.tyaw - this.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.yaw += dy * Math.min(1, 10 * dt);
    this.pitch += (this.tpitch - this.pitch) * Math.min(1, 10 * dt);
    this.roll += (this.troll - this.roll) * Math.min(1, 10 * dt);
    this._apply();
  }

  _apply() {
    // 与 flight.pose() 相同的朝向约定（+Z 为前）
    const g = this.group;
    g.position.set(this.x, this.y, this.z);
    g.rotation.set(0, 0, 0);
    g.rotation.y = this.yaw;
    g.rotateX(-this.pitch);
    g.rotateZ(-this.roll * 0.55);
  }

  dispose() { this.scene.remove(this.group); }
}

// 远程玩家名字标签：Canvas 画字 → Sprite，depthTest 关掉 → 隔着山也能看到
function makeNameTag(name) {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.font = 'bold 34px system-ui,"PingFang SC","Microsoft YaHei",sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const w = Math.min(ctx.measureText(name).width + 44, 248);
    ctx.fillStyle = 'rgba(8,14,18,0.55)';
    ctx.beginPath();
    ctx.roundRect(128 - w / 2, 8, w, 48, 10);
    ctx.fill();
    ctx.fillStyle = '#f2f7fa';
    ctx.fillText(name, 128, 32);
    const tex = new THREE.CanvasTexture(canvas);
    tex.anisotropy = 4;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, depthTest: false, depthWrite: false,
    }));
    spr.scale.set((w / 64) * 1.8, 1.8, 1);
    spr.position.set(0, 3.0, 0);
    spr.renderOrder = 1000;
    return spr;
  } catch (_) { return null; }
}

export {RemotePlayer};