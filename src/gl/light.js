// The sunlight's footprint. The light comes straight down through a square hole that is turned
// about the vertical; everything that needs to know where the light falls works in that square's
// own frame (u along one side, v along the other, both -half..half inside the light).
//
// Two small textures cover the footprint and a margin round it, and are redrawn every frame:
//   light   the caustic pattern, how bright the sunlight is at each spot of the square
//   heights the highest fish above each spot (stored + 100, 0 = no fish), for shadows
import { NOISE } from './noise.js';

export const REACH = 1.3; // the textures reach this many half widths out from the middle

export const BEAM = /* glsl */ `
  uniform vec4 uBeam;    // half width of the lit square, cos and sin of its turn, height of the ceiling
  uniform sampler2D uLight;
  uniform sampler2D uHeights;
  const float REACH = ${REACH.toFixed(2)};
  vec2 beamLocal(vec2 xz) {
    return vec2(xz.x * uBeam.y + xz.y * uBeam.z, -xz.x * uBeam.z + xz.y * uBeam.y);
  }
  vec2 beamUv(vec2 local) { return local / (uBeam.x * REACH * 2.0) + 0.5; }
  // 1 inside the lit square, falling to 0 across a soft edge
  float beamInside(vec2 local, float soft) {
    vec2 d = abs(local) - uBeam.x;
    return 1.0 - smoothstep(-soft, soft, max(d.x, d.y));
  }
  float sunlight(vec2 local) { return texture2D(uLight, beamUv(local)).r; }
  // the highest fish over this spot, or -100
  float fishAbove(vec2 local) { return texture2D(uHeights, beamUv(local)).r - 100.0; }
  // how much of the sunlight gets down to height y here, with the fish above in the way
  float unshaded(vec2 local, float y, float soft) {
    return 1.0 - smoothstep(-0.02, soft, fishAbove(local) - y);
  }
`;

// draws the caustic pattern into the light texture
export const CAUSTIC_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uHalf;
  varying vec2 vUv;
  ${NOISE}
  void main() {
    vec2 local = (vUv - 0.5) * uHalf * ${(REACH * 2).toFixed(2)};
    gl_FragColor = vec4(caustic(local * 1.15, uTime), 0.0, 0.0, 1.0);
  }
`;
