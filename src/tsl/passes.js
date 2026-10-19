// Full-screen passes: the light in the water, bloom, and the step to the screen. Each is a material
// for a QuadMesh; `uv()` on the quad has its first row at the top, as the textures it reads have.
import * as THREE from 'three/webgpu';
import { Fn, If, Loop, uv, uniform, float, int, vec2, vec3, vec4, mat3, texture, screenCoordinate, length, normalize, dot, fract, exp, pow, max, min, clamp, smoothstep, mix, sign, select } from 'three/tsl';
import { FLARE } from './light.js';

const passMaterial = (fragment) => {
  const m = new THREE.NodeMaterial();
  m.depthTest = false;
  m.depthWrite = false;
  m.fragmentNode = fragment;
  return m;
};

// The light in the water. A ray is walked through the column of sunlight under the hole; at each
// step the light there is the caustic pattern of the surface (the same at every height, so seen
// from the side it runs in vertical streaks), dimming with depth, and missing below any fish.
// Round the column, a faint glow: the light it scatters lights the water about it.
export function volumeMaterial({ beam, uCam }, { depthTexture, uProjInv, uViewInv, uNear, uFar, uSteps, uShaft, uHalo, uDebug }) {
  const { uBeam } = beam;
  return passMaterial(
    Fn(() => {
      const p = uv();
      const ndc = vec2(p.x.mul(2.0).sub(1.0), p.y.mul(-2.0).add(1.0));
      const far = uProjInv.mul(vec4(ndc, 1.0, 1.0));
      const dirView = normalize(far.xyz.div(far.w)).toVar();
      const dir = normalize(mat3(uViewInv).mul(dirView)).toVar();
      // where the ray meets the scene: the depth buffer holds the same number in both backends
      const depth = float(texture(depthTexture, p));
      const viewZ = uNear.mul(uFar).div(uFar.sub(uNear).mul(depth).sub(uFar));
      const sceneDist = viewZ.div(dirView.z).toVar();

      // the column, in the square's own frame: a box -half..half across, 0..ceiling (+shaft) up
      const o = beam.beamLocal(uCam.xz);
      const d = beam.beamLocal(dir.xz);
      const ro = vec3(o.x, uCam.y, o.y);
      const rd = vec3(d.x, dir.y, d.y);
      // the box round the whole flared column; steps that fall outside the light add nothing
      const lo = vec3(uBeam.x.mul(-FLARE), 0.0, uBeam.x.mul(-FLARE));
      const hi = vec3(uBeam.x.mul(FLARE), uBeam.w.add(uShaft), uBeam.x.mul(FLARE));
      const inv = float(1.0).div(rd.add(sign(rd.add(1e-9)).mul(1e-6)));
      const ta = lo.sub(ro).mul(inv);
      const tb = hi.sub(ro).mul(inv);
      const tmin = min(ta, tb);
      const tmax = max(ta, tb);
      const t0 = max(max(tmin.x, tmin.y), max(tmin.z, 0.0)).toVar();
      const t1 = min(min(tmax.x, tmax.y), min(tmax.z, sceneDist)).toVar();

      const glow = float(0.0).toVar();
      If(t1.greaterThan(t0), () => {
        const dt = t1.sub(t0).div(float(uSteps)).toVar();
        // interleaved gradient noise (Jimenez): a different start for every pixel, so the steps don't band
        const jitter = fract(fract(dot(screenCoordinate.xy, vec2(0.06711056, 0.00583715))).mul(52.9829189));
        const t = t0.add(dt.mul(jitter)).toVar();
        Loop(uSteps, () => {
          const q = uCam.add(dir.mul(t)).toVar();
          const local = beam.beamLocalAt(q.xz, q.y).toVar();
          const s = beam.sunlight(local);
          // just under the hole the water is a little brighter: light that has not spread yet. Kept
          // faint, and barely past the hole's edge: more of it veils the surface seen through it and
          // bleeds onto the ceiling, which the reference does not do
          // (below the ceiling only: in the shaft it would lie over the water's surface and wash it out)
          const nearTop = exp(max(uBeam.w.sub(q.y), 0.0).mul(-1.1)).mul(smoothstep(uBeam.w, uBeam.w.add(0.3), q.y).oneMinus()).toVar();
          // streaks: the pattern's peaks, not its mean, and brightest just under the hole
          const rays = pow(s, 2.2).add(0.02).add(nearTop.mul(0.2));
          const edge = beam.beamInside(local, nearTop.mul(0.15).add(0.1));
          const fall = exp(max(uBeam.w.sub(q.y), 0.0).mul(-0.45));
          glow.addAssign(rays.mul(edge).mul(fall).mul(beam.unshaded(local, q.y, 0.4)).mul(dt));
          t.addAssign(dt);
        });
      });
      // The beam in front of the cube (the surface and the shaft) is drawn fainter: as the reference
      // has it, the cube stays dark and crisp with the streaks beginning beneath it.
      // (the cube only: the ceiling is at the same height, and dimming rays that end on it would draw
      // a line across the beam where the back wall meets it)
      const hitP = uCam.add(dir.mul(sceneDist));
      const onCube = beam.beamInside(beam.beamLocal(hitP.xz), 0.1).mul(smoothstep(uBeam.w.sub(0.3), uBeam.w, hitP.y));
      glow.mulAssign(mix(1.0, 0.35, onCube));
      const col = vec3(0.36, 0.66, 0.74).mul(glow).mul(0.45).toVar();

      // The halo: the water round the column, lit by what the column scatters. Only outside it: inside,
      // the march has already counted that light, and a veil over the fish would wash them out.
      const oxz = uCam.xz;
      const dxz = dir.xz;
      const along = clamp(dot(oxz, dxz).negate().div(max(dot(dxz, dxz), 1e-5)), 0.0, sceneDist).toVar();
      const miss = length(oxz.add(dxz.mul(along)));
      const y = uCam.y.add(dir.y.mul(along)).toVar();
      const height = smoothstep(-0.5, 1.5, y).mul(smoothstep(uBeam.w.sub(1.0), uBeam.w.add(0.5), y).oneMinus());
      const outside = beam.beamInside(beam.beamLocalAt(oxz.add(dxz.mul(along)), y), 0.35).oneMinus();
      col.addAssign(vec3(0.05, 0.13, 0.16).mul(exp(miss.mul(miss).div(-5.0))).mul(height).mul(outside).mul(0.6).mul(uHalo));
      // debug 1: how far each ray goes before it hits the scene
      return vec4(select(uDebug.equal(int(1)), vec3(sceneDist.div(20.0)), col), 1.0);
    })()
  );
}

