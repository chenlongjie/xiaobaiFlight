// 地被式植被：草 + 灌木两层，全部是交叉卡片（crossed card）。
//
// 上一版做过"实心团簇树"，俯视看像一排馒头，已废弃。
// 结论：飞行题材里树的形态极难低成本做对；不如把预算全押在"地被铺满"——
// 远看是一片有层次的绿毯，近看有叶簇剪影，这比假树可信得多。
import * as THREE from 'three';
import {WATER_Y,WORLD} from './terrain.js';
import {fbm3,rng,clamp} from './util.js';
import {applyFog} from './fog.js';

// 两片互相垂直的 quad，原点在底部中心
function crossCard(){
  const pos=[],uv=[],nor=[],idx=[];
  const quad=(rot)=>{
    const c=Math.cos(rot),s=Math.sin(rot);
    const base=pos.length/3;
    const corners=[[-0.5,0],[0.5,0],[0.5,1],[-0.5,1]];
    const uvs=[[0,0],[1,0],[1,1],[0,1]];
    for(let i=0;i<4;i++){
      const [x,y]=corners[i];
      pos.push(x*c,y,x*s);
      uv.push(uvs[i][0],uvs[i][1]);
      nor.push(s*0.6,0.8,c*0.6);
    }
    idx.push(base,base+1,base+2,base,base+2,base+3);
  };
  quad(0);quad(Math.PI/2);
  const g=new THREE.BufferGeometry();
  g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));
  g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
  g.setAttribute('normal',new THREE.Float32BufferAttribute(nor,3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

// 风向材质：顶点位移只作用于卡片上半部（y 归一化后取幂）
// 注入的变量统一 vc 前缀，避免和 three 内置标识符撞名
function windMaterial(map,{alphaTest=0.38,bend=0.30,bendZ=0.22,gust=0.28,roughness=0.92,cacheKey='windCard'}={}){
  const m=new THREE.MeshStandardMaterial({
    map,color:0xffffff,roughness,metalness:0,
    alphaTest,transparent:false,
    side:THREE.DoubleSide,
    envMapIntensity:0.85,
  });
  m.userData.uTime={value:0};
  m.onBeforeCompile=(shader)=>{
    shader.uniforms.uTime=m.userData.uTime;
    applyFog(shader);
    shader.vertexShader=shader.vertexShader
      .replace('#include <common>','#include <common>\nuniform float uTime;\nvarying vec3 vWPos;')
      .replace('#include <begin_vertex>',`#include <begin_vertex>
        #ifdef USE_INSTANCING
          vWPos=(modelMatrix*instanceMatrix*vec4(transformed,1.0)).xyz;
        #else
          vWPos=(modelMatrix*vec4(transformed,1.0)).xyz;
        #endif
        #ifdef USE_INSTANCING
          vec3 vcIp=vec3(instanceMatrix[3][0],instanceMatrix[3][1],instanceMatrix[3][2]);
        #else
          vec3 vcIp=vec3(0.0);
        #endif
        float vcSw=pow(clamp(position.y,0.0,1.0),1.7);
        float vcPh=vcIp.x*0.13+vcIp.z*0.17;
        float vcGust=${gust.toFixed(3)}+${gust.toFixed(3)}*sin(uTime*0.42+vcIp.x*0.019+vcIp.z*0.011);
        transformed.x+=sin(uTime*1.65+vcPh)*vcSw*${bend.toFixed(3)}*vcGust;
        transformed.z+=cos(uTime*1.21+vcPh*1.3)*vcSw*${bendZ.toFixed(3)}*vcGust;
        transformed.y-=vcSw*0.04*(0.5+0.5*sin(uTime*1.65+vcPh));
      `);
    shader.fragmentShader=shader.fragmentShader
      .replace('#include <common>','#include <common>\nvarying vec3 vWPos;');
  };
  m.customProgramCacheKey=()=>cacheKey;
  return m;
}

export function buildVegetation({grassTex,bushTex,flowerTex,field,counts={grass:26000,bushes:6000,flowers:0},seed=17}){
  const r=rng(seed);
  const group=new THREE.Group();
  const HALF=WORLD/2;
  const dummy=new THREE.Object3D();
  const c=new THREE.Color();

  // —— 成片掩码：让植被有疏密，不是均匀撒盐 ——
  const patch=(x,z)=>fbm3(x*0.006,z*0.006,2.7,3);
  // —— 大尺度"花区"：有的片区整片开花（花海），有的片区基本没花 ——
  const flowerZone=(x,z)=>clamp(fbm3(x*0.0031+7.7,z*0.0031-2.9,2.1,3)*1.5-0.2,0,1);

  const grassSpots=[],bushSpots=[];
  let guard=0;
  while(grassSpots.length<counts.grass&&guard++<counts.grass*16){
    const x=r.range(-HALF,HALF),z=r.range(-HALF,HALF);
    const y=field.heightAt(x,z);
    if(y<WATER_Y+0.9||y>108)continue;
    if(field.slopeAt(x,z)>0.62)continue;
    const p=patch(x,z);
    if(r.next()>0.35+p*0.9)continue;           // 稀疏区只留一点
    grassSpots.push([x,y,z,r.range(0.55,1.45)*(0.75+p*0.5)]);
  }

  guard=0;
  while(bushSpots.length<counts.bushes&&guard++<counts.bushes*18){
    const x=r.range(-HALF,HALF),z=r.range(-HALF,HALF);
    const y=field.heightAt(x,z);
    if(y<WATER_Y+1.6||y>112)continue;
    if(field.slopeAt(x,z)>0.58)continue;
    const p=patch(x,z);
    if(r.next()>0.25+p*1.0)continue;
    // 高处（崖顶）灌木更密，撑起"山有植被"的轮廓
    const alt=y>35?1.35:1.0;
    if(r.next()>alt*0.8)continue;
    bushSpots.push([x,y,z,r.range(1.3,3.4)]);
  }

  // —— 草 ——
  const grassGeo=crossCard();
  const grassMat=windMaterial(grassTex,{bend:0.30,bendZ:0.22,roughness:0.94,cacheKey:'windGrass'});
  const grass=new THREE.InstancedMesh(grassGeo,grassMat,grassSpots.length);
  grass.name='grass';
  grass.frustumCulled=false;
  grass.castShadow=false;grass.receiveShadow=true;
  grassSpots.forEach(([x,y,z,s],i)=>{
    dummy.position.set(x,y-0.06,z);
    dummy.rotation.set(0,r.range(0,6.283),0);
    dummy.scale.set(s*r.range(0.9,1.3),s*1.45,s*r.range(0.9,1.3));
    dummy.updateMatrix();
    grass.setMatrixAt(i,dummy.matrix);
    // 实例色在贴图基础上做明暗/色温变化：受光面偏黄绿亮、背光面偏冷暗。
    // 饱和度放到 18~50%，贴图已有颜色，太高会叠成荧光绿
    c.setHSL(r.range(0.16,0.30),r.range(0.18,0.50),r.range(0.55,0.95));
    grass.setColorAt(i,c);
  });
  grass.instanceMatrix.needsUpdate=true;
  if(grass.instanceColor)grass.instanceColor.needsUpdate=true;
  group.add(grass);

  // —— 灌木 ——
  const bushGeo=crossCard();
  const bushMat=windMaterial(bushTex,{alphaTest:0.42,bend:0.16,bendZ:0.13,gust:0.18,roughness:0.9,cacheKey:'windBush'});
  const bushes=new THREE.InstancedMesh(bushGeo,bushMat,bushSpots.length);
  bushes.name='bushes';
  bushes.frustumCulled=false;
  bushes.castShadow=true;bushes.receiveShadow=true;
  bushSpots.forEach(([x,y,z,s],i)=>{
    dummy.position.set(x,y-0.12,z);
    dummy.rotation.set(0,r.range(0,6.283),0);
    dummy.scale.set(s,s*r.range(0.55,0.95),s);
    dummy.updateMatrix();
    bushes.setMatrixAt(i,dummy.matrix);
    c.setHSL(r.range(0.20,0.34),r.range(0.04,0.16),r.range(0.46,0.80));
    bushes.setColorAt(i,c);
  });
  bushes.instanceMatrix.needsUpdate=true;
  if(bushes.instanceColor)bushes.instanceColor.needsUpdate=true;
  group.add(bushes);

  // —— 花丛（第三层）：参考片主体是粉紫花海。
  //     flowerZone 划出大块开花区，缓坡河谷/台地最盛，崖壁与河床干净 ——
  const flowersN=counts.flowers||0;
  const flowerSpots=[];
  guard=0;
  while(flowerSpots.length<flowersN&&guard++<flowersN*36){
    const x=r.range(-HALF,HALF),z=r.range(-HALF,HALF);
    const y=field.heightAt(x,z);
    if(y<WATER_Y+1.3||y>112)continue;
    if(field.slopeAt(x,z)>0.56)continue;
    const zone=flowerZone(x,z);
    if(zone<0.03)continue;                       // 有些片区干脆不开花
    const p=patch(x,z);
    // zone 主导成片：zone 强的区域通过率接近 7 成，弱区基本淘汰 → 视觉上是花海不是撒盐
    if(r.next()>0.06+zone*0.42+p*0.12)continue;
    const alt=clamp(1-(y-40)*0.012,0.5,1);       // 高处花稀一些
    if(r.next()>alt)continue;
    flowerSpots.push([x,y,z,r.range(1.8,3.6)]);
  }
  const flowerGeo=crossCard();
  const flowerMat=windMaterial(flowerTex,{alphaTest:0.28,bend:0.20,bendZ:0.14,gust:0.30,roughness:0.82,cacheKey:'windFlower'});
  const flowers=new THREE.InstancedMesh(flowerGeo,flowerMat,flowerSpots.length);
  flowers.name='flowers';
  flowers.frustumCulled=false;
  flowers.castShadow=false;flowers.receiveShadow=true;
  flowerSpots.forEach(([x,y,z,s],i)=>{
    dummy.position.set(x,y-0.05,z);
    dummy.rotation.set(0,r.range(0,6.283),0);
    // 横向铺开的花丛：宽 s、高只有 0.55~0.8s，趴在地面上，远看是一小片色块
    dummy.scale.set(s,s*r.range(0.55,0.80),s);
    dummy.updateMatrix();
    flowers.setMatrixAt(i,dummy.matrix);
    // 色相锁在紫~粉之间，只做明暗与饱和变化
    c.setHSL(r.range(0.86,0.98),r.range(0.30,0.62),r.range(0.55,0.95));
    flowers.setColorAt(i,c);
  });
  flowers.instanceMatrix.needsUpdate=true;
  if(flowers.instanceColor)flowers.instanceColor.needsUpdate=true;
  group.add(flowers);

  return {
    group,
    grassCount:grassSpots.length,
    bushCount:bushSpots.length,
    flowerCount:flowerSpots.length,
    treeCount:0,
    update(t){
      grassMat.userData.uTime.value=t;
      bushMat.userData.uTime.value=t;
      if(flowersN>0)flowerMat.userData.uTime.value=t;
    },
  };
}
