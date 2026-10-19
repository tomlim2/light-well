// The chamber: a stone floor, a ceiling with a square hole in it, the short shaft above the hole,
// and the underside of the water surface at the top of that shaft.
import { NOISE } from './noise.js';
import { BEAM } from './light.js';

export const FOG = [0.012, 0.024, 0.036];
const fog = `const vec3 FOG = vec3(${FOG.map((v) => v.toFixed(3)).join(', ')});`;

export const WORLD_VERT = /* glsl */ `
  varying vec3 vWorld;
  varying vec3 vNormal;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const COMMON = /* glsl */ `
  uniform vec3 uCam;
  uniform float uTime;
  varying vec3 vWorld;
  varying vec3 vNormal;
  ${fog}
  ${NOISE}
  ${BEAM}
  vec3 fogged(vec3 col, float density) {
    return mix(col, FOG, 1.0 - exp(-length(uCam - vWorld) * density));
  }
`;

/* ---- the floor: flagstones, dark, with the sunlight's patch on them ---- */
export const FLOOR_FRAG = /* glsl */ `
  ${COMMON}
  // stones: a still field of cells. x: how far from the nearest seam, y: which stone
  vec2 stones(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float f1 = 8.0;
    float f2 = 8.0;
    vec2 id = vec2(0.0);
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 g = vec2(float(x), float(y));
        vec2 o = hash22(i + g) * 0.8 + 0.1;
        float d = length(g + o - f);
        if (d < f1) {
          f2 = f1;
          f1 = d;
          id = i + g;
        } else if (d < f2) {
          f2 = d;
        }
      }
    }
    return vec2(f2 - f1, hash12(id));
  }
  void main() {
    vec2 p = vWorld.xz;
    vec2 s = stones(p * 0.95 + 0.2 * vec2(vnoise(p * 2.0), vnoise(p * 2.0 + 7.0)));
    float seam = 1.0 - smoothstep(0.0, 0.045, s.x);
    float grit = fbm(p * 4.0);
    float tone = 0.7 + 0.45 * s.y + 0.4 * (grit - 0.5);
    vec3 albedo = vec3(0.17, 0.21, 0.23) * tone * (1.0 - 0.45 * seam);

    vec2 local = beamLocalAt(p, 0.0);
    float inside = beamInside(local, 0.22);
    float pools = sunlight(local);
    // the fish are far above the floor, so their shadows are soft: take a few looks round about
    float shade = 0.0;
    for (int k = 0; k < 4; k++) {
      vec2 o = vec2(cos(float(k) * 1.57 + 0.4), sin(float(k) * 1.57 + 0.4)) * 0.06;
      shade += unshaded(local + o, 0.0, 0.8);
    }
    shade *= 0.25;
    vec3 sun = vec3(1.0, 0.88, 0.68) * 5.8 * inside * (0.05 + 1.3 * pools) * shade;
    // light bounced off the bright patch onto the stone round it
    vec2 out_ = max(abs(local) - uBeam.x, 0.0);
    float spill = exp(-length(out_) * 1.6);
    vec3 ambient = vec3(0.01, 0.03, 0.04) + vec3(0.08, 0.2, 0.24) * spill;
    vec3 col = albedo * (sun + ambient);
    gl_FragColor = vec4(fogged(col, 0.04), 1.0);
  }
`;

/* ---- the ceiling, the shaft walls and the water at the top: one shader, three parts ---- */
export const ROOM_FRAG = /* glsl */ `
  uniform int uPart;      // 0 ceiling, 1 shaft wall, 2 water surface
  uniform float uShaft;   // how tall the shaft is
  ${COMMON}

  // the water seen from underneath: ripples catch the bright sky and the warm low sun
  vec3 water(vec2 local) {
    vec2 p = vWorld.xz;
    float t = uTime;
    float h0 = fbm(p * 1.7 + vec2(t * 0.22, -t * 0.17));
    float hx = fbm(p * 1.7 + vec2(0.05, 0.0) + vec2(t * 0.22, -t * 0.17));
    float hz = fbm(p * 1.7 + vec2(0.0, 0.05) + vec2(t * 0.22, -t * 0.17));
    vec2 slope = vec2(hx - h0, hz - h0) / 0.05;
    float fine = fbm(p * 6.0 - vec2(t * 0.5, t * 0.35));
    // where the surface tips toward us, it lets the sky through; elsewhere it mirrors the lit shaft
    float tip = clamp(0.5 + 0.35 * dot(slope, normalize(uCam.xz - p)) + 0.9 * (fine - 0.5), 0.0, 1.0);
    vec3 mirror = vec3(0.38, 0.74, 0.86) * (0.32 + 0.34 * h0);
    // the low sun comes in from one side: that half of the surface is full of warm glitter
    float side = smoothstep(-0.6, 0.9, local.x / uBeam.x);
    // deep orange kept near 1.0: brighter would only tonemap to cream
    vec3 sky = mix(vec3(1.0, 0.45, 0.15), vec3(1.0, 0.8, 0.5), fine);
    vec3 col = mix(mirror, sky * mix(0.85, 1.15, side), smoothstep(mix(0.5, 0.34, side), mix(0.85, 0.72, side), tip));
    // glints
    col += vec3(1.0, 0.85, 0.6) * pow(smoothstep(0.8, 1.0, fine + 0.25 * length(slope)), 3.0) * 1.4;
    return col;
  }

  void main() {
    vec2 local = beamLocal(vWorld.xz);
    vec3 col;
    if (uPart == 2) {
      col = water(local);
    } else if (uPart == 1) {
      // the shaft's walls: light running down them in streaks, brightest up by the water
      float up = clamp((vWorld.y - uBeam.w) / uShaft, 0.0, 1.0);
      float streak = sunlight(local * 0.94);
      col = vec3(0.36, 0.7, 0.82) * (0.25 + 0.8 * streak) * mix(0.4, 1.0, up);
    } else {
      // the ceiling and the walls: dark stone, a little light thrown on it round the hole
      vec2 out_ = max(abs(local) - uBeam.x, 0.0);
      float near = exp(-length(out_) * 2.2);
      col = vec3(0.004, 0.008, 0.012) + vec3(0.05, 0.12, 0.15) * near * (0.6 + 0.4 * fbm(vWorld.xz * 3.0));
    }
    gl_FragColor = vec4(fogged(col, uPart == 2 ? 0.012 : (uPart == 0 ? 0.045 : 0.03)), 1.0);
  }
`;
