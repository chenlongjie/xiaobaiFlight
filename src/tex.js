// 程序化贴图：不出仓库、不下载任何图片，全部用 2D canvas 现画。
// 写实感的一大半来自「贴图的多尺度细节」，所以这层不能省。
import * as THREE from 'three';
import {clamp,lerp,fbm2,ridged2,vnoise3} from './util.js';

function canvas(size){
  const c=document.createElement('canvas');c.width=size;c.height=size;
  return c;
}
function finish(c,{repeat=1,aniso=8}={}){
  const t=new THREE.CanvasTexture(c);
  t.wrapS=t.wrapT=THREE.RepeatWrapping;
  t.repeat.set(repeat,repeat);
  t.anisotropy=aniso;
  t.colorSpace=THREE.SRGBColorSpace;
  t.needsUpdate=true;
  return t;
}

// 高度图 → 法线图（Sobel），用于地表微起伏
function heightToNormal(c,strength=2.0){
  const s=c.width,src=c.getContext('2d').getImageData(0,0,s,s).data;
  const out=canvas(s),ctx=out.getContext('2d'),img=ctx.createImageData(s,s);
  const H=(x,y)=>{
    const xi=(x+s)%s,yi=(y+s)%s;
    return src[(yi*s+xi)*4]/255;
  };
  for(let y=0;y<s;y++)for(let x=0;x<s;x++){
    const dx=(H(x+1,y)-H(x-1,y))*strength;
    const dy=(H(x,y+1)-H(x,y-1))*strength;
    const len=Math.hypot(dx,dy,1);
    const i=(y*s+x)*4;
    img.data[i]  =(dx/len*0.5+0.5)*255;
    img.data[i+1]=(dy/len*0.5+0.5)*255;
    img.data[i+2]=(1/len*0.5+0.5)*255;
    img.data[i+3]=255;
  }
  ctx.putImageData(img,0,0);
  const t=new THREE.CanvasTexture(out);
  t.wrapS=t.wrapT=THREE.RepeatWrapping;
  t.anisotropy=4;
  t.needsUpdate=true;
  return t;
}

// 岩壁贴图：必须是**各向同性**的。
// 这里踩过一个大坑：早期版本在贴图里画了"水平层理"（constant-v 的条纹），
// 三平面投影后 texture.v 正好对应世界 Y → 整个崖壁变成一圈圈等高线。
// 所以岩壁贴图里不允许出现任何方向性结构，方向感交给几何（扶壁/冲沟）和法线。
export function makeRockAlbedo(size=512){
  const c=canvas(size),ctx=c.getContext('2d'),img=ctx.createImageData(size,size);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const u=x/size*8,v=y/size*8;
    const m1=fbm2(u*0.62,v*0.62,4);    // 大块色斑
    const m2=fbm2(u*2.7,v*2.7,4);      // 中等岩块
    const m3=fbm2(u*9.0,v*9.0,3);      // 细颗粒
    const m4=fbm2(u*24.0,v*24.0,2);    // 砂粒
    let l=0.38+m1*0.28+m2*0.15+m3*0.10+m4*0.055;
    // 深色矿物斑点
    const speck=Math.pow(clamp((fbm2(u*13.0+41,v*13.0+9,2)-0.60)*3.4,0,1),1.3);
    l-=speck*0.20;
    l=clamp(l,0.07,0.93);
    const warm=clamp(m2*1.5-0.25,0,1);          // 冷灰 ↔ 暖砂岩
    const r=l*(0.99+warm*0.15), g=l*(0.96+warm*0.05), b=l*(0.91-warm*0.07);
    const i4=(y*size+x)*4;
    img.data[i4]=r*255;img.data[i4+1]=g*255;img.data[i4+2]=b*255;img.data[i4+3]=255;
  }
  ctx.putImageData(img,0,0);
  return finish(c);
}

