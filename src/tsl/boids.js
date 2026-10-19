// The school, on the GPU. Every fish lives in a few storage buffers; two compute kernels a frame
// move it: the first works out where each fish wants to go from where the others are, the second
// moves it there. Writing to one buffer while reading another keeps the frame race-free.
//
// Each fish steers by the usual three rules (keep apart from the nearest, swim the way the
// neighbours swim, stay with them), wanders a little on its own, and is turned back gently
// whenever it strays toward the dark. Startled, the whole school bolts away from the spot and
// then, over a second or two, draws together again.
import * as THREE from 'three/webgpu';
import { Fn, If, Loop, Continue, uniform, instancedArray, instanceIndex, float, uint, vec2, vec3, vec4, length, normalize, max, abs, sign, exp, sin, cos, mix, clamp, select } from 'three/tsl';
import { KINDS, seeded } from '../school.js';

export function createSchool({ half, turn, low, high, seed = 7, scale = 1 }) {
  const cosT = Math.cos(turn);
  const sinT = Math.sin(turn);
  const R = seeded(seed);

  /* ---------------------------------------------------------------- who is in the school */
  // the fish, in the order of KINDS, then sorted by body so each body's mesh draws one run of them
  const fish = [];
  for (const [hex, count, pale, body, loner] of KINDS) {
    for (let i = 0; i < Math.max(1, Math.round(count * scale)); i++) {
      const u = (R() * 2 - 1) * half * 0.8;
      const v = (R() * 2 - 1) * half * 0.8;
      const a = R() * Math.PI * 2;
      fish.push({
        body,
        p: [u * cosT - v * sinT, low + R() * (high - low), u * sinT + v * cosT],
        v: [Math.cos(a) * 0.12, (R() - 0.5) * 0.1 * 0.12, Math.sin(a) * 0.12],
        heading: [Math.cos(a), 0, Math.sin(a)],
        size: 0.5 + R() * 0.25,
        len: 0.9 + R() * 0.25,
        speed: 0.1 + R() * 0.08,
        tint: new THREE.Color(hex),
        pale,
        loner: loner ? 1 : 0,
        phase: R() * Math.PI * 2,
        beat: 7 + R() * 4,
        sway: 0.08 + R() * 0.05,
        wander: R() * 100,
      });
    }
  }
  const order = ['round', 'fantail', 'slim'];
  fish.sort((a, b) => order.indexOf(a.body) - order.indexOf(b.body));
  const N = fish.length;
  const groups = {};
  fish.forEach((f, i) => {
    const g = (groups[f.body] ??= { base: i, count: 0 });
    g.count++;
  });

  /* ---------------------------------------------------------------- the buffers */
  // vec4 throughout: a vec3 would be padded in WGSL, and the WebGL fallback reads these through
  // RGBA textures. PBO lets the WebGL fallback read any fish's data, not just its own.
  const buffer = (fill) => {
    const node = instancedArray(N, 'vec4').setPBO(true);
    const a = node.value.array;
    fish.forEach((f, i) => a.set(fill(f), i * 4));
    return node;
  };
  const pos = buffer((f) => [...f.p, f.wander]); // where it is; w: its wander clock
  const vel = buffer((f) => [...f.v, 0]);
  const want = buffer(() => [0, 0, 0, 0]); // the velocity the first kernel works out
  const head = buffer((f) => [...f.heading, 0]); // the way the body points
  const look = buffer((f) => [f.phase, f.beat, f.sway, f.pale]);
  const trait = buffer((f) => [f.size, f.len, f.speed, f.loner]);
  const tint = buffer((f) => [f.tint.r, f.tint.g, f.tint.b, 0]);

  /* ---------------------------------------------------------------- the kernels */
  const uDt = uniform(0);
  const uFright = uniform(0);
  const uScare = uniform(new THREE.Vector3());
  const uJolt = uniform(0); // the first push away from the tap, on the frame of the tap only
  const uWheel = uniform(1); // which way round the column the school is turning
  const uMid = uniform((low + high) / 2); // the height the school keeps to, drifting

  // the light's frame <-> the world
  const toLocal = (p) => vec2(p.x.mul(cosT).add(p.z.mul(sinT)), p.z.mul(cosT).sub(p.x.mul(sinT)));
  const toWorld = (u, v) => vec2(u.mul(cosT).sub(v.mul(sinT)), u.mul(sinT).add(v.mul(cosT)));

  const steer = Fn(() => {
    const self = instanceIndex;
    const p = pos.element(self).xyz.toVar();
    const v = vel.element(self).xyz.toVar();
    const wander = pos.element(self).w;
    const T = trait.element(self);
    const loner = T.w;
    const fright = uFright;
    const calm = fright.mul(-0.75).add(1.0);

    // the neighbours: everyone within 1.6 m
    const apart = vec3(0.0).toVar();
    const align = vec3(0.0).toVar();
    const centre = vec3(0.0).toVar();
    const near = float(0.0).toVar();
    Loop(N, ({ i }) => {
      const other = uint(i);
      If(other.equal(self), () => {
        Continue();
      });
      const q = pos.element(other).xyz;
      const away = p.sub(q);
      const d = length(away);
      If(d.lessThan(1.6), () => {
        near.addAssign(1.0);
        align.addAssign(vel.element(other).xyz);
        centre.addAssign(q);
        If(d.lessThan(0.9), () => {
          apart.addAssign(away.mul(float(0.9).sub(d).div(max(d, 1e-3))));
        });
      });
    });
    const s = vec3(0.0).toVar();
    If(near.greaterThan(0.0), () => {
      s.addAssign(apart.mul(1.2));
      s.addAssign(align.div(near).sub(v).mul(mix(0.4, 0.1, loner).mul(calm)));
      s.addAssign(centre.div(near).sub(p).mul(mix(0.06, 0.0, loner).mul(calm)));
    });
    // round the axis: a gentle push along the tangent, the way a school wheels in a shaft of light
    const local = toLocal(p);
    const ring = length(local).add(1e-3);
    const tang = toWorld(local.y.negate().div(ring).mul(uWheel), local.x.div(ring).mul(uWheel)).mul(0.04);
    s.x.addAssign(tang.x);
    s.z.addAssign(tang.y);
    // its own whim
    s.x.addAssign(sin(wander.mul(1.3)).mul(0.06));
    s.z.addAssign(cos(wander.mul(0.9)).mul(0.06));
    s.y.addAssign(sin(wander.mul(0.7)).mul(0.02));
    // away from whatever startled it: a jolt on the moment, then a push that fades with the fright
    const fromScare = p.sub(uScare);
    const dScare = max(length(fromScare), 1e-3);
    const scared = exp(dScare.mul(dScare).div(-6.0)).div(dScare);
    v.addAssign(fromScare.mul(uJolt.mul(scared)));
    If(fright.greaterThan(0.01), () => {
      s.addAssign(fromScare.mul(fright.mul(2.5).mul(scared)));
    });
    // back toward the light, more firmly the further it has strayed; a bolting fish would shoot
    // straight out of the light, so the walls push back harder then
    const lim = half * 0.78;
    const wall = fright.mul(4.0).add(1.0);
    const over = abs(local).sub(lim);
    const push = select(over.greaterThan(0.0), sign(local).negate().mul(over).mul(wall), vec2(0.0));
    const pushW = toWorld(push.x, push.y);
    s.x.addAssign(pushW.x);
    s.z.addAssign(pushW.y);
    const level = mix(uMid, float(low + 0.8), loner);
    const outside = select(p.y.greaterThan(high), float(high).sub(p.y), select(p.y.lessThan(low), float(low).sub(p.y), float(0.0)));
    s.y.addAssign(level.sub(p.y).mul(0.03).add(outside.mul(1.2).mul(wall)));

    v.addAssign(s.mul(uDt));
    // fish swim level: rising and sinking are slow
    v.y.mulAssign(uDt.mul(-1.5).add(1.0));
    const sp = length(v);
    const speed = T.z.mul(fright.mul(1.6).add(1.0));
    v.mulAssign(clamp(sp, speed.mul(0.6), speed.mul(1.5)).div(max(sp, 1e-5)));
    want.element(self).assign(vec4(v, 0.0));
  })().compute(N);

  const move = Fn(() => {
    const self = instanceIndex;
    const v = want.element(self).xyz;
    const P = pos.element(self);
    pos.element(self).assign(vec4(P.xyz.add(v.mul(uDt)), P.w.add(uDt.mul(0.6))));
    vel.element(self).assign(vec4(v, 0.0));
    // the body turns toward where it is going, not at once; quicker when bolting
    const h = head.element(self).xyz;
    const k = exp(uFright.mul(7.0).add(3.0).mul(uDt).negate()).oneMinus();
    head.element(self).assign(vec4(normalize(mix(h, normalize(v), k)), 0.0));
  })().compute(N);

  /* ---------------------------------------------------------------- the school, from outside */
  let fright = 0;
  let jolt = 0;
  const scare = new THREE.Vector3();
  return {
    count: N,
    groups,
    buffers: { pos, vel, head, look, trait, tint },
    get fright() {
      return fright;
    },
    // something happened at `point`
    startle(point) {
      scare.copy(point);
      fright = 1;
      jolt = 0.9;
    },
    step(renderer, dt, t) {
      fright *= Math.exp(-dt / 1.0);
      uDt.value = dt;
      uFright.value = fright;
      uScare.value.copy(scare);
      uJolt.value = jolt;
      uWheel.value = Math.sin(t * 0.03) > 0 ? 1 : -1;
      uMid.value = (low + high) / 2 + Math.sin(t * 0.17) * 0.7;
      renderer.compute([steer, move]);
      jolt = 0;
    },
  };
}
