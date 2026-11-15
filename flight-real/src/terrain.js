// 峡谷地形：一条蜿蜒河道 + 两侧分层陡崖 + 崖顶台地。
// 高度场只算一次（buildField），地形网格 / 水深图 / 植被撒点 / 碰撞网格全部复用同一份采样，
// 否则光是重复求值就要好几秒。
import * as THREE from 'three';
import {clamp,lerp,smoothstep,fbm3,ridged2,rng} from './util.js';
import {applyFog} from './fog.js';

export const WATER_Y=0;
export const WORLD=900;          // 世界边长
export const MAX_DEPTH=9;        // 水深归一上限（米）
const HALF=WORLD/2;

function riverCenter(z){
  return Math.sin(z*0.0112)*36 + Math.sin(z*0.0301+1.7)*15 + Math.sin(z*0.071)*5;
}

export function terrainHeight(x,z){
  const xc=riverCenter(z);
  const d0=Math.abs(x-xc);
  const halfW=52+18*Math.sin(z*0.0071+0.6)+9*Math.sin(z*0.0193);

  // ★ 竖向沟壑 / 扶壁：直接扰动"离河心多远"这个量本身，
  //   崖壁就会长出竖着的冲沟和凸出的岩墙，而不是一面光滑斜坡。
  //   （上一版是"把高度往水平层理上量化"→ 一圈圈等高线，已废弃）
  const fluteA=(fbm3(x*0.0125+13.7,z*0.0125,5.5,4)-0.5)*30;   // 大扶壁 ~80m 一根
  const fluteB=(fbm3(x*0.048+3.1,z*0.048,7.7,3)-0.5)*9;       // 小冲沟 ~20m 一条
  const fluteC=(fbm3(x*0.145+51.3,z*0.145,9.1,2)-0.5)*3.2;     // 细岩肋 ~7m 一根
  const wallMask=smoothstep(halfW*0.55,halfW*1.05,d0);          // 只在崖区生效，河床保持干净
  const d=d0+(fluteA+fluteB+fluteC)*wallMask;

  const bank=smoothstep(halfW*0.30,halfW*0.86,d0);
  let h=lerp(-5.2,3.4,bank);
  h+=(fbm3(x*0.013,z*0.013,1.3,4)-0.5)*3.0*bank;

  // 抬升带 34m。用"偏线性"的斜坡而不是纯 smoothstep：
  // smoothstep 的坡度在中段最陡，会把全部高差挤进一两格，
  // 高度场里就变成又宽又平的台阶（等高线感）。偏线性 = 每格抬升更均匀。
  const wallT=clamp((d-halfW*0.96)/34,0,1);
  const wall=wallT*wallT*(3-2*wallT)*0.30+wallT*0.70;
  if(wall>0){
    const r=ridged2(x*0.0045,z*0.0045,5);
    const pillars=1-Math.abs(fbm3(x*0.030,0.5,z*0.030,2.7,3)*2-1);
    h+=wall*(78+r*54+pillars*18);
  }

  const top=smoothstep(halfW+70,halfW+240,d);
  if(top>0){
    h+=top*(34*(fbm3(x*0.0021,z*0.0021,2.1,4)-0.5)+26*ridged2(x*0.0013,z*0.0013,3));
  }

  const detail=1-clamp(d/(halfW+90),0,1)*0.55;
  h+=(fbm3(x*0.021,z*0.021,3.3,4)-0.5)*3.4*detail;
  h+=(fbm3(x*0.081,z*0.081,7.1,3)-0.5)*1.05*detail;
  h-=(1-bank)*3.4;

  // ★ 河口湾：z 越小（往北飞）谷底越张开，最后整片沉进海面 ——
  //   峡谷的尽头直接接一片能撒开飞的开阔水面，而不是一条窄河沟。
  const bayT=smoothstep(-110,-300,z);
  if(bayT>0){
    const bed=-5-11*fbm3(x*0.0058+31.7,z*0.0058+7.3,4.4,3);
    h=lerp(h,Math.min(h,bed),bayT*0.95);
  }

  // ★ 海岸线：中部是一整块山体，外圈沉进海面。
  //   半径带噪声，所以海岸不是圆，而是一圈啃进去的岬角与海湾。
  //   峡谷到尽头直接跌进海里 —— 这就是"峡谷外一望无际的海洋"。
  const rad=Math.hypot(x,z);
  const coastR=352+(fbm3(x*0.0026,z*0.0026,9.7,3)-0.5)*86;
  if(rad>coastR-40){
    const oceanK=smoothstep(coastR,coastR+92,rad);
    const seabed=-16-10*fbm3(x*0.0072,z*0.0072,4.4,2);
    h=lerp(h,seabed,oceanK);
  }

  // ★ 海蚀柱：必须放在海岸混合**之后**，否则会被海床抹平。
  //   开阔水面上需要几根参照物，不然飞起来完全没有速度感。
  if(z<-240){
    const stacks=[[-126,-300,17,32],[64,-320,14,25],[180,-262,12,20],[-150,-282,15,23]];
    for(let i2=0;i2<stacks.length;i2++){
      const sx=stacks[i2][0], sz=stacks[i2][1], rr=stacks[i2][2], ht=stacks[i2][3];
      const dd=Math.hypot(x-sx,z-sz);
      if(dd<rr*2.8)h+=ht*Math.exp(-Math.pow(dd/rr,2.2)*1.8);
    }
  }
  return h;
}