// 草地：低频色斑 + 高频碎叶
export function makeGrassAlbedo(size=512){
  const c=canvas(size),ctx=c.getContext('2d'),img=ctx.createImageData(size,size);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const u=x/size*8,v=y/size*8;
    const patch=fbm2(u*0.55,v*0.55,4);
    const fine=fbm2(u*6.5,v*6.5,3);
    const dry=clamp((patch-0.45)*2.4,0,1);
    const soil=clamp((fbm2(u*0.19+31,v*0.19+7,3)-0.56)*3.0,0,1);   // 露土
    // 暗橄榄 → 枯黄（真实草地远没有纯绿那么艳）
    let r=lerp(0.15,0.38,dry);
    let g=lerp(0.20,0.36,dry);
    let b=lerp(0.085,0.145,dry);
    const v2=fine-0.5;
    r+=v2*0.10; g+=v2*0.11; b+=v2*0.055;
    // 露土处压成红棕
    r=lerp(r,0.27,soil*0.62); g=lerp(g,0.22,soil*0.62); b=lerp(b,0.145,soil*0.62);
    const shade=0.72+fine*0.5;
    const i=(y*size+x)*4;
    img.data[i]=clamp(r*shade,0,1)*255;
    img.data[i+1]=clamp(g*shade,0,1)*255;
    img.data[i+2]=clamp(b*shade,0,1)*255;
    img.data[i+3]=255;
  }
  ctx.putImageData(img,0,0);
  return finish(c);
}

// 地表法线：中等尺度的起伏（岩块感 / 草垄）
export function makeGroundNormal(size=512){
  const c=canvas(size),ctx=c.getContext('2d'),img=ctx.createImageData(size,size);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const u=x/size*8,v=y/size*8;
    const h=ridged2(u*2.2,v*2.2,4)*0.7+fbm2(u*7,v*7,3)*0.3;
    const i=(y*size+x)*4;
    img.data[i]=img.data[i+1]=img.data[i+2]=clamp(h,0,1)*255;
    img.data[i+3]=255;
  }
  ctx.putImageData(img,0,0);
  return heightToNormal(c,2.6);
}

// 草叶簇图集（带 alpha）：一株由多片细长叶构成
export function makeBladeAtlas(size=128){
  const c=canvas(size),ctx=c.getContext('2d');
  ctx.clearRect(0,0,size,size);
  const blades=11;
  for(let i=0;i<blades;i++){
    const x0=size*(0.12+0.76*(i/(blades-1)))+ (Math.random()-0.5)*size*0.05;
    const h=size*(0.55+Math.random()*0.42);
    const w=size*(0.026+Math.random()*0.022);
    const lean=(Math.random()-0.5)*size*0.34;
    const g=ctx.createLinearGradient(0,size,0,size-h);
    const base=`hsl(${72+Math.random()*22},${22+Math.random()*16}%,${24+Math.random()*12}%)`;
    const tip =`hsl(${66+Math.random()*24},${28+Math.random()*16}%,${40+Math.random()*16}%)`;
    g.addColorStop(0,base);g.addColorStop(0.55,base);g.addColorStop(1,tip);
    ctx.fillStyle=g;
    ctx.beginPath();
    ctx.moveTo(x0-w,size);
    ctx.quadraticCurveTo(x0-w*0.4+lean*0.4,size-h*0.55,x0+lean,size-h);
    ctx.quadraticCurveTo(x0+w*0.6+lean*0.5,size-h*0.5,x0+w,size);
    ctx.closePath();ctx.fill();
  }
  const t=new THREE.CanvasTexture(c);
  t.colorSpace=THREE.SRGBColorSpace;t.anisotropy=4;t.needsUpdate=true;
  return t;
}

// 水面法线：用"随机波谱"（多条整数波数的正弦叠加）生成。
// 之前用两条正弦干涉，出来的是规则菱形网格——这就是"波纹不合理"的根源。
// 整数波数保证天然可平铺，叠加 28 条后方向、波长、相位都散开，才像真的水面。
export function makeWaterNormal(size=512){
  const rnd=mulberry(20261112);
  const waves=[];
  for(let i=0;i<28;i++){
    let kx,ky,m;
    do{
      kx=Math.round((rnd()*2-1)*7);
      ky=Math.round((rnd()*2-1)*7);
      m=Math.hypot(kx,ky);
    }while(m<0.8);
    // 能量按波数衰减：短波振幅小
    const amp=1/Math.pow(m,1.05);
    waves.push([kx,ky,amp,rnd()*Math.PI*2]);
  }
  const total=waves.reduce((a,w)=>a+w[2],0);

  const H=(u,v)=>{
    let h=0;
    for(const [kx,ky,amp,ph] of waves){
      h+=amp*Math.sin(2*Math.PI*(kx*u+ky*v)+ph);
    }
    return h/total*0.5+0.5;
  };

  const c=canvas(size),ctx=c.getContext('2d'),img=ctx.createImageData(size,size);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const h=H(x/size,y/size);
    const i4=(y*size+x)*4;
    img.data[i4]=img.data[i4+1]=img.data[i4+2]=clamp(h,0,1)*255;
    img.data[i4+3]=255;
  }
  ctx.putImageData(img,0,0);
  // strength 压低：水面法线是"微起伏"，不是"波浪起伏"
  return heightToNormal(c,1.25);
}

