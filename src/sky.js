// 天空：程序化 HDR 天空球（太阳盘 >1 强度，供 bloom 抓），并烘成 cubemap → PMREM，
// 作为 scene.environment 给所有 PBR 材质提供真实 IBL。这一步是"塑料感 → 有质感"的分水岭。
import * as THREE from 'three';

const skyVert=/* glsl */`
varying vec3 vDir;
void main(){
  vDir=normalize(position);
  gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);
}`;

const skyFrag=/* glsl */`
precision highp float;
varying vec3 vDir;
uniform vec3 uSunDir;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunColor;
uniform float uCloud;
uniform float uTime;

float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float noise(vec2 p){
  vec2 i=floor(p),f=fract(p);
  vec2 u=f*f*(3.0-2.0*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),u.x),
             mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),u.x),u.y);
}
float fbm(vec2 p){
  float s=0.0,a=0.5;
  for(int i=0;i<5;i++){s+=a*noise(p);p=p*2.03+vec2(1.7,-3.1);a*=0.5;}
  return s;
}

void main(){
  vec3 d=normalize(vDir);
  float h=max(d.y,0.0);

  // 天顶 → 地平线渐变（在地平线附近压暗一点，避免"贴纸感"）
  float g=pow(1.0-h,3.2);
  vec3 sky=mix(uZenith,uHorizon,g);
  // 地平线以下：接一层大气雾色
  if(d.y<0.0) sky=mix(uHorizon,uHorizon*0.72,clamp(-d.y*3.0,0.0,1.0));

  // 太阳周围的前向散射（Mie 近似）
  float mu=max(dot(d,uSunDir),0.0);
  sky+=uSunColor*pow(mu,6.0)*0.30;
  sky+=uSunColor*pow(mu,140.0)*0.85;

  // 太阳盘（HDR，>10 会被 bloom 抓到）
  float disc=smoothstep(0.99955,0.99985,mu);
  sky+=uSunColor*disc*26.0;

  // 云层：投影到平面做 fbm，两层不同速度
  if(d.y>0.012){
    vec2 p=d.xz/(d.y+0.16);
    float c1=fbm(p*0.55+vec2(uTime*0.004,0.0));
    float c2=fbm(p*1.35-vec2(uTime*0.009,0.0));
    float cover=smoothstep(0.52,0.86,c1*0.7+c2*0.4)*uCloud;
    float shade=mix(0.55,1.25,smoothstep(0.35,0.85,c2));
    vec3 cloudCol=mix(uHorizon*1.15,uSunColor*1.35,clamp(mu*1.4,0.0,1.0))*shade;
    float fade=smoothstep(0.012,0.16,d.y);
    sky=mix(sky,cloudCol,cover*fade*0.82);
  }

  // 整体大气消光：越靠地平线越白（空中透视的"底子"）
  sky=mix(sky,uHorizon*1.05,pow(1.0-h,7.0)*0.55);

  gl_FragColor=vec4(sky,1.0);
}`;

export function buildSky(renderer,{sunDir=new THREE.Vector3(0.42,0.36,0.83).normalize()}={}){
  const uniforms={
    uSunDir:{value:sunDir.clone()},
    // ColorManagement 默认开启，Color(hex) 已经转成线性工作空间，不要再转一次
    uZenith:{value:new THREE.Color(0x2f6ba8)},
    uHorizon:{value:new THREE.Color(0xcfd9dc)},
    uSunColor:{value:new THREE.Color(0xfff1d4)},
    uCloud:{value:0.72},
    uTime:{value:0},
  };
  const mat=new THREE.ShaderMaterial({
    vertexShader:skyVert,fragmentShader:skyFrag,uniforms,
    side:THREE.BackSide,depthWrite:false,fog:false,
  });
  const mesh=new THREE.Mesh(new THREE.SphereGeometry(4200,48,32),mat);
  mesh.name='sky';
  mesh.frustumCulled=false;

  // —— 烘环境光：把天空渲进 cubemap，再 PMREM 成可采样的 irradiance ——
  const envScene=new THREE.Scene();
  const envSky=new THREE.Mesh(mesh.geometry,mat);
  envScene.add(envSky);

  const cubeRT=new THREE.WebGLCubeRenderTarget(256,{type:THREE.HalfFloatType});
  const cubeCam=new THREE.CubeCamera(1,9000,cubeRT);
  cubeCam.update(renderer,envScene);

  const pmrem=new THREE.PMREMGenerator(renderer);
  pmrem.compileCubemapShader();
  const envRT=pmrem.fromCubemap(cubeRT.texture);
  pmrem.dispose();
  cubeRT.dispose();

  return {
    mesh,
    envMap:envRT.texture,
    sunDir:uniforms.uSunDir.value.clone(),
    update(t){uniforms.uTime.value=t;},
  };
}