// 一次性高度场：on-grid 采样 + 双线性查值
export function buildField(res=384){
  const cell=WORLD/res, n=res+1;
  const data=new Float32Array(n*n);
  for(let j=0;j<n;j++){
    const z=-HALF+j*cell;
    for(let i=0;i<n;i++)data[j*n+i]=terrainHeight(-HALF+i*cell,z);
  }
  const field={
    res,cell,data,
    heightAt(x,z){
      const fx=(x+HALF)/cell, fz=(z+HALF)/cell;
      const i=clamp(Math.floor(fx),0,res-1), j=clamp(Math.floor(fz),0,res-1);
      const tx=clamp(fx-i,0,1), tz=clamp(fz-j,0,1);
      const a=data[j*n+i],b=data[j*n+i+1],c=data[(j+1)*n+i],d=data[(j+1)*n+i+1];
      return lerp(lerp(a,b,tx),lerp(c,d,tx),tz);
    },
    slopeAt(x,z){
      const e=Math.max(cell,1.2);
      const dx=this.heightAt(x+e,z)-this.heightAt(x-e,z);
      const dz=this.heightAt(x,z+e)-this.heightAt(x,z-e);
      return Math.hypot(dx,dz)/(2*e);
    },
    clearanceAt(x,z){return this.heightAt(x,z);},
  };
  return field;
}

