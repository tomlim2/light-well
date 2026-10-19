// Full-screen passes: the light in the water, bloom, and the step to the screen.
import { BEAM } from './light.js';

export const QUAD_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// The light in the water. A ray is walked through the column of sunlight under the hole; at each
// step the light there is the caustic pattern of the surface (the same at every height, so seen
// from the side it runs in vertical streaks), dimming with depth, and missing below any fish.
// Round the column, a faint glow: the light it scatters lights the water about it.
export const VOLUME_FRAG = /* glsl */ `
  uniform sampler2D uDepth;
  uniform mat4 uProjInv;
  uniform mat4 uViewInv;
  uniform vec3 uCam;
  uniform int uSteps;
  uniform float uShaft;
  uniform float uHalo;
  uniform int uDebug;   // 1: show how far each ray goes before it hits the scene
  varying vec2 vUv;
  ${BEAM}

  // interleaved gradient noise (Jimenez): a different start for every pixel, so the steps don't band
  float jitter(vec2 px) { return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715)))); }

  void main() {
    vec4 far = uProjInv * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
    vec3 dir = normalize(mat3(uViewInv) * normalize(far.xyz / far.w));
    // where the ray meets the scene
    float depth = texture2D(uDepth, vUv).r;
    vec4 hit = uProjInv * vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    float sceneDist = length(hit.xyz / hit.w);
    if (uDebug == 1) {
      gl_FragColor = vec4(vec3(sceneDist / 20.0), 1.0);
      return;
    }

    // the column, in the square's own frame: a box -half..half across, 0..ceiling (+shaft) up
    vec2 o = beamLocal(uCam.xz);
    vec2 d = beamLocal(dir.xz);
    vec3 ro = vec3(o.x, uCam.y, o.y);
    vec3 rd = vec3(d.x, dir.y, d.y);
    // the box round the whole flared column; steps that fall outside the light add nothing
    vec3 lo = vec3(-uBeam.x * FLARE, 0.0, -uBeam.x * FLARE);
    vec3 hi = vec3(uBeam.x * FLARE, uBeam.w + uShaft, uBeam.x * FLARE);
    vec3 inv = 1.0 / (rd + vec3(1e-6) * sign(rd + 1e-9));
    vec3 ta = (lo - ro) * inv;
    vec3 tb = (hi - ro) * inv;
    vec3 tmin = min(ta, tb);
    vec3 tmax = max(ta, tb);
    float t0 = max(max(tmin.x, tmin.y), max(tmin.z, 0.0));
    float t1 = min(min(tmax.x, tmax.y), min(tmax.z, sceneDist));

    float glow = 0.0;
    if (t1 > t0) {
      float dt = (t1 - t0) / float(uSteps);
      float t = t0 + dt * jitter(gl_FragCoord.xy);
      for (int i = 0; i < 64; i++) {
        if (i >= uSteps) break;
        vec3 p = uCam + dir * t;
        vec2 local = beamLocalAt(p.xz, p.y);
        float s = sunlight(local);
        // streaks: the pattern's peaks, not its mean, and brightest just under the hole
        // just under the hole the water is a little brighter: light that has not spread yet. Kept
        // faint, and barely past the hole's edge: more of it veils the surface seen through it and
        // bleeds onto the ceiling, which the reference does not do
        // (below the ceiling only: in the shaft it would lie over the water's surface and wash it out)
        float nearTop = exp(-max(uBeam.w - p.y, 0.0) * 1.1) * (1.0 - smoothstep(uBeam.w, uBeam.w + 0.3, p.y));
        float rays = 0.02 + 1.0 * pow(s, 2.2) + 0.2 * nearTop;
        float edge = beamInside(local, 0.1 + 0.15 * nearTop);
        float fall = exp(-max(uBeam.w - p.y, 0.0) * 0.45);
        glow += rays * edge * fall * unshaded(local, p.y, 0.4) * dt;
        t += dt;
      }
    }
    // The beam in front of the cube (the surface and the shaft) is drawn fainter: as the reference
    // has it, the cube stays dark and crisp with the streaks beginning beneath it.
    float hitY = uCam.y + dir.y * sceneDist;
    glow *= mix(1.0, 0.35, smoothstep(uBeam.w - 0.3, uBeam.w + 0.2, hitY));
    vec3 col = vec3(0.36, 0.66, 0.74) * glow * 0.45;

    // The halo: the water round the column, lit by what the column scatters. Only outside it: inside,
    // the march has already counted that light, and a veil over the fish would wash them out.
    vec2 oxz = uCam.xz;
    vec2 dxz = dir.xz;
    float along = clamp(-dot(oxz, dxz) / max(dot(dxz, dxz), 1e-5), 0.0, sceneDist);
    float miss = length(oxz + dxz * along);
    float y = uCam.y + dir.y * along;
    float height = smoothstep(-0.5, 1.5, y) * (1.0 - smoothstep(uBeam.w - 1.0, uBeam.w + 0.5, y));
    float outside = 1.0 - beamInside(beamLocalAt(oxz + dxz * along, y), 0.35);
    col += vec3(0.05, 0.13, 0.16) * exp(-miss * miss / 5.0) * height * outside * 0.6 * uHalo;
    gl_FragColor = vec4(col, 1.0);
  }
`;

