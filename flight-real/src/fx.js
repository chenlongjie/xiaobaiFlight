// 速度感三件套：风线 / 花瓣 / 相机微抖。
// 飞行题材里，"快"有一半来自画面元素，不是位移本身。
import * as THREE from 'three';

function petalTexture(size=64){
  const c=document.createElement('canvas');c.width=c.height=size;
  const ctx=c.getContext('2d');
  const g=ctx.createRadialGradient(size*0.5,size*0.45,0,size*0.5,size*0.5,size*0.5);
  g.addColorStop(0,'rgba(255,246,250,1)');
  g.addColorStop(0.55,'rgba(255,206,224,0.95)');
  g.addColorStop(1,'rgba(255,170,200,0)');
  ctx.fillStyle=g;
  ctx.beginPath();
  ctx.ellipse(size*0.5,size*0.5,size*0.30,size*0.42,0.5,0,Math.PI*2);
  ctx.fill();
  const t=new THREE.CanvasTexture(c);
  t.colorSpace=THREE.SRGBColorSpace;
  t.needsUpdate=true;
  return t;
}

export function buildFX(scene){
  // —— 风线：一圈短线段，全部在相机局部空间里 ——
  const N=44;   // 上一版 130 条太密，糊成一片白毛
  const geo=new THREE.BufferGeometry();
  const pos=new Float32Array(N*6);
  geo.setAttribute('position',new THREE.BufferAttribute(pos,3));
  const seeds=[];
  for(let i=0;i<N;i++){
    seeds.push({
      a:Math.random()*Math.PI*2,
      r:3.4+Math.random()*9.0,          // 往外推，别糊在画面正中央
      z:-4-Math.random()*54,
      len:2.4+Math.random()*6.0,
      w:0.35+Math.random()*0.65,
    });
  }
  const lineMat=new THREE.LineBasicMaterial({
    color:0xe6f2f8,transparent:true,opacity:0,
    depthWrite:false,depthTest:true,blending:THREE.AdditiveBlending,
  });
  const lines=new THREE.LineSegments(geo,lineMat);
  lines.frustumCulled=false;
  lines.renderOrder=5;
  scene.add(lines);

  // —— 花瓣：跟随相机的一大团粒子，随风飘、向后掠。
  //    参考片里花瓣漫天，密度按 800 起（Points 是纯 GPU 开销）。
  //    尺寸压小以免近景花瓣盖过画面主体 ——
  const P=800;
  const pgeo=new THREE.BufferGeometry();
  const ppos=new Float32Array(P*3);
  const pvel=[];
  for(let i=0;i<P;i++){
    ppos[i*3]  =(Math.random()-0.5)*72;
    ppos[i*3+1]=(Math.random()-0.5)*44;
    ppos[i*3+2]=(Math.random()-0.5)*72+30;   // 初始向镜头前方偏置，飞行时自然往后掠
    pvel.push({vx:(Math.random()-0.5)*1.6,vy:-0.3-Math.random()*0.9,vz:(Math.random()-0.5)*1.6,ph:Math.random()*6.28});
  }
  pgeo.setAttribute('position',new THREE.BufferAttribute(ppos,3));
  const pmat=new THREE.PointsMaterial({
    map:petalTexture(),size:0.22,sizeAttenuation:true,
    transparent:true,opacity:0,depthWrite:false,
    color:0xffd0e6,
  });
  const petals=new THREE.Points(pgeo,pmat);
  petals.frustumCulled=false;
  petals.renderOrder=6;
  scene.add(petals);

  // —— 掠水飞溅：参考片里最抢眼的就是这堆白水珠 ——
  const SP=260;
  const sgeo=new THREE.BufferGeometry();
  const spos=new Float32Array(SP*3);
  const svel=new Float32Array(SP*3);
  const slife=new Float32Array(SP);
  for(let i=0;i<SP;i++){spos[i*3+1]=-9999;}
  sgeo.setAttribute('position',new THREE.BufferAttribute(spos,3));
  const smat=new THREE.PointsMaterial({
    color:0xf2fbff,size:0.30,sizeAttenuation:true,
    transparent:true,opacity:0.0,depthWrite:false,
  });
  const spray=new THREE.Points(sgeo,smat);
  spray.frustumCulled=false;
  spray.renderOrder=7;
  scene.add(spray);
  let spIdx=0;

  const tmp=new THREE.Vector3();

  return {
    lines,petals,
    update(dt,t,flight,camera){
      const sp=Math.max(flight.speed,0);
      const fast=Math.min(Math.max((sp-12)/30,0),1);

      // 风线：贴着相机，往观察者方向刷过去
      lines.position.copy(camera.position);
      lines.quaternion.copy(camera.quaternion);
      const rush=18+sp*2.6;
      for(let i=0;i<N;i++){
        const s=seeds[i];
        s.z+=rush*dt;
        if(s.z>-1.5){s.z=-4-Math.random()*54;s.a=Math.random()*Math.PI*2;s.r=3.4+Math.random()*9.0;}
        const x=Math.cos(s.a)*s.r, y=Math.sin(s.a)*s.r*0.75;
        const long=s.len*(1+fast*1.6);
        const k=i*6;
        pos[k]  =x;pos[k+1]=y;pos[k+2]=s.z;
        pos[k+3]=x;pos[k+4]=y;pos[k+5]=s.z-long;
      }
      geo.attributes.position.needsUpdate=true;
      lineMat.opacity=fast*0.20;

      // 花瓣：围绕相机循环，速度越快越往后掠
      for(let i=0;i<P;i++){
        const v=pvel[i];
        const k=i*3;
        ppos[k]  +=(v.vx+Math.sin(t*0.7+v.ph)*0.8)*dt;
        ppos[k+1]+=(v.vy-0.2)*dt;
        ppos[k+2]+=(-sp*0.55+v.vz)*dt;
        // 超出盒子就绕到相机前方
        const dx=ppos[k]-camera.position.x;
        const dy=ppos[k+1]-camera.position.y;
        const dz=ppos[k+2]-camera.position.z;
        const d2=dx*dx+dy*dy+dz*dz;
        if(d2>72*72){
          ppos[k]  =camera.position.x+(Math.random()-0.5)*68;
          ppos[k+1]=camera.position.y+(Math.random()-0.5)*40;
          ppos[k+2]=camera.position.z+(Math.random()-0.5)*68;
        }
      }
      pgeo.attributes.position.needsUpdate=true;
      pmat.opacity=0.55+fast*0.35;

      // 水珠：抛物线飞溅，落回水面即回收
      let alive=0;
      for(let i=0;i<SP;i++){
        if(slife[i]<=0)continue;
        slife[i]-=dt;alive++;
        const k=i*3;
        svel[k+1]-=11.0*dt;
        spos[k]  +=svel[k]*dt;
        spos[k+1]+=svel[k+1]*dt;
        spos[k+2]+=svel[k+2]*dt;
        if(slife[i]<=0||spos[k+1]<-2){slife[i]=0;spos[k+1]=-9999;}
      }
      sgeo.attributes.position.needsUpdate=true;
      smat.opacity=alive>0?0.95:0.0;
    },
    // 掠水时调用：在扫帚后方炸开一小蓬水珠
    emitSpray(pos,forward,speed,n=4){
      const power=Math.min(speed/30,1.4);
      for(let j=0;j<n;j++){
        const i=spIdx++%SP, k=i*3;
        spos[k]  =pos.x+(Math.random()-0.5)*1.4;
        spos[k+1]=pos.y-0.9+Math.random()*0.5;
        spos[k+2]=pos.z+(Math.random()-0.5)*1.4;
        svel[k]  =forward.x*(2+Math.random()*5)-(forward.x*power*6)+ (Math.random()-0.5)*3.5;
        svel[k+1]=3.2+Math.random()*5.5*power;
        svel[k+2]=forward.z*(2+Math.random()*5)-(forward.z*power*6)+ (Math.random()-0.5)*3.5;
        slife[i]=1.4+Math.random()*0.9;
      }
      sgeo.attributes.position.needsUpdate=true;
    },
  };
}
