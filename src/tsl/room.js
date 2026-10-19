// The chamber: a stone floor, a ceiling with a square hole in it, the short shaft above the hole,
// and the underside of the water surface at the top of that shaft.
import * as THREE from 'three/webgpu';
import { Fn, Loop, float, vec2, vec3, vec4, positionWorld, length, mix, exp, smoothstep, clamp, abs, max, pow, dot, normalize, sin, cos } from 'three/tsl';
import { vnoise, fbm, stones } from './noise.js';

export const FOG = [0.012, 0.024, 0.036];
const fogColour = () => vec3(...FOG);

// what the water between the camera and the point does to a colour
export const fogged = (uCam, col, density) => mix(col, fogColour(), exp(length(uCam.sub(positionWorld)).mul(-density)).oneMinus());

const worldMaterial = (fragment, extra = {}) => {
  const m = new THREE.NodeMaterial();
  m.fragmentNode = fragment;
  Object.assign(m, extra);
  return m;
};

/* ---- the floor: flagstones, dark, with the sunlight's patch on them ---- */
export function floorMaterial({ beam, uCam }) {
  return worldMaterial(
    Fn(() => {
      const p = positionWorld.xz.toVar();
      const s = stones(p.mul(0.95).add(vec2(vnoise(p.mul(2.0)), vnoise(p.mul(2.0).add(7.0))).mul(0.2)));
      const seam = smoothstep(0.0, 0.045, s.x).oneMinus();
      const grit = fbm(p.mul(4.0));
      const tone = s.y.mul(0.45).add(0.7).add(grit.sub(0.5).mul(0.4));
      const albedo = vec3(0.17, 0.21, 0.23).mul(tone).mul(seam.mul(0.45).oneMinus());

      const local = beam.beamLocalAt(p, 0.0).toVar();
      const inside = beam.beamInside(local, 0.22);
      const pools = beam.sunlight(local);
      // the fish are far above the floor, so their shadows are soft: take a few looks round about
      const shade = float(0.0).toVar();
      Loop(4, ({ i }) => {
        const a = float(i).mul(1.57).add(0.4);
        const o = vec2(cos(a), sin(a)).mul(0.06);
        shade.addAssign(beam.unshaded(local.add(o), 0.0, 0.8));
      });
      shade.mulAssign(0.25);
      const sun = vec3(1.0, 0.88, 0.68).mul(5.8).mul(inside).mul(pools.mul(1.3).add(0.05)).mul(shade);
      // light bounced off the bright patch onto the stone round it
      const out = max(abs(local).sub(beam.uBeam.x), 0.0);
      const spill = exp(length(out).mul(-1.6));
      const ambient = vec3(0.01, 0.03, 0.04).add(vec3(0.08, 0.2, 0.24).mul(spill));
      const col = albedo.mul(sun.add(ambient));
      return vec4(fogged(uCam, col, 0.04), 1.0);
    })()
  );
}

/* ---- the ceiling and walls, the shaft walls, the water at the top: one builder, three parts ---- */
export const CEILING = 0;
export const SHAFT = 1;
export const WATER = 2;

export function roomMaterial(part, { beam, uCam, uTime, uShaft }, extra = {}) {
  const { uBeam } = beam;
  return worldMaterial(
    Fn(() => {
      const local = beam.beamLocal(positionWorld.xz).toVar();
      let col;
      if (part === WATER) {
        // the water seen from underneath: ripples catch the bright sky and the warm low sun
        const p = positionWorld.xz.toVar();
        const t = uTime;
        const drift = vec2(t.mul(0.22), t.mul(-0.17));
        const h0 = fbm(p.mul(1.7).add(drift)).toVar();
        const hx = fbm(p.mul(1.7).add(vec2(0.05, 0.0)).add(drift));
        const hz = fbm(p.mul(1.7).add(vec2(0.0, 0.05)).add(drift));
        const slope = vec2(hx.sub(h0), hz.sub(h0)).div(0.05).toVar();
        const fine = fbm(p.mul(4.5).sub(vec2(t.mul(0.5), t.mul(0.35)))).toVar();
        // where the surface tips toward us, it lets the sky through; elsewhere it mirrors the lit shaft
        const tip = clamp(dot(slope, normalize(uCam.xz.sub(p))).mul(0.35).add(0.5).add(fine.sub(0.5).mul(0.9)), 0.0, 1.0);
        const mirror = vec3(0.3, 0.62, 0.78).mul(h0.mul(0.3).add(0.22));
        // the low sun comes in from one side: that half of the surface is full of warm glitter
        const side = smoothstep(-0.6, 0.9, local.x.div(uBeam.x)).toVar();
        // deep orange kept near 1.0: brighter would only tonemap to cream
        const sky = mix(vec3(1.0, 0.45, 0.15), vec3(1.0, 0.8, 0.5), fine);
        col = mix(mirror, sky.mul(mix(0.85, 1.15, side)), smoothstep(mix(0.5, 0.34, side), mix(0.85, 0.72, side), tip)).toVar();
        // glints
        col.addAssign(vec3(1.0, 0.85, 0.6).mul(pow(smoothstep(0.8, 1.0, fine.add(length(slope).mul(0.25))), 3.0)).mul(1.4));
      } else if (part === SHAFT) {
        // the shaft's walls: light running down them in streaks, brightest up by the water
        const up = clamp(positionWorld.y.sub(uBeam.w).div(uShaft), 0.0, 1.0);
        const streak = beam.sunlight(local.mul(0.94));
        col = vec3(0.36, 0.7, 0.82).mul(streak.mul(0.8).add(0.25)).mul(mix(0.4, 1.0, up)).toVar();
        // the bottom edge of the shaft catches the light: a thin bright rim where the beam begins
        col.addAssign(vec3(0.5, 0.8, 0.9).mul(exp(positionWorld.y.sub(uBeam.w).mul(-7.0))).mul(0.5));
      } else {
        // The ceiling and the walls: dark stone, graded by height alone and not fogged by distance,
        // so that where a wall meets the ceiling both are the same colour and no edge shows through
        // the beam. A little light is thrown on the ceiling round the hole.
        const out = max(abs(local).sub(uBeam.x), 0.0);
        const near = exp(length(out).mul(-2.2));
        const dark = mix(vec3(0.008, 0.017, 0.025), vec3(0.004, 0.009, 0.014), clamp(positionWorld.y.div(uBeam.w), 0.0, 1.0));
        col = dark.add(vec3(0.05, 0.12, 0.15).mul(near).mul(fbm(positionWorld.xz.mul(3.0)).mul(0.4).add(0.6)));
      }
      const density = part === WATER ? 0.012 : part === SHAFT ? 0.03 : 0;
      return vec4(density ? fogged(uCam, col, density) : col, 1.0);
    })(),
    extra
  );
}