function mulberry(seed){
  let a=seed>>>0;
  return function(){
    a|=0;a=a+0x6D2B79F5|0;
    let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;
    return ((t^t>>>14)>>>0)/4294967296;
  };
}

// 泡沫：黑白斑块，用于岸线浪花
export function makeFoamTex(size=256){
  const c=canvas(size),ctx=c.getContext('2d');
  ctx.fillStyle='#000';ctx.fillRect(0,0,size,size);
  for(let i=0;i<520;i++){
    const x=Math.random()*size,y=Math.random()*size;
    const r=size*(0.006+Math.random()*0.030);
    const a=0.10+Math.random()*0.55;
    const g=ctx.createRadialGradient(x,y,0,x,y,r);
    g.addColorStop(0,`rgba(255,255,255,${a})`);
    g.addColorStop(1,'rgba(255,255,255,0)');
    ctx.fillStyle=g;ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();
  }
  // 一点拉丝，让泡沫有方向感
  ctx.globalCompositeOperation='lighter';
  for(let i=0;i<70;i++){
    const y=Math.random()*size;
    const h=1+Math.random()*2;
    ctx.fillStyle=`rgba(255,255,255,${0.05+Math.random()*0.12})`;
    ctx.fillRect(0,y,size,h);
  }
  ctx.globalCompositeOperation='source-over';
  const t=new THREE.CanvasTexture(c);
  t.wrapS=t.wrapT=THREE.RepeatWrapping;
  t.needsUpdate=true;
  return t;
}

// 水面深度图：整张世界按 XZ 铺一张，存"水深"（0=岸线，1=深水）
// 用 DataTexture，单通道，着色器里按世界坐标采样 → 免费的岸线渐变/浅水透光/泡沫带
export function makeDepthTexture(terrainHeight,worldSize,resolution=512,maxDepth=9){
  const data=new Uint8Array(resolution*resolution*4);
  const step=worldSize/resolution,half=worldSize/2;
  for(let j=0;j<resolution;j++){
    for(let i=0;i<resolution;i++){
      const x=-half+(i+0.5)*step, z=-half+(j+0.5)*step;
      const y=terrainHeight(x,z);
      const d=Math.max(0,-y)/maxDepth;
      const v=Math.min(255,Math.round(d*255));
      const k=(j*resolution+i)*4;
      data[k]=v;data[k+1]=v;data[k+2]=v;data[k+3]=255;
    }
  }
  const t=new THREE.DataTexture(data,resolution,resolution,THREE.RGBAFormat);
  t.wrapS=t.wrapT=THREE.ClampToEdgeWrapping;
  t.minFilter=t.magFilter=THREE.LinearFilter;
  t.needsUpdate=true;
  return t;
}


// 灌木/叶丛图集（带 alpha）：没有树干，只有一堆叶子团成的球
// 这是"树太假"的替代方案——不做树，做地被灌木层
export function makeBushAtlas(size=128){
  const c=canvas(size),ctx=c.getContext('2d');
  ctx.clearRect(0,0,size,size);
  const leaves=64;
  for(let i=0;i<leaves;i++){
    const a=Math.random()*Math.PI*2;
    const rr=Math.pow(Math.random(),0.55);
    const cx=size*0.5+Math.cos(a)*rr*size*0.40;
    const cy=size*0.56+Math.sin(a)*rr*size*0.34;
    const w=size*(0.035+Math.random()*0.055);
    const h=w*(0.55+Math.random()*0.5);
    // 越靠下越暗，模拟内部遮蔽
    const dark=0.55+0.45*(1-rr)+0.18*Math.random();
    const hue=74+Math.random()*26;
    const sat=20+Math.random()*18;
    const lig=(14+Math.random()*16)*(0.7+dark*0.6);
    ctx.save();
    ctx.translate(cx,cy);
    ctx.rotate(Math.random()*Math.PI*2);
    ctx.fillStyle=`hsl(${hue},${sat}%,${lig}%)`;
    ctx.beginPath();
    ctx.ellipse(0,0,w,h,0,0,Math.PI*2);
    ctx.fill();
    ctx.restore();
  }
  const t=new THREE.CanvasTexture(c);
  t.colorSpace=THREE.SRGBColorSpace;
  t.anisotropy=4;
  t.needsUpdate=true;
  return t;
}

