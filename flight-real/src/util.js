// 数学与噪声工具：飞行壳只用到 clamp/lerp/damp，其余给地形与贴图用。
import * as THREE from 'three';

export const clamp=(v,a,b)=>v<a?a:v>b?b:v;
export const lerp=(a,b,t)=>a+(b-a)*t;
export const smoothstep=(a,b,v)=>{const t=clamp((v-a)/(b-a),0,1);return t*t*(3-2*t);};
export const damp=(a,b,lambda,dt)=>lerp(a,b,1-Math.exp(-lambda*dt));

// 确定性随机，保证每次刷新峡谷一致
export function rng(seed=1){
  let s=seed>>>0;
  return {
    next(){s=(s*1664525+1013904223)>>>0;return s/4294967296;},
    range(a,b){return a+(b-a)*this.next();},
    pick(a){return a[(this.next()*a.length)|0];},
    sign(){return this.next()<.5?-1:1;},
  };
}

// --- 3D 值噪声 ---------------------------------------------------------------
function hash3(x,y,z){
  let h=x*374761393+y*668265263+z*2147483647;
  h=(h^(h>>13))*1274126177;
  return ((h^(h>>16))>>>0)/4294967296;
}
export function vnoise3(x,y,z){
  const ix=Math.floor(x),iy=Math.floor(y),iz=Math.floor(z);
  const fx=x-ix,fy=y-iy,fz=z-iz;
  const ux=fx*fx*(3-2*fx),uy=fy*fy*(3-2*fy),uz=fz*fz*(3-2*fz);
  const c=(dx,dy,dz)=>hash3(ix+dx,iy+dy,iz+dz);
  const x00=lerp(c(0,0,0),c(1,0,0),ux),x10=lerp(c(0,1,0),c(1,1,0),ux);
  const x01=lerp(c(0,0,1),c(1,0,1),ux),x11=lerp(c(0,1,1),c(1,1,1),ux);
  return lerp(lerp(x00,x10,uy),lerp(x01,x11,uy),uz);
}
export function fbm3(x,y,z,oct=4,lac=2.03,gain=0.5){
  let a=0.5,f=1,s=0,n=0;
  for(let i=0;i<oct;i++){s+=a*vnoise3(x*f,y*f,z*f);n+=a;a*=gain;f*=lac;}
  return s/n;
}
export function fbm2(x,y,oct=4){
  return fbm3(x,y,0.37,oct);
}
export function ridged2(x,y,oct=4){
  let a=0.5,f=1,s=0,n=0;
  for(let i=0;i<oct;i++){
    const v=1-Math.abs(vnoise3(x*f,y*f,0.11)*2-1);
    s+=a*v*v;n+=a;a*=0.5;f*=2.07;
  }
  return s/n;
}

export const v3=(x=0,y=0,z=0)=>new THREE.Vector3(x,y,z);
