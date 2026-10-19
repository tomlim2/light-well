// Noise shared by the shaders: hashes, value noise, fbm, and the caustic pattern the sunlight makes
// after it has come through a rippled surface. Each one is a real shader function (a Fn with a
// layout), so the shaders that call them many times stay short.
import { Fn, If, Loop, float, int, vec2, vec3, fract, floor, mix, dot, sin, cos, length, smoothstep, pow } from 'three/tsl';

// hashes without sine (after Dave Hoskins), stable across GPUs
export const hash12 = Fn(
  ([p]) => {
    const p3 = fract(vec3(p.xyx).mul(0.1031)).toVar();
    p3.addAssign(dot(p3, p3.yzx.add(33.33)));
    return fract(p3.x.add(p3.y).mul(p3.z));
  },
  { p: 'vec2', return: 'float' }
);

export const hash22 = Fn(
  ([p]) => {
    const p3 = fract(vec3(p.xyx).mul(vec3(0.1031, 0.103, 0.0973))).toVar();
    p3.addAssign(dot(p3, p3.yzx.add(33.33)));
    return fract(p3.xx.add(p3.yz).mul(p3.zy));
  },
  { p: 'vec2', return: 'vec2' }
);

export const vnoise = Fn(
  ([p]) => {
    const i = floor(p);
    const f = fract(p);
    const u = f.mul(f).mul(f.mul(-2.0).add(3.0));
    const a = hash12(i);
    const b = hash12(i.add(vec2(1.0, 0.0)));
    const c = hash12(i.add(vec2(0.0, 1.0)));
    const d = hash12(i.add(vec2(1.0, 1.0)));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  },
  { p: 'vec2', return: 'float' }
);

export const fbm = Fn(
  ([p]) => {
    const q = vec2(p).toVar();
    const s = float(0.0).toVar();
    const a = float(0.5).toVar();
    Loop(5, () => {
      s.addAssign(a.mul(vnoise(q)));
      // the plane turned and stretched a little between octaves, so they never line up
      q.assign(vec2(q.x.mul(1.6).sub(q.y.mul(1.2)), q.x.mul(1.2).add(q.y.mul(1.6))).add(17.1));
      a.mulAssign(0.5);
    });
    return s;
  },
  { p: 'vec2', return: 'float' }
);

// v turned by a
export const turn = Fn(
  ([v, a]) => {
    const c = cos(a);
    const s = sin(a);
    return vec2(v.x.mul(c).sub(v.y.mul(s)), v.x.mul(s).add(v.y.mul(c)));
  },
  { v: 'vec2', a: 'float', return: 'vec2' }
);

const NEIGHBOURS = () => ({ start: int(-1), end: int(1), condition: '<=' });

// The two nearest of a field of drifting points: (nearest, second nearest).
export const cells = Fn(
  ([p, t]) => {
    const cell = floor(p);
    const f = fract(p);
    const f1 = float(8.0).toVar();
    const f2 = float(8.0).toVar();
    Loop(NEIGHBOURS(), NEIGHBOURS(), ({ i, j }) => {
      const g = vec2(float(j), float(i));
      const h = hash22(cell.add(g));
      const o = sin(t.mul(h.mul(0.6).add(0.55)).add(h.mul(6.2831))).mul(0.38).add(0.5);
      const d = length(g.add(o).sub(f));
      If(d.lessThan(f1), () => {
        f2.assign(f1);
        f1.assign(d);
      }).ElseIf(d.lessThan(f2), () => {
        f2.assign(d);
      });
    });
    return vec2(f1, f2);
  },
  { p: 'vec2', t: 'float', return: 'vec2' }
);

// Caustics: a rippled surface bends sunlight into bright rounded pools with dark seams between.
// Two layers of cells, the plane warped by slow noise first so the pools are never regular.
// Three layers at different scales and turns, added: the seams of one fall inside the pools of
// another, so no network of lines shows through.
export const caustic = Fn(
  ([p, t]) => {
    const w = p.add(vec2(fbm(p.mul(0.5).add(t.mul(0.05))), fbm(p.mul(0.5).sub(t.mul(0.04)).add(4.3))).mul(0.55));
    const a = cells(w.mul(1.5), t.mul(0.9));
    const b = cells(turn(w, 0.7).mul(2.5).add(5.3), t.mul(1.2));
    const c = cells(turn(w, -0.9).mul(2.0).add(9.1), t.mul(1.0));
    const ca = pow(smoothstep(0.0, 0.55, a.y.sub(a.x)), 1.3);
    const cb = pow(smoothstep(0.0, 0.5, b.y.sub(b.x)), 1.3);
    const cc = pow(smoothstep(0.0, 0.5, c.y.sub(c.x)), 1.3);
    return ca.add(cb).add(cc.mul(0.6)).div(2.1).add(ca.mul(cb).mul(0.35));
  },
  { p: 'vec2', t: 'float', return: 'float' }
);

// a still field of cells, for the flagstones. x: how far from the nearest seam, y: which stone
export const stones = Fn(
  ([p]) => {
    const cell = floor(p);
    const f = fract(p);
    const f1 = float(8.0).toVar();
    const f2 = float(8.0).toVar();
    const id = vec2(0.0).toVar();
    Loop(NEIGHBOURS(), NEIGHBOURS(), ({ i, j }) => {
      const g = vec2(float(j), float(i));
      const o = hash22(cell.add(g)).mul(0.8).add(0.1);
      const d = length(g.add(o).sub(f));
      If(d.lessThan(f1), () => {
        f2.assign(f1);
        f1.assign(d);
        id.assign(cell.add(g));
      }).ElseIf(d.lessThan(f2), () => {
        f2.assign(d);
      });
    });
    return vec2(f2.sub(f1), hash12(id));
  },
  { p: 'vec2', return: 'vec2' }
);