// bloom: keep what is brighter than white, then a chain of halvings and doublings
export const BRIGHT_FRAG = /* glsl */ `
  uniform sampler2D uScene;
  uniform sampler2D uVolume;
  varying vec2 vUv;
  void main() {
    vec3 c = texture2D(uScene, vUv).rgb + texture2D(uVolume, vUv).rgb;
    float l = max(c.r, max(c.g, c.b));
    float keep = smoothstep(1.3, 2.4, l);
    gl_FragColor = vec4(c * keep, 1.0);
  }
`;
export const DOWN_FRAG = /* glsl */ `
  uniform sampler2D uTex;
  uniform vec2 uTexel;
  varying vec2 vUv;
  void main() {
    vec2 h = uTexel;
    vec3 c = texture2D(uTex, vUv).rgb * 4.0;
    c += texture2D(uTex, vUv + vec2(-h.x, -h.y)).rgb + texture2D(uTex, vUv + vec2(h.x, -h.y)).rgb;
    c += texture2D(uTex, vUv + vec2(-h.x, h.y)).rgb + texture2D(uTex, vUv + vec2(h.x, h.y)).rgb;
    gl_FragColor = vec4(c / 8.0, 1.0);
  }
`;
export const UP_FRAG = /* glsl */ `
  uniform sampler2D uTex;    // the smaller level, spread out
  uniform sampler2D uBase;   // this level
  uniform vec2 uTexel;       // of the smaller level
  varying vec2 vUv;
  void main() {
    vec2 h = uTexel;
    vec3 c = texture2D(uTex, vUv + vec2(-h.x, 0.0)).rgb + texture2D(uTex, vUv + vec2(h.x, 0.0)).rgb;
    c += texture2D(uTex, vUv + vec2(0.0, -h.y)).rgb + texture2D(uTex, vUv + vec2(0.0, h.y)).rgb;
    c = c * 0.25 * 0.85 + texture2D(uBase, vUv).rgb;
    gl_FragColor = vec4(c, 1.0);
  }
`;

export const FINAL_FRAG = /* glsl */ `
  uniform sampler2D uScene;
  uniform sampler2D uVolume;
  uniform sampler2D uBloom;
  uniform float uTime;
  uniform vec2 uAspect;   // to keep the vignette round
  uniform float uExposure;
  uniform float uBloomAmt;
  varying vec2 vUv;
  // a filmic curve (Narkowicz's fit of ACES)
  vec3 film(vec3 x) {
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
  }
  float grain(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  void main() {
    vec3 c = texture2D(uScene, vUv).rgb + texture2D(uVolume, vUv).rgb + texture2D(uBloom, vUv).rgb * uBloomAmt;
    c = film(c * uExposure);
    // the shadows sink toward blue-green, the highlights warm a little
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(c * vec3(0.9, 1.0, 1.08), c * vec3(1.06, 1.0, 0.92), smoothstep(0.25, 0.85, l));
    vec2 q = (vUv - 0.5) * uAspect;
    c *= mix(1.0, smoothstep(0.95, 0.2, length(q)), 0.55);
    c = pow(c, vec3(1.0 / 2.2));
    c += (grain(gl_FragCoord.xy + fract(uTime) * 917.0) - 0.5) * 0.025;
    gl_FragColor = vec4(c, 1.0);
  }
`;
