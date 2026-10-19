// A fish: one mesh, instanced. The vertex shader makes it swim (a wave running down the body to the
// tail); the fragment shader lights it from above with the same sunlight the floor gets.
import { BEAM, REACH, FLARE } from './light.js';
import { FOG } from './room.js';

// the body bends; both the fish and their height mask need it, so it is shared
const SWIM = /* glsl */ `
  attribute float aAlong;   // 0 at the snout .. 1 at the tip of the tail
  attribute float aFin;     // 0 body, 1 fin
  attribute vec3 aTint;     // this fish's colour
  attribute vec4 aLook;     // phase, how fast the tail beats, how hard, belly paleness
  uniform float uClock;     // the swimming clock: time, run faster while the school is bolting
  uniform float uFright;
  vec3 swim(vec3 p) {
    float k = smoothstep(0.12, 1.0, aAlong);
    float wave = sin(uClock * aLook.y + aLook.x - aAlong * 5.0);
    p.z += k * k * aLook.z * (1.0 + 0.6 * uFright) * wave;
    // the head yaws a touch the other way, the way a fish's does
    p.z -= (1.0 - k) * 0.02 * aLook.z * 6.0 * wave * (1.0 - aAlong);
    return p;
  }
`;

export const FISH_VERT = /* glsl */ `
  ${SWIM}
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying float vAlong;
  varying float vFin;
  varying vec3 vTint;
  varying vec4 vLook;
  void main() {
    mat4 m = modelMatrix * instanceMatrix;
    vec4 w = m * vec4(swim(position), 1.0);
    vWorld = w.xyz;
    vNormal = normalize(mat3(m) * normal);
    vAlong = aAlong;
    vFin = aFin;
    vTint = aTint;
    vLook = aLook;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

export const FISH_FRAG = /* glsl */ `
  uniform vec3 uCam;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying float vAlong;
  varying float vFin;
  varying vec3 vTint;
  varying vec4 vLook;
  const vec3 FOG = vec3(${FOG.map((v) => v.toFixed(3)).join(', ')});
  ${BEAM}
  void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(uCam - vWorld);
    float facing = dot(N, V);
    if (facing < 0.0) N = -N; // fins are seen from both sides
    vec2 local = beamLocalAt(vWorld.xz, vWorld.y);
    float inside = beamInside(local, 0.3);
    float sun = (0.3 + 1.2 * sunlight(local)) * inside;
    // the fish's own back (and any fish above it) shades its belly
    float lit = unshaded(local, vWorld.y + 0.004, 0.07);
    float fall = exp(-(uBeam.w - vWorld.y) * 0.08);
    float top = max(N.y, 0.0);
    float under = max(-N.y, 0.0);

    // a goldfish is deep orange on the back, paler gold at the belly; fins lighter and thin
    vec3 tint = vTint;
    vec3 belly = mix(tint, vec3(1.0, 0.82, 0.55), vLook.w);
    vec3 albedo = mix(tint, belly, smoothstep(-0.15, -0.75, N.y));
    albedo = mix(albedo, mix(tint, vec3(1.0, 0.88, 0.7), 0.5), vFin * 0.6);

    vec3 sunCol = vec3(1.0, 0.92, 0.76);
    vec3 key = sunCol * sun * lit * fall;
    vec3 col = albedo * key * (0.65 + 1.3 * top);
    // fins are thin: the sunlight shines through them
    col += albedo * key * vFin * 0.4;
    // the lit floor throws warm light back up, and the water round about is teal
    float bounce = inside * exp(-vWorld.y * 0.12) * (0.4 + 0.6 * under);
    col += albedo * (vec3(0.04, 0.08, 0.1) + vec3(1.0, 0.75, 0.45) * bounce);
    // a wet sheen off the scales
    vec3 H = normalize(V + vec3(0.0, 1.0, 0.0));
    col += sunCol * pow(max(dot(N, H), 0.0), 40.0) * sun * lit * 0.5 * (1.0 - vFin);
    // the haze catches the edge of the body
    col += vec3(0.05, 0.14, 0.18) * pow(1.0 - abs(facing), 4.0) * inside * 0.5;
    col = mix(col, FOG, 1.0 - exp(-length(uCam - vWorld) * 0.015));
    gl_FragColor = vec4(col, 1.0);
  }
`;

// the same fish drawn into the height mask: seen from straight above, each spot keeps the highest
// fish over it (stored + 100, so that "no fish" can be 0)
export const MASK_VERT = /* glsl */ `
  ${SWIM}
  uniform vec4 uBeam;
  const float REACH = ${REACH.toFixed(2)};
  const float FLARE = ${FLARE.toFixed(2)};
  varying float vHeight;
  void main() {
    vec4 w = modelMatrix * instanceMatrix * vec4(swim(position), 1.0);
    // in the beam's frame at this height, so the shadow falls along the (diverging) ray
    vec2 local = vec2(w.x * uBeam.y + w.z * uBeam.z, -w.x * uBeam.z + w.z * uBeam.y) / mix(FLARE, 1.0, clamp(w.y / uBeam.w, 0.0, 1.0));
    vec2 uv = local / (uBeam.x * REACH * 2.0) + 0.5;
    vHeight = w.y;
    gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
  }
`;
export const MASK_FRAG = /* glsl */ `
  varying float vHeight;
  void main() { gl_FragColor = vec4(vHeight + 100.0, 0.0, 0.0, 1.0); }
`;
