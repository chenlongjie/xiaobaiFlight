// 大气：高度雾 + 朝太阳方向的前向散射。
// 原来的 THREE.FogExp2 是"均匀雾"，近处和远处一个浓度，
// 所以山谷底和崖顶一起发白，远景完全没有层次。
// 这里改成：密度随海拔指数衰减（谷底浓、山顶清），
// 并且雾色朝向太阳时会转暖（Mie 前向散射），逆光时才有一层亮边。
import * as THREE from 'three';

export const FOG={
  uFogColor:{value:new THREE.Color(0xcfd9dc)},
  uFogSun:{value:new THREE.Color(0xffe9cc)},
  uFogSunDir:{value:new THREE.Vector3(0.38,0.34,0.86).normalize()},
  uFogDensity:{value:0.00062},
  uFogFalloff:{value:0.0085},
};

const CHUNK=`#ifdef USE_FOG
  {
    vec3 fDir=normalize(vWPos-cameraPosition);
    float fDist=length(vWPos-cameraPosition);
    // 高度衰减：海拔越高雾越稀（谷底 1.0，100m 高处约 0.43）
    float fAlt=exp(-max(vWPos.y,0.0)*uFogFalloff);
    float fOD=fDist*uFogDensity*(0.28+0.72*fAlt);
    float fF=1.0-exp(-fOD*fOD);
    // 朝太阳方向散射：逆光看过去雾是亮的、暖的
    float fSun=pow(max(dot(fDir,uFogSunDir),0.0),5.0);
    vec3 fCol=mix(uFogColor,uFogSun,fSun*0.9);
    gl_FragColor.rgb=mix(gl_FragColor.rgb,fCol,clamp(fF,0.0,0.985));
  }
#endif`;

const DECL=`
uniform vec3 uFogColor,uFogSun,uFogSunDir;
uniform float uFogDensity,uFogFalloff;`;

// 给任意"带 vWPos varying 的 MeshStandardMaterial"接上这套雾
export function applyFog(shader){
  Object.assign(shader.uniforms,FOG);
  if(shader.fragmentShader.indexOf('#include <fog_fragment>')<0)return;
  if(shader.fragmentShader.indexOf('uFogFalloff;')<0&&shader.fragmentShader.indexOf('uniform float uFogDensity')<0){
    shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>'+DECL);
  }
  shader.fragmentShader=shader.fragmentShader.replace('#include <fog_fragment>',CHUNK);
}

// 给没有 vWPos 的材质补一个（植被卡片等）
export function addWorldPosVarying(shader){
  shader.vertexShader=shader.vertexShader
    .replace('#include <common>','#include <common>\nvarying vec3 vWPos;')
    .replace('#include <begin_vertex>',
      `#include <begin_vertex>
       #ifdef USE_INSTANCING
         vWPos=(modelMatrix*instanceMatrix*vec4(transformed,1.0)).xyz;
       #else
         vWPos=(modelMatrix*vec4(transformed,1.0)).xyz;
       #endif`);
  shader.fragmentShader=shader.fragmentShader
    .replace('#include <common>','#include <common>\nvarying vec3 vWPos;');
}
