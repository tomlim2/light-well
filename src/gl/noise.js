// Noise shared by the shaders: hashes, value noise, fbm, and the caustic pattern the sunlight makes
// after it has come through a rippled surface.

export const NOISE = /* glsl */ `
  // hashes without sine (after Dave Hoskins), stable across GPUs
  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  vec2 hash22(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float s = 0.0;
    float a = 0.5;
    for (int i = 0; i < 5; i++) {
      s += a * vnoise(p);
      p = mat2(1.6, 1.2, -1.2, 1.6) * p + 17.1;
      a *= 0.5;
    }
    return s;
  }
  mat2 turn2(float a) {
    float c = cos(a);
    float s = sin(a);
    return mat2(c, s, -s, c);
  }

  // The two nearest of a field of drifting points: (nearest, second nearest).
  vec2 cells(vec2 p, float t) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float f1 = 8.0;
    float f2 = 8.0;
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 g = vec2(float(x), float(y));
        vec2 h = hash22(i + g);
        vec2 o = 0.5 + 0.38 * sin(t * (0.55 + 0.6 * h) + 6.2831 * h);
        float d = length(g + o - f);
        if (d < f1) {
          f2 = f1;
          f1 = d;
        } else if (d < f2) {
          f2 = d;
        }
      }
    }
    return vec2(f1, f2);
  }

  // Caustics: a rippled surface bends sunlight into bright rounded pools with dark seams between.
  // Two layers of cells, the plane warped by slow noise first so the pools are never regular.
  // Three layers at different scales and turns, added: the seams of one fall inside the pools of
  // another, so no network of lines shows through.
  float caustic(vec2 p, float t) {
    vec2 w = p + 0.55 * vec2(fbm(p * 0.5 + t * 0.05), fbm(p * 0.5 - t * 0.04 + 4.3));
    vec2 a = cells(w * 1.5, t * 0.9);
    vec2 b = cells(turn2(0.7) * w * 2.5 + 5.3, t * 1.2);
    vec2 c = cells(turn2(-0.9) * w * 2.0 + 9.1, t * 1.0);
    float ca = pow(smoothstep(0.0, 0.55, a.y - a.x), 1.3);
    float cb = pow(smoothstep(0.0, 0.5, b.y - b.x), 1.3);
    float cc = pow(smoothstep(0.0, 0.5, c.y - c.x), 1.3);
    return (ca + cb + 0.6 * cc) / 2.1 + 0.35 * ca * cb;
  }
`;
