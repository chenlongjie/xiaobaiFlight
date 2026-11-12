// 骑手：矮个女巫 + 黑猫 + 扫帚，全部由基本几何拼出，材质换成 PBR。
// 朝向约定：+Z 为前（与 flight.pose 的 yaw 一致）。
import * as THREE from 'three';

const mat=(color,rough=0.85,metal=0)=>
  new THREE.MeshStandardMaterial({color,roughness:rough,metalness:metal,envMapIntensity:0.9});

export function buildRider(){
  const g=new THREE.Group();

  const M={
    cloth:mat(0x2a2740,0.92),
    cloth2:mat(0x3a3654,0.85),
    skin:mat(0xf3d3bb,0.72),
    hair:mat(0x161419,0.95),
    red:mat(0xb03a2e,0.8),
    wood:mat(0x8d6a3f,0.78),
    straw:mat(0xd4ad63,0.88),
    cat:mat(0x131317,0.95),
    shoe:mat(0x8e2f27,0.75),
  };

  const add=(geo,m,pos=[0,0,0],rot=[0,0,0],scale=null)=>{
    const mesh=new THREE.Mesh(geo,m);
    mesh.position.set(...pos);
    mesh.rotation.set(...rot);
    if(scale)mesh.scale.set(...scale);
    mesh.castShadow=true;
    g.add(mesh);
    return mesh;
  };

  // —— 扫帚 ——
  add(new THREE.CylinderGeometry(0.045,0.052,2.9,12),M.wood,[0,0,0.05],[Math.PI/2,0,0]);
  // 帚尾（前细后散）
  add(new THREE.ConeGeometry(0.30,0.95,14),M.straw,[0,-0.02,-1.85],[-Math.PI/2,0,0]);
  add(new THREE.ConeGeometry(0.22,0.55,12),M.straw,[0,0.01,-1.52],[-Math.PI/2,0,0]);
  add(new THREE.TorusGeometry(0.075,0.022,8,16),M.red,[0,0,-1.42],[0,0,0]);

  // —— 身体（前倾骑乘姿态）——
  const body=add(new THREE.CapsuleGeometry(0.20,0.34,8,14),M.cloth,[0,0.52,0.02],[0.42,0,0]);
  add(new THREE.SphereGeometry(0.21,16,12),M.cloth2,[0,0.42,0.10],[0,0,0],[1.06,0.9,1.0]);

  // 头 + 刘海
  const head=add(new THREE.SphereGeometry(0.155,20,16),M.skin,[0,0.86,0.06]);
  add(new THREE.SphereGeometry(0.165,20,16),M.hair,[0,0.885,0.035],[0,0,0],[1.0,0.95,1.0]);

  // 女巫帽：帽檐 + 尖顶
  add(new THREE.CylinderGeometry(0.30,0.30,0.022,20),M.hair,[0,0.965,0.03],[0.14,0,0]);
  add(new THREE.ConeGeometry(0.175,0.46,16),M.hair,[0,1.16,0.005],[0.18,0,0.05]);

  // 红色发带
  add(new THREE.TorusGeometry(0.155,0.028,8,18),M.red,[0,0.945,0.02],[1.30,0,0]);

  // 手臂：一只向前扶帚、一只在侧面
  add(new THREE.CapsuleGeometry(0.055,0.30,6,10),M.skin,[0.20,0.66,0.26],[1.15,0,0.30]);
  add(new THREE.CapsuleGeometry(0.055,0.30,6,10),M.skin,[-0.20,0.66,0.24],[1.15,0,-0.30]);

  // 腿：跨坐，向后下方垂
  add(new THREE.CapsuleGeometry(0.070,0.34,6,10),M.cloth,[0.16,0.30,-0.10],[0.34,0,0.16]);
  add(new THREE.CapsuleGeometry(0.070,0.34,6,10),M.cloth,[-0.16,0.30,-0.10],[0.34,0,-0.16]);
  add(new THREE.SphereGeometry(0.075,10,8),M.shoe,[0.19,0.10,-0.26],[0,0,0],[0.9,1.15,0.7]);
  add(new THREE.SphereGeometry(0.075,10,8),M.shoe,[-0.19,0.10,-0.26],[0,0,0],[0.9,1.15,0.7]);

  // —— 黑猫（坐在帚尾前）——
  const cat=new THREE.Group();
  cat.position.set(0,0.24,-0.52);
  const cm=(geo,pos=[0,0,0],rot=[0,0,0],scale=null)=>{
    const m=new THREE.Mesh(geo,M.cat);
    m.position.set(...pos);m.rotation.set(...rot);
    if(scale)m.scale.set(...scale);
    m.castShadow=true;cat.add(m);return m;
  };
  cm(new THREE.SphereGeometry(0.13,14,12),[0,0,0],[0,0,0],[1,0.92,1.15]);
  cm(new THREE.SphereGeometry(0.098,14,12),[0,0.16,0.05]);
  cm(new THREE.ConeGeometry(0.035,0.075,6),[0.062,0.245,0.03],[0,0,-0.25]);
  cm(new THREE.ConeGeometry(0.035,0.075,6),[-0.062,0.245,0.03],[0,0,0.25]);
  // 尾巴：向上卷
  const tail=new THREE.Mesh(new THREE.TorusGeometry(0.11,0.023,6,12,Math.PI*1.25),M.cat);
  tail.position.set(0,0.06,-0.13);tail.rotation.set(0.5,0,0);tail.castShadow=true;
  cat.add(tail);
  g.add(cat);

  // 收纳袋挂在腰侧
  add(new THREE.SphereGeometry(0.10,12,10),M.wood,[0.26,0.36,-0.14],[0,0,0],[0.85,1.1,0.75]);

  // 轻微呼吸 / 头发飘动（用整体微变换，不写自定义着色器）
  const baseY=0;
  return {
    group:g,
    body,head,cat,
    update(t,{speed=0,bank=0}={}){
      const k=Math.min(speed/40,1);
      const sway=Math.sin(t*2.4)*0.012*(1-k)+Math.sin(t*7.5)*0.006*k;
      // pose() 已经写过 rotation.z（压坡度侧倾），这里必须用 += 叠加上去，
      // 直接赋值会把转向侧倾整个抹掉。
      g.rotation.z+=sway;
      head.rotation.z=Math.sin(t*1.9)*0.03;
      cat.rotation.x=Math.sin(t*1.4)*0.04;
      // 速度越快，人越压低
      body.rotation.x=0.42+k*0.10;
    },
  };
}
