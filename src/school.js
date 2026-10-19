// The fish: three body shapes made in code, and who is in the school. (How the school moves is in
// tsl/boids.js, on the GPU.)
import * as THREE from 'three/webgpu';

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
export const KINDS = [
  ['#ff7417', 10, 0.45, 'round', false],
  ['#ff8a26', 6, 0.55, 'fantail', false],
  ['#ffb22e', 6, 0.4, 'round', false],
  ['#ff5a24', 4, 0.5, 'fantail', false],
  ['#ff7417', 4, 0.45, 'slim', false],
  ['#f6d2bd', 4, 0.2, 'slim', false],
  ['#d6e8ee', 3, 0.3, 'slim', true],
  ['#8fd0dc', 3, 0.35, 'slim', true],
];

export function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