// 岩壁贴图：**不用任何"格"结构**。
// 走过的弯路：Voronoi 切块 → 崖面像龟壳/棋盘；水平层理 → 一圈圈等高线。
// 结论：岩石的"刀劈斧凿"感应该由几何（扶壁、沟壑、断面）承担，
// 贴图只负责**各向同性的粗糙度与色差**。这里用 ridged 噪声的脊线做不规则的碎石棱，
// 它分支、断续、不对齐任何网格，远看是"杂乱的岩面"，近看有颗粒。
export function makeRockSet(size=512){
  const H=new Float32Array(size*size);
  const crease=new Float32Array(size*size);

  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const u=x/size,v=y/size;
    const r1=ridged2(u*2.6,v*2.6,5);            // 大尺度碎棱
    const r2=ridged2(u*6.9+13.7,v*6.9+7.3,4);   // 中尺度
    const r3=fbm2(u*17.0+3.1,v*17.0+9.4,3);     // 细颗粒
    const grain=fbm2(u*47.0,v*47.0,2);          // 砂粒
    // 密度不均匀：有的段落碎裂、有的段落被风化磨平
    const dens=clamp((fbm2(u*1.35+21,v*1.35+5,3)-0.30)*2.1,0,1);
    let h=0.44
      +(r1-0.5)*0.50*(0.30+dens*0.70)
      +(r2-0.5)*0.26
      +(r3-0.5)*0.16
      +(grain-0.5)*0.09;
    h=clamp(h,0,1);
    H[y*size+x]=h;
    crease[y*size+x]=clamp((0.5-h)*2.2,0,1);    // 低处=凹槽
  }

  const ca=canvas(size),cax=ca.getContext('2d'),ia=cax.createImageData(size,size);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const u=x/size,v=y/size;
    const h=H[y*size+x],cr=crease[y*size+x];
    const rust=clamp((fbm2(u*1.7+17,v*1.7+31,3)-0.52)*2.6,0,1);
    const vein=clamp((fbm2(u*3.4+5,v*3.4+9,2)-0.60)*2.8,0,1);
    let l=0.40+(h-0.5)*0.50-cr*0.16;      // 凹槽压暗
    l*=1.0-vein*0.14;
    l=clamp(l,0.06,0.94);
    const k=(y*size+x)*4;
    ia.data[k]  =clamp(l*(1.00+rust*0.26),0,1)*255;
    ia.data[k+1]=clamp(l*(0.96+rust*0.05),0,1)*255;
    ia.data[k+2]=clamp(l*(0.91-rust*0.12),0,1)*255;
    ia.data[k+3]=255;
  }
  cax.putImageData(ia,0,0);

  const cn=canvas(size),cnx=cn.getContext('2d'),inn=cnx.createImageData(size,size);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const Hc=(a,b)=>H[((b+size)%size)*size+((a+size)%size)];
    const dx=(Hc(x+1,y)-Hc(x-1,y))*3.0;
    const dy=(Hc(x,y+1)-Hc(x,y-1))*3.0;
    const len=Math.hypot(dx,dy,1);
    const k=(y*size+x)*4;
    inn.data[k]  =(dx/len*0.5+0.5)*255;
    inn.data[k+1]=(dy/len*0.5+0.5)*255;
    inn.data[k+2]=(1/len*0.5+0.5)*255;
    inn.data[k+3]=255;
  }
  cnx.putImageData(inn,0,0);

  const co=canvas(size),cox=co.getContext('2d'),io=cox.createImageData(size,size);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const cr=crease[y*size+x];
    const n=fbm2(x/size*18,y/size*18,3);
    const ao=clamp(0.72-cr*0.30+n*0.12,0,1);
    const k=(y*size+x)*4;
    io.data[k]=io.data[k+1]=io.data[k+2]=ao*255;io.data[k+3]=255;
  }
  cox.putImageData(io,0,0);

  const mk=(c,srgb)=>{const t=new THREE.CanvasTexture(c);t.wrapS=t.wrapT=THREE.RepeatWrapping;t.anisotropy=8;if(srgb)t.colorSpace=THREE.SRGBColorSpace;t.needsUpdate=true;return t;};
  return {albedo:mk(ca,true),normal:mk(cn,false),ao:mk(co,false)};
}
