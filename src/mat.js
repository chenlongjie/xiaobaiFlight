// 三平面 PBR 材质。
// 关键点：本工程的地形没有 UV（顶点点阵直出），所以贴图全部按世界坐标三平面投影，
// 这样既不用回头改几何管线，又能拿到真实的贴图细节。
// 直接复用 three 的 MeshStandardMaterial（GGX + IBL + 阴影 + 雾都白送），只注入采样逻辑。
//
// 注意：注入的局部变量一律加 tp 前缀。three 自己的 chunk 会占掉 im / ph 这类短名字，
// 撞名会直接编译失败（已在 im 上踩过）。
import * as THREE from 'three';
import {applyFog} from './fog.js';

export function triplanarTerrain({
  rockAlbedo,grassAlbedo,rockNormal,rockAO,
  scale=0.055,normalStrength=0.55,tint=0xffffff,
  envIntensity=1.0,macro=0.35,
}={}){
  const m=new THREE.MeshStandardMaterial({
    color:tint,roughness:0.9,metalness:0.0,
    envMapIntensity:envIntensity,
  });
  m.userData.uniforms={
    uAlbedoR:{value:rockAlbedo},
    uAlbedoG:{value:grassAlbedo},
    uRockN:{value:rockNormal},
    uRockAO:{value:rockAO},
    uScale:{value:scale},
    uNormalStr:{value:normalStrength},
    uTint:{value:new THREE.Color(tint)},
    uMacro:{value:macro},
  };
  const U=m.userData.uniforms;

  m.onBeforeCompile=(shader)=>{
    Object.assign(shader.uniforms,U);
    applyFog(shader);

    shader.vertexShader=shader.vertexShader
      .replace('#include <common>',
        '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNrm;')
      // 实例化必须把 instanceMatrix 算进去，否则所有实例都采样到同一个世界坐标
      .replace('#include <begin_vertex>',
        `#include <begin_vertex>
         #ifdef USE_INSTANCING
           vWPos=(modelMatrix*instanceMatrix*vec4(transformed,1.0)).xyz;
           vWNrm=normalize(mat3(modelMatrix)*mat3(instanceMatrix)*objectNormal);
         #else
           vWPos=(modelMatrix*vec4(transformed,1.0)).xyz;
           vWNrm=normalize(mat3(modelMatrix)*objectNormal);
         #endif`);

    shader.fragmentShader=shader.fragmentShader
      .replace('#include <common>',
        `#include <common>
         varying vec3 vWPos; varying vec3 vWNrm;
         uniform sampler2D uAlbedoR; uniform sampler2D uAlbedoG;
         uniform sampler2D uRockN; uniform sampler2D uRockAO;
         uniform float uScale, uNormalStr, uMacro; uniform vec3 uTint;`)
      // --- 反照率：岩 / 草 依坡度混合；再叠大尺度色斑去平铺感 ---------------
      .replace('#include <map_fragment>', `
        vec3 tpNw=normalize(vWNrm);
        vec3 tpBw=pow(abs(tpNw),vec3(3.0));
        tpBw/=(tpBw.x+tpBw.y+tpBw.z);
        float tpSc=uScale;
        vec3 tpRock =
          texture2D(uAlbedoR,vWPos.zy*tpSc).rgb*tpBw.x+
          texture2D(uAlbedoR,vWPos.xz*tpSc).rgb*tpBw.y+
          texture2D(uAlbedoR,vWPos.xy*tpSc).rgb*tpBw.z;
        float tpSg=tpSc*0.42;
        vec3 tpGrass =
          texture2D(uAlbedoG,vWPos.zy*tpSg).rgb*tpBw.x+
          texture2D(uAlbedoG,vWPos.xz*tpSg).rgb*tpBw.y+
          texture2D(uAlbedoG,vWPos.xy*tpSg).rgb*tpBw.z;

        // 坡度决定岩/草；海拔只削弱草的比例，不再一刀切把山顶剃成光头
        float tpFlat=smoothstep(0.34,0.82,tpNw.y);
        float tpAlt=smoothstep(28.0,95.0,vWPos.y);
        float tpMix=tpFlat*mix(1.0,0.58,tpAlt);

        // 大尺度色斑（0.0035 → 250m 级），专治贴图平铺
        float tpM1=texture2D(uAlbedoG,vWPos.xz*0.0035).g;
        float tpM2=texture2D(uAlbedoR,vWPos.zx*0.0018).r;
        float tpMac=1.0+(tpM1-0.5)*uMacro+(tpM2-0.5)*uMacro*0.7;

        // 岩块遮蔽：裂隙压实、块面提亮。只在陡面生效（草地不用岩面 AO）
        // AO 必须三平面加权：用"选一个主导轴"会在这三个平面的交接处留下硬缝，
        // 曲面上就碎成一片片格子。
        float tpAO =texture2D(uRockAO,vWPos.zy*tpSc).r*tpBw.x
                   +texture2D(uRockAO,vWPos.xz*tpSc).r*tpBw.y
                   +texture2D(uRockAO,vWPos.xy*tpSc).r*tpBw.z;
        vec3 tpTri=mix(tpRock,tpGrass,tpMix*0.95)*tpMac;
        tpTri*=mix(1.0,mix(0.58,1.0,tpAO),1.0-tpFlat);
        // 陡崖专属：基部潮湿发暗，越往上越干；裂隙按法线朝侧的程度压暗
        float tpBase=smoothstep(72.0,2.0,vWPos.y);
        tpTri*=mix(1.0,0.84,tpBase*(1.0-tpFlat));
        // 水线附近的湿泥带
        float tpWet=smoothstep(3.2,0.15,vWPos.y);
        tpTri=mix(tpTri,tpTri*vec3(0.52,0.50,0.44),tpWet*0.75);
        // 水下河床：做成深色淤泥/砾石。
        // 浅滩水面现在是半透明的，露出来的就是这一层——不做的话会露出"水下的草皮"
        float tpUw=smoothstep(0.7,-1.6,vWPos.y);
        tpTri=mix(tpTri,vec3(0.20,0.175,0.135),tpUw*0.88);
        diffuseColor.rgb*=tpTri*uTint;
      `)
      // --- 粗糙度：岩面哑光、草地柔和 ---------------------------------------
      .replace('#include <roughnessmap_fragment>', `
        // 岩面粗糙度不是常数：裂隙/凹处更哑光，块面略微发亮
        float roughnessFactor=mix(0.97,0.74,tpAO)*(1.0-tpMix*0.10);
      `)
      // --- 法线：主导轴平面采样 + 切线基旋转到世界空间 ------------------------
      .replace('#include <normal_fragment_maps>', `
        vec3 tpNn=normalize(vWNrm);
        // ★ 三平面加权合成扰动量。
        //   之前是"选主导轴"采样 —— 法线一变，选中的平面就跳，跳处就是一条硬缝，
        //   整面崖壁碎成一格一格。现在三个平面按权重相加，没有切换点。
        vec3 tpN1x=texture2D(uRockN,vWPos.zy*tpSc).xyz*2.0-1.0;
        vec3 tpN1y=texture2D(uRockN,vWPos.xz*tpSc).xyz*2.0-1.0;
        vec3 tpN1z=texture2D(uRockN,vWPos.xy*tpSc).xyz*2.0-1.0;
        vec3 tpPert=vec3(0.0,tpN1x.y,tpN1x.x)*tpBw.x
                  +vec3(tpN1y.x,0.0,tpN1y.y)*tpBw.y
                  +vec3(tpN1z.x,tpN1z.y,0.0)*tpBw.z;

        // 第二尺度补近看颗粒（单轴，误差可忽略）
        vec2 tpUv=abs(tpNn.y)>0.5?vWPos.xz:(abs(tpNn.x)>abs(tpNn.z)?vWPos.zy:vWPos.xy);
        vec3 tpN2=texture2D(uRockN,tpUv*tpSc*3.7).xyz*2.0-1.0;
        tpPert+=vec3(tpN2.x,tpN2.y,0.0)*0.18;

        float tpNs=uNormalStr*mix(1.0,2.1,1.0-tpFlat);
        vec3 tpNp=normalize(tpNn+tpPert*tpNs*0.55);
        normal=normalize((viewMatrix*vec4(tpNp,0.0)).xyz);
        diffuseColor.rgb*=mix(1.0,0.86,clamp(length(tpPert)*0.4,0.0,1.0)*(1.0-tpFlat));
      `);
  };
  m.customProgramCacheKey=()=>'triplanarTerrain';
  return m;
}
