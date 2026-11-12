// 起飞：渲染器 → 天空/IBL → 地形 → 水 → 岩块 → 植被 → 骑手 → HDR 后处理
import * as THREE from 'three';
import {
  makeRockSet,makeGrassAlbedo,
  makeBladeAtlas,makeBushAtlas,makeWaterNormal,makeFoamTex,makeDepthTexture,
} from './tex.js';
import {triplanarTerrain} from './mat.js';
import {buildField,buildTerrain,buildWater,buildRocks,WORLD,MAX_DEPTH,WATER_Y} from './terrain.js';
import {buildSky} from './sky.js';
import {buildVegetation} from './veg.js';
import {buildRider} from './rider.js';
import {Input,Flight,ChaseCamera} from './flight.js';
import {Post} from './post.js';
import {buildFX} from './fx.js';
import {FOG} from './fog.js';

const errBox=document.getElementById('err');
const origErr=console.error.bind(console);
const fail=(e)=>{
  errBox.style.display='block';
  errBox.textContent+=String(e&&e.stack||e)+'\n';
  origErr(e);
};
// 着色器编译失败只会走 console.error，不会抛异常 —— 必须接住，否则就是"黑屏无提示"
console.error=(...a)=>{fail(a.map(String).join(' ').slice(0,900));};
addEventListener('error',e=>fail(e.error||e.message));
addEventListener('unhandledrejection',e=>fail(e.reason));

const params=new URLSearchParams(location.search);
const quality=params.get('q')||'mid';
const RES=params.has('res')?parseInt(params.get('res')):(quality==='low'?256:quality==='high'?640:448);
const GRASS=params.has('grass')?parseInt(params.get('grass')):(quality==='low'?14000:quality==='high'?52000:36000);
const BUSHES=params.has('bushes')?parseInt(params.get('bushes')):(quality==='low'?1800:quality==='high'?11000:7000);
const ROCKS=params.has('rocks')?parseInt(params.get('rocks')):(quality==='low'?160:quality==='high'?700:460);

const canvas=document.getElementById('view');
const renderer=new THREE.WebGLRenderer({
  canvas,antialias:false,powerPreference:'high-performance',stencil:false,depth:true,
});
renderer.setClearColor(0x0b1014,1);
renderer.toneMapping=THREE.NoToneMapping;          // 色调映射在 post 里做
renderer.outputColorSpace=THREE.SRGBColorSpace;
renderer.shadowMap.enabled=true;
renderer.shadowMap.type=THREE.PCFSoftShadowMap;

const scene=new THREE.Scene();
const camera=new THREE.PerspectiveCamera(54,1,0.6,9000);

// —— 天空 + 环境光（IBL）——
const sunDir=new THREE.Vector3(0.38,0.34,0.86).normalize();
const sky=buildSky(renderer,{sunDir});
scene.add(sky.mesh);
scene.environment=sky.envMap;
// 雾的散射方向跟太阳一致
FOG.uFogSunDir.value.copy(sky.sunDir);

// 大气：只做"远山入雾"，密度压得很轻
// 雾色刻意取成天空地平线的颜色：远处的海和山才能"化"进天空里，看不出边界
scene.fog=new THREE.FogExp2(0xcfd9dc,0.00062);

// —— 太阳光 ——
const sun=new THREE.DirectionalLight(0xffeccd,2.6);
sun.castShadow=true;
sun.shadow.mapSize.set(2048,2048);
const SC=150;
sun.shadow.camera.left=-SC;sun.shadow.camera.right=SC;
sun.shadow.camera.top=SC;sun.shadow.camera.bottom=-SC;
sun.shadow.camera.near=1;sun.shadow.camera.far=900;
sun.shadow.bias=-0.0006;
sun.shadow.normalBias=0.55;
scene.add(sun);
scene.add(sun.target);

const hemi=new THREE.HemisphereLight(0xbcd6f0,0x4a5a3a,0.30);
scene.add(hemi);

// —— 贴图 ——
// 岩壁三件套（块面/裂缝/遮蔽）一次生成，反照率、法线、AO 全部同源
const rockSet=makeRockSet(512,14);
const grassAlbedo=makeGrassAlbedo(512);
const bladeAtlas=makeBladeAtlas(128);
const bushAtlas=makeBushAtlas(128);
const waterNrm=makeWaterNormal(256);
const foamTex=makeFoamTex(256);
// 高度场只求值一次：地形网格 / 水深图 / 撒点 / 飞行碰撞全部复用它
const field=buildField(RES);
const depthTex=makeDepthTexture((x,z)=>field.heightAt(x,z),WORLD,1024,MAX_DEPTH);

// —— 地形 ——
const terrain=buildTerrain(field);
const terrainMat=triplanarTerrain({
  rockAlbedo:rockSet.albedo,grassAlbedo,
  rockNormal:rockSet.normal,rockAO:rockSet.ao,
  scale:0.052,normalStrength:0.62,envIntensity:1.0,macro:0.38,
});
const terrainMesh=new THREE.Mesh(terrain.geometry,terrainMat);
terrainMesh.receiveShadow=true;
terrainMesh.castShadow=true;
terrainMesh.name='terrain';
scene.add(terrainMesh);

