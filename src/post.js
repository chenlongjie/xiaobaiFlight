// HDR 后处理链：场景 → 半浮点线性缓冲 → 亮部提取 → 分离式高斯模糊 → 合成（ACES + 分级 + 暗角）。
// 这是"画面像 CG"的最后一层，也是 LDR 直出永远补不回来的那一段。
import * as THREE from 'three';

const vert=/* glsl */`
varying vec2 vUv;
void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}`;

const brightFrag=/* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform float uThreshold,uSoft;
void main(){
  vec3 c=texture2D(tSrc,vUv).rgb;
  float l=dot(c,vec3(0.2126,0.7152,0.0722));
  float k=smoothstep(uThreshold,uThreshold+uSoft,l);
  gl_FragColor=vec4(c*k,1.0);
}`;

const blurFrag=/* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uDir;
void main(){
  vec3 s=vec3(0.0);
  s+=texture2D(tSrc,vUv-uDir*4.0).rgb*0.051;
  s+=texture2D(tSrc,vUv-uDir*3.0).rgb*0.0918;
  s+=texture2D(tSrc,vUv-uDir*2.0).rgb*0.1231;
  s+=texture2D(tSrc,vUv-uDir*1.0).rgb*0.1501;
  s+=texture2D(tSrc,vUv).rgb*0.1680;
  s+=texture2D(tSrc,vUv+uDir*1.0).rgb*0.1501;
  s+=texture2D(tSrc,vUv+uDir*2.0).rgb*0.1231;
  s+=texture2D(tSrc,vUv+uDir*3.0).rgb*0.0918;
  s+=texture2D(tSrc,vUv+uDir*4.0).rgb*0.051;
  gl_FragColor=vec4(s,1.0);
}`;

const compFrag=/* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tScene,tBloom;
uniform float uExposure,uBloomK,uSat,uContrast,uVignette,uGrain,uTime,uAberr;

vec3 aces(vec3 x){
  const float a=2.51,b=0.03,c=2.43,d=0.59,e=0.14;
  return clamp((x*(a*x+b))/(x*(c*x+d)+e),0.0,1.0);
}
vec3 lin2srgb(vec3 c){
  return mix(c*12.92,1.055*pow(max(c,vec3(0.0)),vec3(1.0/2.4))-0.055,step(0.0031308,c));
}
float hash(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}

void main(){
  vec2 uv=vUv;
  // 极轻的色散，边缘才有一点“镜头味”
  vec2 d=uv-0.5;
  float ab=uAberr*dot(d,d);
  vec3 col;
  col.r=texture2D(tScene,uv-d*ab).r;
  col.g=texture2D(tScene,uv).g;
  col.b=texture2D(tScene,uv+d*ab).b;

  col+=texture2D(tBloom,uv).rgb*uBloomK;

  col*=uExposure;
  col=aces(col);

  // 分级：暗部往青蓝压、亮部留暖，中间调提一点对比
  float l=dot(col,vec3(0.2126,0.7152,0.0722));
  col=mix(vec3(l),col,uSat);
  col=(col-0.5)*uContrast+0.5;
  col=mix(col*vec3(0.95,1.0,1.06),col,smoothstep(0.0,0.55,l));   // 暗部偏冷
  col=mix(col,col*vec3(1.05,1.0,0.94),smoothstep(0.55,1.0,l));   // 亮部偏暖

  // 暗角
  float v=1.0-uVignette*dot(d,d)*2.0;
  col*=clamp(v,0.0,1.0);

  col=clamp(col,0.0,1.0);
  col=lin2srgb(col);

  // 胶片颗粒（在 sRGB 域加，才像真的）
  float g=hash(uv*vec2(1024.0,768.0)+uTime*37.0)-0.5;
  col+=g*uGrain;

  gl_FragColor=vec4(col,1.0);
}`;

export class Post{
  constructor(renderer){
    this.renderer=renderer;
    this.sceneRT=null;
    this.brightRT=null;
    this.blurA=null;this.blurB=null;

    this.brightMat=new THREE.ShaderMaterial({
      vertexShader:vert,fragmentShader:brightFrag,depthTest:false,depthWrite:false,
      uniforms:{tSrc:{value:null},uThreshold:{value:1.05},uSoft:{value:0.6}},
    });
    this.blurMat=new THREE.ShaderMaterial({
      vertexShader:vert,fragmentShader:blurFrag,depthTest:false,depthWrite:false,
      uniforms:{tSrc:{value:null},uDir:{value:new THREE.Vector2()}},
    });
    this.compMat=new THREE.ShaderMaterial({
      vertexShader:vert,fragmentShader:compFrag,depthTest:false,depthWrite:false,
      uniforms:{
        tScene:{value:null},tBloom:{value:null},
        uExposure:{value:1.0},uBloomK:{value:0.55},
        uSat:{value:1.06},uContrast:{value:1.04},
        uVignette:{value:0.36},uGrain:{value:0.018},
        uTime:{value:0},uAberr:{value:0.0035},
      },
    });

    const quad=new THREE.PlaneGeometry(2,2);
    this.quadScene=new THREE.Scene();
    this.quadCam=new THREE.OrthographicCamera(-1,1,1,-1,0,1);
    this.quadMesh=new THREE.Mesh(quad,this.compMat);
    this.quadMesh.frustumCulled=false;
    this.quadScene.add(this.quadMesh);
  }

  setSize(w,h){
    const dispose=(rt)=>{if(rt)rt.dispose();};
    dispose(this.sceneRT);dispose(this.brightRT);dispose(this.blurA);dispose(this.blurB);

    this.sceneRT=new THREE.WebGLRenderTarget(w,h,{
      type:THREE.HalfFloatType,
      minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter,
      depthBuffer:true,
      samples:4,          // 场景直出 MSAA，替代 TAA 抗锯齿（成本低、无重影）
    });
    const bw=Math.max(2,Math.floor(w/2)),bh=Math.max(2,Math.floor(h/2));
    const mk=()=>new THREE.WebGLRenderTarget(bw,bh,{
      type:THREE.HalfFloatType,minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter,
      depthBuffer:false,
    });
    this.brightRT=mk();
    this.blurA=mk();
    this.blurB=mk();
    this.compMat.uniforms.tScene.value=this.sceneRT.texture;
  }

  render(scene,camera,time){
    const r=this.renderer;
    // 1) 场景 → 线性 HDR
    r.setRenderTarget(this.sceneRT);
    r.clear();
    r.render(scene,camera);

    // 2) 亮部
    this.quadMesh.material=this.brightMat;
    this.brightMat.uniforms.tSrc.value=this.sceneRT.texture;
    r.setRenderTarget(this.brightRT);
    r.clear();
    r.render(this.quadScene,this.quadCam);

    // 3) 分离式模糊 ×2 轮
    this.quadMesh.material=this.blurMat;
    const bw=this.brightRT.width,bh=this.brightRT.height;
    for(let i=0;i<2;i++){
      const k=1+i*1.6;
      this.blurMat.uniforms.tSrc.value=this.brightRT.texture;
      this.blurMat.uniforms.uDir.value.set(k/bw,0);
      r.setRenderTarget(this.blurA);r.clear();r.render(this.quadScene,this.quadCam);

      this.blurMat.uniforms.tSrc.value=this.blurA.texture;
      this.blurMat.uniforms.uDir.value.set(0,k/bh);
      r.setRenderTarget(this.blurB);r.clear();r.render(this.quadScene,this.quadCam);
    }

    // 4) 合成 → 屏幕
    this.quadMesh.material=this.compMat;
    this.compMat.uniforms.tBloom.value=this.blurB.texture;
    this.compMat.uniforms.uTime.value=time;
    r.setRenderTarget(null);
    r.clear();
    r.render(this.quadScene,this.quadCam);
  }
}