// bloom: keep what is brighter than white, then a chain of halvings and doublings
export function brightMaterial(sceneTexture, volumeTexture) {
  return passMaterial(
    Fn(() => {
      const c = texture(sceneTexture, uv()).rgb.add(texture(volumeTexture, uv()).rgb);
      const l = max(c.r, max(c.g, c.b));
      const keep = smoothstep(1.3, 2.4, l);
      return vec4(c.mul(keep), 1.0);
    })()
  );
}

// The texture nodes are handed back with the material, so the level being read can be swapped
// from pass to pass (`tex.value = ...`); the samples are clones that follow it.
export function downMaterial(first) {
  const tex = texture(first);
  const texel = uniform(new THREE.Vector2());
  const material = passMaterial(
    Fn(() => {
      const h = texel;
      const p = uv();
      const c = tex.sample(p).rgb.mul(4.0).toVar();
      c.addAssign(tex.sample(p.add(vec2(h.x.negate(), h.y.negate()))).rgb);
      c.addAssign(tex.sample(p.add(vec2(h.x, h.y.negate()))).rgb);
      c.addAssign(tex.sample(p.add(vec2(h.x.negate(), h.y))).rgb);
      c.addAssign(tex.sample(p.add(vec2(h.x, h.y))).rgb);
      return vec4(c.div(8.0), 1.0);
    })()
  );
  return { material, tex, texel };
}

export function upMaterial(firstSmall, firstBase) {
  const tex = texture(firstSmall); // the smaller level, spread out
  const base = texture(firstBase); // this level
  const texel = uniform(new THREE.Vector2()); // of the smaller level
  const material = passMaterial(
    Fn(() => {
      const h = texel;
      const p = uv();
      const c = tex.sample(p.add(vec2(h.x.negate(), 0.0))).rgb.toVar();
      c.addAssign(tex.sample(p.add(vec2(h.x, 0.0))).rgb);
      c.addAssign(tex.sample(p.add(vec2(0.0, h.y.negate()))).rgb);
      c.addAssign(tex.sample(p.add(vec2(0.0, h.y))).rgb);
      return vec4(c.mul(0.25 * 0.85).add(base.sample(p).rgb), 1.0);
    })()
  );
  return { material, tex, base, texel };
}

// a filmic curve (Narkowicz's fit of ACES)
const film = (x) => clamp(x.mul(x.mul(2.51).add(0.03)).div(x.mul(x.mul(2.43).add(0.59)).add(0.14)), 0.0, 1.0);
const grain = (p) => {
  const p3 = fract(vec3(p.xyx).mul(0.1031)).toVar();
  p3.addAssign(dot(p3, p3.yzx.add(33.33)));
  return fract(p3.x.add(p3.y).mul(p3.z));
};

export function finalMaterial({ uTime }, { sceneTexture, volumeTexture, bloomTexture, uAspect, uExposure, uBloomAmt }) {
  const bloom = texture(bloomTexture);
  const material = passMaterial(
    Fn(() => {
      const p = uv();
      const c = texture(sceneTexture, p).rgb.add(texture(volumeTexture, p).rgb).add(bloom.sample(p).rgb.mul(uBloomAmt)).toVar();
      c.assign(film(c.mul(uExposure)));
      // the shadows sink toward blue-green, the highlights warm a little
      const l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c.assign(mix(c.mul(vec3(0.9, 1.0, 1.08)), c.mul(vec3(1.06, 1.0, 0.92)), smoothstep(0.25, 0.85, l)));
      const q = p.sub(0.5).mul(uAspect);
      c.mulAssign(mix(1.0, smoothstep(0.2, 0.95, length(q)).oneMinus(), 0.55));
      c.assign(pow(c, vec3(1.0 / 2.2)));
      c.addAssign(grain(screenCoordinate.xy.add(fract(uTime).mul(917.0))).sub(0.5).mul(0.025));
      return vec4(c, 1.0);
    })()
  );
  return { material, bloom };
}