// —— 水面 ——
const water=buildWater({normalMap:waterNrm,foamTex,depthTex});
scene.add(water.mesh);

// —— 散落岩块（崖脚碎石 + 河床卵石）——
const rockMat=triplanarTerrain({
  rockAlbedo:rockSet.albedo,grassAlbedo,
  rockNormal:rockSet.normal,rockAO:rockSet.ao,
  scale:0.13,normalStrength:0.95,envIntensity:1.0,macro:0.10,
});
const rocks=buildRocks(rockMat,field,{count:ROCKS});
scene.add(rocks.mesh);

// —— 植被 ——
const veg=buildVegetation({grassTex:bladeAtlas,bushTex:bushAtlas,field,counts:{grass:GRASS,bushes:BUSHES}});
scene.add(veg.group);

// —— 骑手 ——
const rider=buildRider();
scene.add(rider.group);

// —— 速度感特效 ——
const fx=buildFX(scene);

// —— 飞行 ——
const input=new Input();
const flight=new Flight(field,new THREE.Vector3(-14,46,250));
const chase=new ChaseCamera(camera);

addEventListener('keydown',e=>{if(e.code==='KeyC'){chase.mode='cine';chase.init=false;}});
addEventListener('keyup',e=>{if(e.code==='KeyC'){chase.mode='chase';}});

// —— 后处理 ——
const post=new Post(renderer);
function resize(){
  const w=innerWidth,h=innerHeight;
  renderer.setPixelRatio(Math.min(devicePixelRatio||1,quality==='low'?0.85:1.25));
  renderer.setSize(w,h,false);
  camera.aspect=w/h;camera.updateProjectionMatrix();
  post.setSize(renderer.domElement.width,renderer.domElement.height);
}
addEventListener('resize',resize);
resize();

// —— 主循环 ——
const clock=new THREE.Clock();
let t=0,frames=0,fpsT=0,fps=0,lastWake=-9;
const speedEl=document.getElementById('speed');

// 固定机位：?look=1 直接看峡谷景（用来和参考图对比构图，不进入飞行）
if(params.has('look')){
  chase.init=true;chase.mode='fixed';
  chase.pos.set(-120,58,318);chase.look.set(30,18,120);
}

function frame(){
  requestAnimationFrame(frame);
  const dt=Math.min(clock.getDelta(),1/20);
  t+=dt;frames++;fpsT+=dt;
  if(fpsT>0.5){fps=Math.round(frames/fpsT);frames=0;fpsT=0;}

  input.poll();
  flight.update(dt,input);
  flight.pose(rider.group);
  rider.update(t,{speed:flight.speed,bank:flight.roll});
  chase.update(dt,flight,input.boost&&!input.brake);

  // 相机微抖：高速时给一点点不稳定，画面立刻"有重量"
  const shake=Math.min(flight.speed/42,1)*Math.min(flight.speed/16,1);
  camera.position.x+=Math.sin(t*41.3)*0.030*shake;
  camera.position.y+=Math.sin(t*33.7+1.7)*0.026*shake;
  camera.position.z+=Math.sin(t*27.1+0.6)*0.022*shake;

  fx.update(dt,t,flight,camera);

  // 掠水：贴着水面飞时把轨迹点喂给水面，形成曳波
  if(flight.pos.y<7.5){
    const gy=field.heightAt(flight.pos.x,flight.pos.z);
    if(gy<-0.6&&t-lastWake>0.085){
      water.pushWake(flight.pos.x,flight.pos.z,t,Math.min(1,flight.speed/26));
      lastWake=t;
    }
    // 水花：贴水且有一定速度才喷
    if(gy<-0.6&&flight.pos.y<5.5&&flight.speed>9){
      fx.emitSpray(flight.pos,flight.forward,flight.speed,2);
    }
  }

  veg.update(t);
  water.update(t);
  sky.update(t);

  // 阴影相机跟着骑手走，保证近处阴影分辨率
  sun.target.position.copy(flight.pos);
  sun.position.copy(flight.pos).addScaledVector(sky.sunDir,320);
  sun.target.updateMatrixWorld();

  // 天空球与水面向跟随相机 → 视觉上是"一望无际"，永远看不到平面边缘
  sky.mesh.position.copy(camera.position);
  water.mesh.position.set(camera.position.x,WATER_Y,camera.position.z);

  speedEl.textContent=Math.round(flight.speed*3.6)+' km/h';

  post.render(scene,camera,t);
}

requestAnimationFrame(()=>{
  document.getElementById('loading').classList.add('gone');
  frame();
});

// 给截图工具/调试用
window.wetPaintReal={
  THREE,scene,camera,renderer,flight,chase,post,veg,terrain,sky,rider,rocks,water,
  info(){return {res:RES,grass:veg.grassCount,bushes:veg.bushCount,rocks:rocks.count,fps,
    draws:renderer.info.render.calls,tris:renderer.info.render.triangles};},
  look(x,y,z,tx,ty,tz){chase.init=true;chase.mode='fixed';chase.pos.set(x,y,z);chase.look.set(tx,ty,tz);},
  free(){chase.mode='chase';chase.init=false;},
  tone(o={}){const u=post.compMat.uniforms;for(const k in o)if(u[k])u[k].value=o[k];},
};
