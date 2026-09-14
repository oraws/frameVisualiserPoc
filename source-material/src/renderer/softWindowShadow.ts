import * as THREE from 'three';

/** Filter only the wall receiver. A fixed Gaussian kernel avoids animated
 * dither and leaves the small shadows inside the moulding well defined. */
export function softenWindowShadow(shader: { vertexShader?: string; fragmentShader: string }) {
  const chunk = THREE.ShaderChunk.shadowmap_pars_fragment;
  const start = chunk.indexOf('vec2 texelSize = vec2( 1.0 ) / shadowMapSize;', chunk.indexOf('float getShadow( sampler2DShadow'));
  const end = chunk.indexOf(') * 0.2;', start);
  if (start < 0 || end < 0) throw new Error('Unsupported Three.js PCF shadow layout');
  const filtered = chunk.slice(0, start) + `
    #ifdef USE_VARIABLE_PENUMBRA
      float penumbraT = clamp((uTopY - vWorldPos.y) / max(0.01, uTopY - uFloorY), 0.0, 1.0);
      float effectiveRadius = mix(uMinRadius, uMaxRadius, smoothstep(0.0, 1.0, penumbraT));
    #else
      float effectiveRadius = shadowRadius;
    #endif
    vec2 texelSize = 1.0 / shadowMapSize;
    float totalWeight = 0.0;
    shadow = 0.0;
    for (int y = -8; y <= 8; y++) {
      for (int x = -8; x <= 8; x++) {
        vec2 p = vec2(float(x), float(y)) / 8.0;
        float weight = exp(-2.0 * dot(p,p));
        shadow += weight * texture(shadowMap, vec3(shadowCoord.xy + p * effectiveRadius * texelSize, shadowCoord.z));
        totalWeight += weight;
      }
    }
    shadow /= totalWeight;
  ` + chunk.slice(end + ') * 0.2;'.length);
  if (shader.vertexShader && !shader.vertexShader.includes('varying vec3 vWorldPos;')) {
    shader.vertexShader = 'varying vec3 vWorldPos;\n' + shader.vertexShader.replace(
      '#include <worldpos_vertex>',
      '#include <worldpos_vertex>\nvWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;'
    );
  }
  const decls = `
    varying vec3 vWorldPos;
    uniform float uTopY;
    uniform float uFloorY;
    uniform float uMinRadius;
    uniform float uMaxRadius;
  `;
  shader.fragmentShader = decls + shader.fragmentShader.replace('#include <shadowmap_pars_fragment>', filtered);
}

export function windowShadowRadius(depthMm: number, lightDistance: number, windowWidth: number) {
  // mm → scene units; angular source width × blocker-wall distance → penumbra.
  const penumbra = (depthMm * .0025 + .012) * windowWidth / lightDistance;
  return THREE.MathUtils.clamp(penumbra * 2048 / 7, 7, 22);
}
