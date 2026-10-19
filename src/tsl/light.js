// The sunlight's footprint. The light comes straight down through a square hole that is turned
// about the vertical; everything that needs to know where the light falls works in that square's
// own frame (u along one side, v along the other, both -half..half inside the light).
//
// Two small textures cover the footprint and a margin round it, and are redrawn every frame:
//   light   the caustic pattern, how bright the sunlight is at each spot of the square
//   heights the highest fish above each spot (stored + 100, 0 = no fish), for shadows
import * as THREE from 'three/webgpu';
import { Fn, uniform, texture, uv, float, vec2, vec4, mix, clamp, abs, max, smoothstep } from 'three/tsl';
import { caustic } from './noise.js';

export const REACH = 1.3; // the textures reach this many half widths out from the middle
// The beam is not a prism: light from a wide bright surface spreads, so the column is this much
// wider at the floor than at the hole. Everything works in coordinates squeezed back to the hole's
// size at each height, so points on one (diverging) ray share the same local position.
export const FLARE = 1.35;

// The beam's frame, as small node builders every shader shares. `uBeam` holds the half width of
// the lit square, the cos and sin of its turn, and the height of the ceiling.
export function createBeam({ half, turn, ceiling }, lightTexture, heightTexture) {
  const uBeam = uniform(new THREE.Vector4(half, Math.cos(turn), Math.sin(turn), ceiling));
  const beamLocal = (xz) => vec2(xz.x.mul(uBeam.y).add(xz.y.mul(uBeam.z)), xz.y.mul(uBeam.y).sub(xz.x.mul(uBeam.z)));
  // how much wider the beam is at height y than at the hole
  const beamSpread = (y) => mix(FLARE, 1.0, clamp(float(y).div(uBeam.w), 0.0, 1.0));
  // the beam's own frame at height y: inside the light means |local| < half, at any height
  const beamLocalAt = (xz, y) => beamLocal(xz).div(beamSpread(y));
  const beamUv = (local) => local.div(uBeam.x.mul(REACH * 2)).add(0.5);
  // 1 inside the lit square, falling to 0 across a soft edge
  const beamInside = (local, soft) => {
    const s = float(soft);
    const d = abs(local).sub(uBeam.x);
    return smoothstep(s.negate(), s, max(d.x, d.y)).oneMinus();
  };
  const sunlight = (local) => texture(lightTexture, beamUv(local)).r;
  // the highest fish over this spot, or -100
  const fishAbove = (local) => texture(heightTexture, beamUv(local)).r.sub(100.0);
  // how much of the sunlight gets down to height y here, with the fish above in the way
  const unshaded = (local, y, soft) => smoothstep(-0.02, float(soft), fishAbove(local).sub(y)).oneMinus();
  return { uBeam, beamLocal, beamSpread, beamLocalAt, beamUv, beamInside, sunlight, fishAbove, unshaded };
}

// draws the caustic pattern into the light texture
export function causticMaterial(uTime, half) {
  const m = new THREE.NodeMaterial();
  m.depthTest = false;
  m.depthWrite = false;
  m.fragmentNode = Fn(() => {
    const local = uv().sub(0.5).mul(half * REACH * 2);
    return vec4(caustic(local.mul(1.15), uTime), 0.0, 0.0, 1.0);
  })();
  return m;
}
