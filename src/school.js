// The fish: three body shapes made in code, and a school of them that keeps together, keeps apart,
// keeps to the light, and scatters when something startles it.
import * as THREE from 'three';

/* ---------------------------------------------------------------- the meshes */

// One fish a unit long, head toward +x, back toward +y, flat across z. Every vertex knows how far
// down the fish it is (aAlong, for the swimming wave) and whether it is fin (aFin, thin and light).
// shape: depth (how tall the body), slim (how narrow), tail (how long), fork (how deep its notch),
// spread (how wide it opens), dorsal (how tall the fin on the back)
export function fishGeometry({ depth = 0.15, slim = 1, tail = 0.19, fork = 0.1, spread = 0.16, dorsal = 1 } = {}) {
  const pos = [];
  const nrm = [];
  const along = [];
  const fin = [];
  const idx = [];
  const vert = (p, n, a, f) => {
    pos.push(p[0], p[1], p[2]);
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    nrm.push(n[0] / l, n[1] / l, n[2] / l);
    along.push(a);
    fin.push(f);
    return pos.length / 3 - 1;
  };

  // body: rings from the snout to where the tail fin starts
  const SNOUT = 0.5;
  const ROOT = -0.2; // the narrow wrist before the tail
  const RINGS = 20;
  const AROUND = 14;
  const height = (u) => 0.026 + depth * Math.sin(Math.PI * Math.pow(u, 0.6)) * (1 - 0.42 * u);
  const width = (u) => height(u) * (0.52 - 0.18 * u) * slim;
  const atU = (u) => SNOUT + (ROOT - SNOUT) * u;
  const bodyAlong = (x) => Math.min(1, (SNOUT - x) / (SNOUT - -0.5));
  const tip = vert([SNOUT + 0.02, -0.005, 0], [1, 0, 0], 0, 0);
  let prev = null;
  for (let i = 0; i <= RINGS; i++) {
    const u = 0.02 + (0.98 * i) / RINGS;
    const x = atU(u);
    const h = height(u);
    const w = width(u);
    const ring = [];
    for (let j = 0; j < AROUND; j++) {
      const a = (j / AROUND) * Math.PI * 2;
      // a slightly fuller belly than back
      const y = h * Math.sin(a) * (Math.sin(a) < 0 ? 0.92 : 1) - 0.01;
      const z = w * Math.cos(a);
      ring.push(vert([x, y, z], [0.25 * (1 - 2 * u), Math.sin(a) / h, Math.cos(a) / w], bodyAlong(x), 0));
    }
    if (prev) {
      for (let j = 0; j < AROUND; j++) {
        const k = (j + 1) % AROUND;
        idx.push(prev[j], ring[j], prev[k], prev[k], ring[j], ring[k]);
      }
    } else {
      for (let j = 0; j < AROUND; j++) idx.push(tip, ring[j], ring[(j + 1) % AROUND]);
    }
    prev = ring;
  }

  // a flat fin from a grid: shape(s, t) gives the point for s from the root (0) to the edge (1)
  // and t across (-1..1)
  const flatFin = (shape, normal, S = 5, T = 8) => {
    const grid = [];
    for (let i = 0; i <= S; i++) {
      const row = [];
      for (let j = 0; j <= T; j++) {
        const p = shape(i / S, (j / T) * 2 - 1);
        row.push(vert(p, normal, bodyAlong(p[0]), 1));
      }
      grid.push(row);
    }
    for (let i = 0; i < S; i++) {
      for (let j = 0; j < T; j++) idx.push(grid[i][j], grid[i + 1][j], grid[i][j + 1], grid[i][j + 1], grid[i + 1][j], grid[i + 1][j + 1]);
    }
  };
  // the tail: two lobes with a notch between
  flatFin((s, t) => [ROOT + 0.02 - s * (tail + fork * Math.pow(Math.abs(t), 1.4)), t * (0.03 + spread * s) - 0.008, 0], [0, 0, 1]);
  // the fin along the back
  flatFin((s, t) => {
    const u = 0.22 + 0.45 * (t * 0.5 + 0.5);
    const x = atU(u);
    return [x - s * 0.05, height(u) * 0.96 - 0.01 + s * 0.075 * dorsal * Math.pow(Math.sin(Math.PI * (t * 0.5 + 0.5)), 0.7), 0];
  }, [0, 0, 1], 3, 8);
  // the small fin underneath, toward the tail
  flatFin((s, t) => {
    const u = 0.58 + 0.28 * (t * 0.5 + 0.5);
    const x = atU(u);
    return [x - s * 0.04, -height(u) * 0.9 - 0.01 - s * 0.045 * Math.sin(Math.PI * (t * 0.5 + 0.5)), 0];
  }, [0, 0, 1], 2, 5);
  // the paired fins behind the gills, splayed out and back
  for (const side of [-1, 1]) {
    flatFin((s, t) => {
      const u = 0.24;
      const x = atU(u) - s * 0.09 + t * 0.02;
      return [x, -height(u) * 0.35 + t * 0.03 - s * 0.03, side * (width(u) * 0.9 + s * 0.07)];
    }, [0, 1, side * 0.2], 2, 3);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('aAlong', new THREE.Float32BufferAttribute(along, 1));
  g.setAttribute('aFin', new THREE.Float32BufferAttribute(fin, 1));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

export const BODIES = {
  round: { depth: 0.15, slim: 1.0, tail: 0.19, fork: 0.1, spread: 0.16, dorsal: 1.0 },
  slim: { depth: 0.1, slim: 0.85, tail: 0.16, fork: 0.09, spread: 0.12, dorsal: 0.6 },
  fantail: { depth: 0.14, slim: 1.0, tail: 0.3, fork: 0.17, spread: 0.25, dorsal: 1.35 },
};

/* ---------------------------------------------------------------- who is in the school */

// [colour, how many, how pale the belly goes, body, keeps to itself]
const KINDS = [
  ['#ff7417', 10, 0.45, 'round', false],
  ['#ff8a26', 6, 0.55, 'fantail', false],
  ['#ffb22e', 6, 0.4, 'round', false],
  ['#ff5a24', 4, 0.5, 'fantail', false],
  ['#ff7417', 4, 0.45, 'slim', false],
  ['#f6d2bd', 4, 0.2, 'slim', false],
  ['#d6e8ee', 3, 0.3, 'slim', true],
  ['#8fd0dc', 3, 0.35, 'slim', true],
];

function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------------------------------------------------------- the school */

// The school lives in the column of light: a box `half` across (in the light's own frame, turned
// by `turn`) between heights `low` and `high`. Each fish steers by the usual three rules (keep
// apart from the nearest, swim the way the neighbours swim, stay with them), wanders a little on
// its own, and is turned back gently whenever it strays toward the dark. Startled, the whole school
// bolts away from the spot and then, over a second or two, draws together again.
export class School {
  constructor({ half, turn, low, high, seed = 7 }) {
    this.half = half;
    this.cos = Math.cos(turn);
    this.sin = Math.sin(turn);
    this.low = low;
    this.high = high;
    this.fright = 0;
    this.scare = new THREE.Vector3();
    const R = seeded(seed);
    this.fish = [];
    this.groups = {}; // body shape -> the fish of that shape, in the order their mesh draws them
    for (const [hex, count, pale, body, loner] of KINDS) {
      for (let i = 0; i < count; i++) {
        const u = (R() * 2 - 1) * half * 0.8;
        const v = (R() * 2 - 1) * half * 0.8;
        const p = new THREE.Vector3(u * this.cos - v * this.sin, low + R() * (high - low), u * this.sin + v * this.cos);
        const a = R() * Math.PI * 2;
        const f = {
          p,
          v: new THREE.Vector3(Math.cos(a), (R() - 0.5) * 0.1, Math.sin(a)).multiplyScalar(0.12),
          heading: new THREE.Vector3(Math.cos(a), 0, Math.sin(a)),
          size: 0.5 + R() * 0.25,
          len: 0.9 + R() * 0.25,
          speed: 0.1 + R() * 0.08,
          tint: new THREE.Color(hex),
          pale,
          loner,
          phase: R() * Math.PI * 2,
          beat: 7 + R() * 4,
          sway: 0.08 + R() * 0.05,
          wander: R() * 100,
        };
        this.fish.push(f);
        (this.groups[body] ??= []).push(f);
      }
    }
  }

  // the light's frame <-> the world
  toLocal(p) {
    return [p.x * this.cos + p.z * this.sin, -p.x * this.sin + p.z * this.cos];
  }

  // something happened at `point`: the first jolt is immediate, the rest plays out in step()
  startle(point) {
    this.scare.copy(point);
    this.fright = 1;
    const away = new THREE.Vector3();
    for (const f of this.fish) {
      away.subVectors(f.p, point);
      const d = away.length() || 1e-3;
      f.v.addScaledVector(away, (0.9 * Math.exp(-(d * d) / 6)) / d);
    }
  }

  step(dt, t) {
    this.fright *= Math.exp(-dt / 1.0);
    const fright = this.fright;
    const calm = 1 - 0.75 * fright;
    const all = this.fish;
    const steer = new THREE.Vector3();
    const tmp = new THREE.Vector3();
    const mid = (this.low + this.high) / 2 + Math.sin(t * 0.17) * 0.7;
    // the school wheels slowly round the column, the way a school does in a shaft of light
    const wheel = Math.sin(t * 0.03) > 0 ? 1 : -1;
    for (const f of all) {
      steer.set(0, 0, 0);
      const apart = new THREE.Vector3();
      const align = new THREE.Vector3();
      const centre = new THREE.Vector3();
      let near = 0;
      for (const g of all) {
        if (g === f) continue;
        tmp.subVectors(f.p, g.p);
        const d = tmp.length();
        if (d < 1.6) {
          near++;
          align.add(g.v);
          centre.add(g.p);
          if (d < 0.9) apart.addScaledVector(tmp, (0.9 - d) / Math.max(d, 1e-3));
        }
      }
      if (near) {
        steer.addScaledVector(apart, 1.2);
        steer.addScaledVector(align.divideScalar(near).sub(f.v), (f.loner ? 0.1 : 0.4) * calm);
        steer.addScaledVector(centre.divideScalar(near).sub(f.p), (f.loner ? 0 : 0.06) * calm);
      }
      // round the axis: a gentle push along the tangent
      const [tu, tv] = this.toLocal(f.p);
      const ring = Math.hypot(tu, tv) + 1e-3;
      const tangU = (-tv / ring) * wheel;
      const tangV = (tu / ring) * wheel;
      steer.x += (tangU * this.cos - tangV * this.sin) * 0.04;
      steer.z += (tangU * this.sin + tangV * this.cos) * 0.04;
      // its own whim
      f.wander += dt * 0.6;
      steer.x += Math.sin(f.wander * 1.3) * 0.06;
      steer.z += Math.cos(f.wander * 0.9) * 0.06;
      steer.y += Math.sin(f.wander * 0.7) * 0.02;
      // away from whatever startled it
      if (fright > 0.01) {
        tmp.subVectors(f.p, this.scare);
        const d = tmp.length() || 1e-3;
        steer.addScaledVector(tmp, (fright * 2.5 * Math.exp(-(d * d) / 6)) / d);
      }
      // back toward the light, more firmly the further it has strayed; a bolting fish would shoot
      // straight out of the light, so the walls push back harder then
      const [u, v] = this.toLocal(f.p);
      const lim = this.half * 0.78;
      const wall = 1.0 + 4.0 * fright;
      const pushU = Math.abs(u) > lim ? -Math.sign(u) * (Math.abs(u) - lim) * wall : 0;
      const pushV = Math.abs(v) > lim ? -Math.sign(v) * (Math.abs(v) - lim) * wall : 0;
      steer.x += pushU * this.cos - pushV * this.sin;
      steer.z += pushU * this.sin + pushV * this.cos;
      const level = f.loner ? this.low + 0.8 : mid;
      steer.y += (level - f.p.y) * 0.03 + (f.p.y > this.high ? this.high - f.p.y : f.p.y < this.low ? this.low - f.p.y : 0) * 1.2 * wall;

      f.v.addScaledVector(steer, dt);
      // fish swim level: rising and sinking are slow
      f.v.y *= 1 - 1.5 * dt;
      const sp = f.v.length();
      const want = f.speed * (1 + 1.6 * fright);
      f.v.multiplyScalar(Math.min(Math.max(sp, want * 0.6), want * 1.5) / Math.max(sp, 1e-5));
    }
    for (const f of all) {
      f.p.addScaledVector(f.v, dt);
      // the body turns toward where it is going, not at once; quicker when bolting
      tmp.copy(f.v).normalize();
      f.heading.lerp(tmp, 1 - Math.exp(-(3 + 7 * fright) * dt)).normalize();
    }
  }

  // write each fish's place, turn and size into its shape's instanced mesh
  write(meshes) {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler(0, 0, 0, 'YZX');
    const s = new THREE.Vector3();
    for (const [body, group] of Object.entries(this.groups)) {
      const mesh = meshes[body];
      group.forEach((f, i) => {
        const h = f.heading;
        const flat = Math.hypot(h.x, h.z);
        e.set(0, Math.atan2(-h.z, h.x), Math.atan2(h.y, flat) * 0.8);
        q.setFromEuler(e);
        m.compose(f.p, q, s.set(f.size * f.len, f.size, f.size));
        mesh.setMatrixAt(i, m);
      });
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  // the per-fish look, as instanced attributes on each shape's geometry
  looks(geometries) {
    for (const [body, group] of Object.entries(this.groups)) {
      const n = group.length;
      const tint = new Float32Array(n * 3);
      const look = new Float32Array(n * 4);
      group.forEach((f, i) => {
        tint.set([f.tint.r, f.tint.g, f.tint.b], i * 3);
        look.set([f.phase, f.beat, f.sway, f.pale], i * 4);
      });
      geometries[body].setAttribute('aTint', new THREE.InstancedBufferAttribute(tint, 3));
      geometries[body].setAttribute('aLook', new THREE.InstancedBufferAttribute(look, 4));
    }
  }
}