export function buildTerrain(field){
  const n=field.res;
  const cell=field.cell;
  const verts=(n+1)*(n+1);
  const pos=new Float32Array(verts*3);

  const data=field.data, n1=n+1;
  const hashIJ=(a,b)=>{let h2=a*374761393+b*668265263;h2=(h2^(h2>>13))*1274126177;return ((h2^(h2>>16))>>>0)/4294967296;};

  for(let j=0;j<=n;j++)for(let i=0;i<=n;i++){
    const k=(j*n1+i)*3;
    const h=data[j*n1+i];
    // 局部高差 → 坡度强度（直接读数组，零成本）
    const hx1=data[j*n1+(i>0?i-1:0)], hx2=data[j*n1+(i<n?i+1:n)];
    const hz1=data[(j>0?j-1:0)*n1+i], hz2=data[(j<n?j+1:n)*n1+i];
    const rough=Math.abs(hx2-hx1)+Math.abs(hz2-hz1);
    // ★ 陡面顶点抖动：高度场在近乎垂直的崖壁上，必然每格抬 5~10 米，
    //   形成对齐网格的规则台阶 —— 远看就是一圈圈等高线。
    //   给陡面加确定性抖动，把这些台阶打散成不规则岩面。
    const amp=Math.min(rough*0.13,1.0);
    const jx=(hashIJ(i+7919,j)-0.5)*amp*0.6;
    const jz=(hashIJ(i,j+104729)-0.5)*amp*0.6;
    const jy=(hashIJ(i+131,j+37)-0.5)*amp*1.7;
    pos[k]=-HALF+i*cell+jx;
    pos[k+1]=h+jy;
    pos[k+2]=-HALF+j*cell+jz;
  }

  const idx=new Uint32Array(n*n*6);
  let p=0;
  for(let j=0;j<n;j++)for(let i=0;i<n;i++){
    const a=j*(n+1)+i,b=a+1,c=a+n+1,d=c+1;
    idx[p++]=a;idx[p++]=c;idx[p++]=b;
    idx[p++]=b;idx[p++]=c;idx[p++]=d;
  }

  const geo=new THREE.BufferGeometry();
  geo.setAttribute('position',new THREE.BufferAttribute(pos,3));
  geo.setIndex(new THREE.BufferAttribute(idx,1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  return {geometry:geo,step:cell,resolution:n};
}

// 水面：PBR + 天空反射 + 深度色（浅滩透光 / 深水吸光）+ 岸线泡沫
export function buildWater({normalMap,foamTex,depthTex}={}){
  const geo=new THREE.PlaneGeometry(9000,9000,1,1);   // 跟着相机走，视觉上等于无限海面
  const mat=new THREE.MeshStandardMaterial({
    color:0xffffff,roughness:0.09,metalness:0.0,
    envMapIntensity:0.95,transparent:true,opacity:0.96,
  });

  const U={
    tNormal:{value:normalMap},
    tFoam:{value:foamTex},
    tDepth:{value:depthTex},
    uTime:{value:0},
    uWorld:{value:WORLD},
    uMaxDepth:{value:MAX_DEPTH},
    uShallow:{value:new THREE.Color(0x2f9099)},
    uDeep:{value:new THREE.Color(0x14596f)},
    // 尾迹：每条 vec4 = (x, z, 起始时间, 强度)，环形缓冲
    uWakes:{value:Array.from({length:12},()=>new THREE.Vector4(0,0,-99,0))},
  };

  mat.onBeforeCompile=(sh)=>{
    Object.assign(sh.uniforms,U);
    applyFog(sh);

    sh.vertexShader=sh.vertexShader
      .replace('#include <common>','#include <common>\nvarying vec3 vWPos;')
      .replace('#include <begin_vertex>',
        '#include <begin_vertex>\nvWPos=(modelMatrix*vec4(transformed,1.0)).xyz;');

    sh.fragmentShader=sh.fragmentShader
      .replace('#include <common>',`#include <common>
        varying vec3 vWPos;
        uniform sampler2D tNormal,tFoam,tDepth;
        uniform float uTime,uWorld,uMaxDepth;
        uniform vec3 uShallow,uDeep;
        uniform vec4 uWakes[12];`)
      .replace('#include <map_fragment>',`
        vec2 wUv=(vWPos.xz+uWorld*0.5)/uWorld;
        float wDepth=texture2D(tDepth,wUv).r*uMaxDepth;

        // 浅滩几乎全透明 —— 要让人看见河床的砂石，而不是一层蓝膜
        vec3 wCol=mix(uShallow,uDeep,smoothstep(0.5,6.5,wDepth));
        float wAlpha=mix(0.10,0.97,smoothstep(0.20,4.0,wDepth));

        // 岸线：只留一点点"湿沙灰"的亮边，且用超低频噪声打散
        float wN=texture2D(tFoam,vWPos.xz*0.006+vec2(uTime*0.004,-uTime*0.003)).r;
        float wShore=smoothstep(0.75,0.15,wDepth+wN*0.6-0.25);
        wCol=mix(wCol,vec3(0.62,0.64,0.60),wShore*0.30);

        // ★ 掠过水面的尾迹：参考片里是**一大片翻白的浪花**，不是细圆圈。
        //   所以每个轨迹点给两样东西：贴身的"翻滚核心" + 向外推的"崩浪环"。
        vec2 wWakeN=vec2(0.0);
        float wWake=0.0;
        for(int i=0;i<12;i++){
          vec4 wk=uWakes[i];
          if(wk.w<=0.001)continue;
          float age=uTime-wk.z;
          if(age<0.0||age>3.2)continue;
          vec2 dv=vWPos.xz-wk.xy;
          float dd=length(dv)+0.001;
          float core=exp(-pow(dd/2.8,2.0))*exp(-age*2.0);
          float ring=exp(-pow((dd-age*6.0)/2.6,2.0))*(1.0-age/3.2);
          float k=(core+ring*0.55)*wk.w;
          wWakeN+=(dv/dd)*k*1.1;
          wWake+=k;
        }
        wCol=mix(wCol,vec3(0.94,0.97,0.97),clamp(wWake*1.15,0.0,1.0));

        diffuseColor.rgb=wCol;
        diffuseColor.a=max(wAlpha,clamp(wWake*1.2,0.0,1.0));
      `)
      .replace('#include <normal_fragment_maps>',`
        // 频率比上一版高一倍多：从"21 米一个大浪"回到"2 米级细纹"
        // 细纹（2m 级）
        vec2 wNa=vWPos.xz*0.105+uTime*vec2(0.014,0.008);
        vec2 wNb=vWPos.xz*0.255-uTime*vec2(0.011,0.017);
        wNa+=vec2(sin(wNb.y*1.7),cos(wNb.x*1.3))*0.85;
        vec3 wNA=texture2D(tNormal,wNa).xyz*2.0-1.0;
        vec3 wNB=texture2D(tNormal,wNb).xyz*2.0-1.0;
        vec2 wFine=wNA.xy*0.26+wNB.xy*0.20;

        // ★ 大尺度褶皱（20~60m）：参考片里那种"布褶一样的光带"就靠它。
        //   它必须**保留到远处**，否则远景又变回一面死镜。
        vec2 wSa=vWPos.xz*0.017+uTime*vec2(0.004,0.0026);
        vec2 wSb=vWPos.xz*0.041-uTime*vec2(0.0031,0.0052);
        wSa+=vec2(sin(wSb.y*1.3),cos(wSb.x*1.1))*1.6;
        vec3 wSA=texture2D(tNormal,wSa).xyz*2.0-1.0;
        vec3 wSB=texture2D(tNormal,wSb).xyz*2.0-1.0;
        vec2 wSwell=wSA.xy*0.50+wSB.xy*0.34;

        vec2 wNm=wSwell;
        // 水流有急有缓：低频掩码让局部近乎静水，整条河不再一个节奏
        float wCalm=texture2D(tFoam,vWPos.xz*0.0035+vec2(uTime*0.002,0.0)).r;
        wNm*=mix(0.28,1.0,smoothstep(0.25,0.72,wCalm));
        wNm*=mix(1.0,0.55,smoothstep(0.2,2.6,wDepth));
        // 远处收细节：真实水面远景就是一面镜子
        float wFar=smoothstep(90.0,600.0,length(vWPos-cameraPosition));
        wNm+=wFine*mix(1.0,0.04,wFar);      // 只有细纹被收掉
        wNm*=mix(1.0,0.62,wFar);            // 远景褶皱也稍微平一点，但仍保留光带
        wNm+=wWakeN*1.15;          // 尾迹把水面顶起来，高光才会跟着动
        vec3 wNw=normalize(vec3(wNm.x,1.0,wNm.y));
        normal=normalize((viewMatrix*vec4(wNw,0.0)).xyz);
      `);
  };
  mat.customProgramCacheKey=()=>'waterSurface';

  const mesh=new THREE.Mesh(geo,mat);
  mesh.rotation.x=-Math.PI/2;
  mesh.position.y=WATER_Y;
  mesh.name='water';

  let wakeIdx=0;
  const wakes=U.uWakes.value;
  return {
    mesh,
    update(t){U.uTime.value=t;},
    pushWake(x,z,time,strength){
      const w=wakes[wakeIdx%12];
      w.set(x,z,time,strength);
      wakeIdx++;
    },
  };
}

// 散落岩块：崖脚碎石带 / 河床卵石。实例化 + 三平面材质，跟山体同一套贴图
export function buildRocks(material,field,{count=420,seed=31}={}){
  const r=rng(seed);

  const geo=new THREE.IcosahedronGeometry(1,1);
  const p=geo.attributes.position;
  for(let i=0;i<p.count;i++){
    const x=p.getX(i),y=p.getY(i),z=p.getZ(i);
    const n=0.70+0.55*fbm3(x*1.9+7.3,y*1.9-2.1,z*1.9+4.4,3);
    p.setXYZ(i,x*n,y*n*0.78,z*n);
  }
  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  const spots=[];
  let guard=0;
  while(spots.length<count&&guard++<count*40){
    const x=r.range(-HALF,HALF),z=r.range(-HALF,HALF);
    const y=field.heightAt(x,z);
    if(y>86||y<-7)continue;
    const sl=field.slopeAt(x,z);
    const talus=sl>0.50&&y>-2&&y<78;
    const riverbed=y<-1.2;
    if(!talus&&!riverbed)continue;
    if(!talus&&r.next()>0.5)continue;
    spots.push([x,y,z,riverbed?r.range(0.5,1.8):r.range(1.2,5.0)]);
  }

  const mesh=new THREE.InstancedMesh(geo,material,spots.length);
  mesh.name='rocks';
  mesh.castShadow=true;mesh.receiveShadow=true;mesh.frustumCulled=false;

  const dummy=new THREE.Object3D();
  spots.forEach(([x,y,z,s],i)=>{
    dummy.position.set(x,y+s*0.22,z);
    dummy.rotation.set(r.range(-0.35,0.35),r.next()*6.283,r.range(-0.35,0.35));
    dummy.scale.set(s*r.range(0.8,1.35),s*r.range(0.55,1.0),s*r.range(0.8,1.35));
    dummy.updateMatrix();
    mesh.setMatrixAt(i,dummy.matrix);
  });
  mesh.instanceMatrix.needsUpdate=true;

  return {mesh,count:spots.length};
}
