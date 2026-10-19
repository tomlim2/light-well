// A fish: one mesh per body shape, drawn once per fish of that shape. The vertex stage reads the
// fish's place, heading and look from the school's buffers (which the compute kernels keep up to
// date), makes it swim (a wave running down the body to the tail) and turns it the way it is
// going; the fragment stage lights it from above with the same sunlight the floor gets.
import * as THREE from 'three/webgpu';
import { Fn, If, varying, attribute, instanceIndex, positionGeometry, normalGeometry, positionWorld, vec3, vec4, smoothstep, sin, cos, atan, length, normalize, dot, max, abs, mix, exp, pow } from 'three/tsl';
import { FOG } from './room.js';

// Where this vertex of this fish is in the world, after the swimming wave and the fish's turn and
// size. Both the fish and their height mask need it, so it is shared.
function fishVertex({ buffers, uClock, uFright }, uBase) {
  const f = instanceIndex.add(uBase);
  const P = buffers.pos.element(f);
  const H = buffers.head.element(f);
  const L = buffers.look.element(f); // phase, how fast the tail beats, how hard, belly paleness
  const T = buffers.trait.element(f); // size, length, speed, keeps to itself
  const C = buffers.tint.element(f);
  const along = attribute('aAlong', 'float'); // 0 at the snout .. 1 at the tip of the tail
  const fin = attribute('aFin', 'float'); // 0 body, 1 fin

  // the body bends: more toward the tail, and harder while the school is bolting
  const k = smoothstep(0.12, 1.0, along);
  const wave = sin(uClock.mul(L.y).add(L.x).sub(along.mul(5.0)));
  const bend = k.mul(k).mul(L.z).mul(uFright.mul(0.6).add(1.0)).mul(wave)
    // the head yaws a touch the other way, the way a fish's does
    .sub(k.oneMinus().mul(0.02).mul(L.z).mul(6.0).mul(wave).mul(along.oneMinus()));
  const q = vec3(positionGeometry.xy, positionGeometry.z.add(bend));

  // the fish's own axes: nose along the heading, tipped up or down by most of its climb
  const flat = max(length(H.xz), 1e-4);
  const pitch = atan(H.y, flat).mul(0.8);
  const cp = cos(pitch);
  const sp = sin(pitch);
  const hx = H.x.div(flat);
  const hz = H.z.div(flat);
  const F = vec3(cp.mul(hx), sp, cp.mul(hz));
  const U = vec3(sp.negate().mul(hx), cp, sp.negate().mul(hz));
  const S = vec3(hz.negate(), 0.0, hx);
  const size = T.x;
  const len = T.y;
  const world = P.xyz.add(F.mul(q.x.mul(size).mul(len))).add(U.mul(q.y.mul(size))).add(S.mul(q.z.mul(size))).toVar();
  const n = normalGeometry;
  const normal = normalize(F.mul(n.x.div(len)).add(U.mul(n.y)).add(S.mul(n.z))).toVar();
  return { world, normal, tint: C.xyz, look: L, fin };
}

export function fishMaterial(ctx, uBase) {
  const { beam, uCam } = ctx;
  const m = new THREE.NodeMaterial();
  m.side = THREE.DoubleSide;
  const v = fishVertex(ctx, uBase);
  m.positionNode = v.world;
  const vNormal = varying(v.normal);
  const vTint = varying(v.tint);
  const vLook = varying(v.look);
  m.fragmentNode = Fn(() => {
    const N = normalize(vNormal).toVar();
    const V = normalize(uCam.sub(positionWorld)).toVar();
    const facing = dot(N, V).toVar();
    If(facing.lessThan(0.0), () => {
      N.assign(N.negate()); // fins are seen from both sides
    });
    const local = beam.beamLocalAt(positionWorld.xz, positionWorld.y).toVar();
    const inside = beam.beamInside(local, 0.3).toVar();
    const sun = beam.sunlight(local).mul(1.2).add(0.3).mul(inside).toVar();
    // the fish's own back shades its belly, and any fish above it shades it too: but a shadow
    // thrown through a metre of lit water is a soft, partial one, not a black silhouette
    const above = beam.fishAbove(local).sub(positionWorld.y.add(0.004));
    const shadow = smoothstep(-0.02, 0.07, above).mul(mix(1.0, 0.3, smoothstep(0.08, 0.6, above)));
    const lit = shadow.oneMinus().toVar();
    const fall = exp(beam.uBeam.w.sub(positionWorld.y).mul(-0.08));
    const top = max(N.y, 0.0);
    const under = max(N.y.negate(), 0.0);

    // a goldfish is deep orange on the back, paler gold at the belly; fins lighter and thin
    const tint = vTint;
    const belly = mix(tint, vec3(1.0, 0.82, 0.55), vLook.w);
    const albedo = mix(tint, belly, smoothstep(-0.75, -0.15, N.y).oneMinus()).toVar();
    albedo.assign(mix(albedo, mix(tint, vec3(1.0, 0.88, 0.7), 0.5), v.fin.mul(0.6)));

    const sunCol = vec3(1.0, 0.92, 0.76);
    const key = sunCol.mul(sun).mul(lit).mul(fall).toVar();
    const col = albedo.mul(key).mul(top.mul(1.3).add(0.65)).toVar();
    // fins are thin: the sunlight shines through them
    col.addAssign(albedo.mul(key).mul(v.fin).mul(0.4));
    // the lit floor throws warm light back up, and the water round about is teal
    const bounce = inside.mul(exp(positionWorld.y.mul(-0.12))).mul(under.mul(0.6).add(0.4));
    col.addAssign(albedo.mul(vec3(0.04, 0.08, 0.1).add(vec3(1.0, 0.75, 0.45).mul(bounce))));
    // a wet sheen off the scales
    const H = normalize(V.add(vec3(0.0, 1.0, 0.0)));
    col.addAssign(sunCol.mul(pow(max(dot(N, H), 0.0), 40.0)).mul(sun).mul(lit).mul(0.5).mul(v.fin.oneMinus()));
    // the haze catches the edge of the body
    col.addAssign(vec3(0.05, 0.14, 0.18).mul(pow(abs(facing).oneMinus(), 4.0)).mul(inside).mul(0.5));
    col.assign(mix(col, vec3(...FOG), exp(length(uCam.sub(positionWorld)).mul(-0.015)).oneMinus()));
    return vec4(col, 1.0);
  })();
  return m;
}

// the same fish drawn into the height mask: seen from straight above, each spot keeps the highest
// fish over it (stored + 100, so that "no fish" can be 0)
export function maskMaterial(ctx, uBase) {
  const { beam } = ctx;
  const m = new THREE.NodeMaterial();
  const v = fishVertex(ctx, uBase);
  const vHeight = varying(v.world.y);
  m.vertexNode = Fn(() => {
    // in the beam's frame at this height, so the shadow falls along the (diverging) ray
    const local = beam.beamLocalAt(v.world.xz, v.world.y);
    const t = beam.beamUv(local);
    // the texture's first row is the top of the clip space, in both backends
    return vec4(t.x.mul(2.0).sub(1.0), t.y.mul(-2.0).add(1.0), 0.0, 1.0);
  })();
  m.fragmentNode = vec4(vHeight.add(100.0), 0.0, 0.0, 1.0);
  m.side = THREE.DoubleSide;
  m.depthTest = false;
  m.depthWrite = false;
  m.blending = THREE.CustomBlending;
  m.blendEquation = THREE.MaxEquation;
  m.blendSrc = THREE.OneFactor;
  m.blendDst = THREE.OneFactor;
  return m;
}
