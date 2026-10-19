// The scene and its frame loop.
//
// Each frame:
//   0. the school: two compute kernels move every fish                                   (GPU)
//   1. the caustic pattern of the light, and a top-down map of how high the fish are   (small)
//   2. the chamber and the fish, in HDR                                                 -> scene
//   3. the light in the water, marched through the column at half size                -> volume
//   4. bloom, then grading to the screen
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { createBeam, causticMaterial } from './tsl/light.js';
import { floorMaterial, roomMaterial, CEILING, SHAFT, WATER } from './tsl/room.js';
import { fishMaterial, maskMaterial } from './tsl/fish.js';
import { volumeMaterial, brightMaterial, downMaterial, upMaterial, finalMaterial } from './tsl/passes.js';
import { createSchool } from './tsl/boids.js';
import { fishGeometry, BODIES } from './school.js';

// the room, in metres
export const ROOM = {
  ceiling: 8.2, // floor to ceiling
  half: 1.55, // half the side of the square hole (and of the column of light)
  shaft: 0.5, // how deep the hole is, up to the water: a thin slab, as the reference has it
  turn: THREE.MathUtils.degToRad(41), // the hole is turned this far about the vertical
};

// WebGPU where there is one, WebGL 2 where there is not (three.js falls back by itself); a
// backend that will not start is tried once more the other way
async function makeRenderer(canvas, forceWebGL) {
  const make = (gl) => new THREE.WebGPURenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance', forceWebGL: gl });
  let renderer = make(forceWebGL);
  try {
    await renderer.init();
    return renderer;
  } catch (e) {
    console.warn('light-well: the renderer did not start', e);
    if (forceWebGL) return null;
  }
  renderer.dispose();
  renderer = make(true);
  try {
    await renderer.init();
    return renderer;
  } catch (e) {
    console.warn('light-well: WebGL 2 did not start either', e);
    renderer.dispose();
    return null;
  }
}

export async function createScene(host, hooks = {}) {
  const { onFail, forceWebGL = false, fish: fishScale = 1 } = hooks;
  const canvas = document.createElement('canvas');
  canvas.className = 'stage';
  host.appendChild(canvas);
  const renderer = await makeRenderer(canvas, forceWebGL);
  if (!renderer) {
    canvas.remove();
    onFail?.();
    return null;
  }
  const coarse = matchMedia('(pointer: coarse)').matches;
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, coarse ? 1.5 : 2));
  renderer.autoClear = false;
  renderer.setClearColor(0x000000, 1);
  // the last pass writes display values itself
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;

  const owned = [];
  const keep = (x) => (owned.push(x), x);
  const half = (w, h) => [Math.max(1, Math.round(w / 2)), Math.max(1, Math.round(h / 2))];

  /* ---------------------------------------------------------------- targets */
  const hdr = { type: THREE.HalfFloatType, depthBuffer: false };
  const sceneRT = keep(new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4, depthBuffer: true, depthTexture: new THREE.DepthTexture(1, 1) }));
  const volumeRT = keep(new THREE.RenderTarget(1, 1, hdr));
  const lightRT = keep(new THREE.RenderTarget(384, 384, hdr));
  const heightRT = keep(new THREE.RenderTarget(256, 256, hdr));
  const bloomLevels = 4;
  const bloomDown = Array.from({ length: bloomLevels }, () => keep(new THREE.RenderTarget(1, 1, hdr)));
  const bloomUp = Array.from({ length: bloomLevels }, () => keep(new THREE.RenderTarget(1, 1, hdr)));

  /* ---------------------------------------------------------------- shared uniforms */
  const beam = createBeam(ROOM, lightRT.texture, heightRT.texture);
  const uTime = uniform(0);
  const uCam = uniform(new THREE.Vector3());
  const uClock = uniform(0); // the swimming clock: runs faster while the school is bolting
  const uFright = uniform(0);
  const uShaft = uniform(ROOM.shaft);

  const camera = new THREE.PerspectiveCamera(60, 9 / 16, 0.1, 80);
  camera.coordinateSystem = renderer.coordinateSystem;
  const flat = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.QuadMesh();
  const pass = (material) => {
    keep(material);
    return () => {
      quad.material = material;
      quad.render(renderer);
    };
  };

  /* ---------------------------------------------------------------- the chamber */
  const world = new THREE.Scene();
  const ctx = { beam, uCam, uTime, uShaft };

  const floor = new THREE.Mesh(keep(new THREE.PlaneGeometry(60, 60).rotateX(-Math.PI / 2)), keep(floorMaterial(ctx)));
  world.add(floor);

  // the ceiling, with a square hole turned the way the light is
  const corners = (h) => [[h, h], [-h, h], [-h, -h], [h, -h]].map(([u, v]) => new THREE.Vector2(u * Math.cos(ROOM.turn) - v * Math.sin(ROOM.turn), u * Math.sin(ROOM.turn) + v * Math.cos(ROOM.turn)));
  const slab = new THREE.Shape([new THREE.Vector2(-30, -30), new THREE.Vector2(30, -30), new THREE.Vector2(30, 30), new THREE.Vector2(-30, 30)]);
  slab.holes.push(new THREE.Path(corners(ROOM.half).reverse()));
  // a Shape lies in xy; turned to lie flat facing down, its y becomes z, just as the corners have it
  const ceilingGeo = keep(new THREE.ShapeGeometry(slab).rotateX(Math.PI / 2));
  ceilingGeo.translate(0, ROOM.ceiling, 0);
  const ceilingMat = keep(roomMaterial(CEILING, ctx, { side: THREE.DoubleSide }));
  world.add(new THREE.Mesh(ceilingGeo, ceilingMat));

  // the walls, far off in the dark: every ray then ends on something, and the fog has an end
  const wallGeo = keep(new THREE.PlaneGeometry(28, ROOM.ceiling));
  for (let i = 0; i < 4; i++) {
    const wall = new THREE.Mesh(wallGeo, ceilingMat);
    wall.rotation.y = (i * Math.PI) / 2;
    wall.position.set(-14 * Math.sin(wall.rotation.y), ROOM.ceiling / 2, -14 * Math.cos(wall.rotation.y));
    wall.updateMatrixWorld();
    world.add(wall);
  }

  // the shaft's four walls, facing in, and the water at the top
  const shaftGeo = new THREE.BufferGeometry();
  {
    const c = corners(ROOM.half);
    const pos = [];
    const nrm = [];
    const y0 = ROOM.ceiling;
    const y1 = ROOM.ceiling + ROOM.shaft;
    for (let i = 0; i < 4; i++) {
      const a = c[i];
      const b = c[(i + 1) % 4];
      // inward normal: toward the middle
      const mx = (a.x + b.x) / 2;
      const mz = (a.y + b.y) / 2;
      const l = Math.hypot(mx, mz);
      const n = [-mx / l, 0, -mz / l];
      const quadPts = [[a.x, y0, a.y], [b.x, y0, b.y], [b.x, y1, b.y], [a.x, y0, a.y], [b.x, y1, b.y], [a.x, y1, a.y]];
      for (const p of quadPts) {
        pos.push(...p);
        nrm.push(...n);
      }
    }
    shaftGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    shaftGeo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  }
  keep(shaftGeo);
  world.add(new THREE.Mesh(shaftGeo, keep(roomMaterial(SHAFT, ctx, { side: THREE.DoubleSide }))));
  const waterGeo = keep(new THREE.PlaneGeometry(ROOM.half * 2, ROOM.half * 2).rotateX(Math.PI / 2).rotateY(-ROOM.turn));
  waterGeo.translate(0, ROOM.ceiling + ROOM.shaft, 0);
  world.add(new THREE.Mesh(waterGeo, keep(roomMaterial(WATER, ctx, { side: THREE.DoubleSide }))));

  /* ---------------------------------------------------------------- the fish */
  const school = createSchool({ half: ROOM.half, turn: ROOM.turn, low: 3.2, high: 7.2, scale: fishScale });
  const fishCtx = { beam, uCam, buffers: school.buffers, uClock, uFright };
  const maskScene = new THREE.Scene();
  // one mesh per body shape, drawn once per fish of that shape, and its twin in the height map
  for (const [body, shape] of Object.entries(BODIES)) {
    const group = school.groups[body];
    if (!group) continue;
    const geo = keep(new THREE.InstancedBufferGeometry().copy(fishGeometry(shape)));
    geo.instanceCount = group.count;
    const uBase = uniform(group.base, 'uint');
    const mesh = new THREE.Mesh(geo, keep(fishMaterial(fishCtx, uBase)));
    mesh.frustumCulled = false;
    world.add(mesh);
    const mask = new THREE.Mesh(geo, keep(maskMaterial(fishCtx, uBase)));
    mask.frustumCulled = false;
    maskScene.add(mask);
  }

  /* ---------------------------------------------------------------- passes */
  const causticPass = pass(causticMaterial(uTime, ROOM.half));
  const volume = {
    depthTexture: sceneRT.depthTexture,
    uProjInv: uniform(camera.projectionMatrixInverse),
    uViewInv: uniform(camera.matrixWorld),
    uNear: uniform(camera.near),
    uFar: uniform(camera.far),
    uSteps: uniform(coarse ? 24 : 40, 'int'),
    uShaft,
    uHalo: uniform(1),
    uDebug: uniform(0, 'int'),
  };
  const volumePass = pass(volumeMaterial(ctx, volume));
  const brightPass = pass(brightMaterial(sceneRT.texture, volumeRT.texture));
  const down = downMaterial(bloomDown[0].texture);
  const downPass = pass(down.material);
  const up = upMaterial(bloomDown[bloomLevels - 1].texture, bloomDown[bloomLevels - 2].texture);
  const upPass = pass(up.material);
  const final = {
    sceneTexture: sceneRT.texture,
    volumeTexture: volumeRT.texture,
    bloomTexture: bloomUp[0].texture,
    uAspect: uniform(new THREE.Vector2(1, 1)), // to keep the vignette round
    uExposure: uniform(1.0),
    uBloomAmt: uniform(0.28),
  };
  const fin = finalMaterial(ctx, final);
  const finalPass = pass(fin.material);

  /* ---------------------------------------------------------------- framing */
  // The picture is composed for a tall screen: the hole near the top, the lit floor along the
  // bottom. On a wider screen the same height is kept and the dark simply goes on to the sides; on
  // a narrower one the lens widens until the column fits across.
  // Fitted to the reference: the hole's and the floor patch's corners projected to the same places
  // in a 9:16 frame (a least-squares search over position, aim and lens, see MAP.md)
  const view = { look: new THREE.Vector3(0, 4.3, 0), from: new THREE.Vector3(-1.54, 2.71, 10.16), fovTall: 61 };
  const pointer = { x: 0, y: 0, sx: 0, sy: 0 };
  function frame() {
    const w = host.clientWidth || 1;
    const h = host.clientHeight || 1;
    const aspect = w / h;
    const tall = 9 / 16;
    const tanV = Math.tan(THREE.MathUtils.degToRad(view.fovTall / 2));
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(aspect < tall ? (tanV * tall) / aspect : tanV));
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    final.uAspect.value.set(w / Math.max(w, h), h / Math.max(w, h));
  }
  function aim(t = 0) {
    // a little give toward the pointer, as if leaning to look, over a slow drift so it never sits still
    camera.position.copy(view.from).add(new THREE.Vector3(pointer.sx * 0.5 + 0.12 * Math.sin(t * 0.07), -pointer.sy * 0.3 + 0.05 * Math.sin(t * 0.05 + 1.0), 0.1 * Math.sin(t * 0.04)));
    camera.lookAt(view.look);
    camera.updateMatrixWorld();
  }

  function resize() {
    const w = host.clientWidth || 1;
    const h = host.clientHeight || 1;
    renderer.setSize(w, h, false);
    const buf = renderer.getDrawingBufferSize(new THREE.Vector2());
    sceneRT.setSize(buf.x, buf.y);
    const [hw, hh] = half(buf.x, buf.y);
    volumeRT.setSize(hw, hh);
    let [bw, bh] = [hw, hh];
    for (let i = 0; i < bloomLevels; i++) {
      bloomDown[i].setSize(bw, bh);
      bloomUp[i].setSize(bw, bh);
      [bw, bh] = half(bw, bh);
    }
    frame();
  }
  const watcher = new ResizeObserver(resize);
  watcher.observe(host);
  resize();

  const onMove = (e) => {
    const b = host.getBoundingClientRect();
    pointer.x = ((e.clientX - b.left) / b.width) * 2 - 1;
    pointer.y = ((e.clientY - b.top) / b.height) * 2 - 1;
  };
  window.addEventListener('pointermove', onMove);
  // a tap startles the school: the spot is where the tap's ray crosses the column's middle plane
  const tapRay = new THREE.Vector3();
  const onTap = (e) => {
    const b = host.getBoundingClientRect();
    tapRay.set(((e.clientX - b.left) / b.width) * 2 - 1, -(((e.clientY - b.top) / b.height) * 2 - 1), 0.5).unproject(camera).sub(camera.position).normalize();
    if (tapRay.z >= -1e-4) return;
    const along = -camera.position.z / tapRay.z;
    const at = camera.position.clone().addScaledVector(tapRay, along);
    at.y = Math.min(Math.max(at.y, 0.5), ROOM.ceiling);
    school.startle(at);
    hooks.onStartle?.();
  };
  host.addEventListener('pointerdown', onTap);

  /* ---------------------------------------------------------------- a frame */
  function draw() {
    // 1. the light's pattern, and where the fish are from above
    renderer.setRenderTarget(lightRT);
    causticPass();
    renderer.setRenderTarget(heightRT);
    renderer.clear(true, false, false);
    renderer.render(maskScene, flat);
    // 2. the chamber
    renderer.setRenderTarget(sceneRT);
    renderer.clear();
    renderer.render(world, camera);
    // 3. the light in the water
    renderer.setRenderTarget(volumeRT);
    volumePass();
    // 4. bloom
    renderer.setRenderTarget(bloomDown[0]);
    brightPass();
    for (let i = 1; i < bloomLevels; i++) {
      down.tex.value = bloomDown[i - 1].texture;
      down.texel.value.set(1 / bloomDown[i - 1].width, 1 / bloomDown[i - 1].height);
      renderer.setRenderTarget(bloomDown[i]);
      downPass();
    }
    let from = bloomDown[bloomLevels - 1];
    for (let i = bloomLevels - 2; i >= 0; i--) {
      up.tex.value = from.texture;
      up.base.value = bloomDown[i].texture;
      up.texel.value.set(1 / from.width, 1 / from.height);
      renderer.setRenderTarget(bloomUp[i]);
      upPass();
      from = bloomUp[i];
    }
    fin.bloom.value = from.texture;
    // 5. out
    renderer.setRenderTarget(null);
    finalPass();
  }

  let raf = 0;
  let before = 0;
  let t = 0;
  let frozen = false;
  let clock = 0;
  function tick(dt) {
    t += dt;
    uTime.value = t;
    clock += dt * (1 + 1.6 * school.fright);
    uClock.value = clock;
    uFright.value = school.fright;
    pointer.sx += (pointer.x - pointer.sx) * (1 - Math.exp(-2 * dt));
    pointer.sy += (pointer.y - pointer.sy) * (1 - Math.exp(-2 * dt));
    aim(t);
    uCam.value.copy(camera.position);
    school.step(renderer, Math.min(dt, 1 / 30), t);
    draw();
  }
  function loop(now) {
    raf = requestAnimationFrame(loop);
    const dt = before ? Math.min((now - before) / 1000, 0.05) : 1 / 60;
    before = now;
    if (!frozen) tick(dt);
  }
  // let the school settle into a shape before anyone sees it
  for (let i = 0; i < 240; i++) school.step(renderer, 1 / 30, i / 30);
  tick(0);
  raf = requestAnimationFrame(loop);

  return {
    debug: {
      renderer,
      backend: renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl',
      camera,
      view,
      school,
      startle: (p) => school.startle(p),
      uniforms: { uTime, uCam, uClock, uFright, uShaft, uBeam: beam.uBeam },
      volume,
      final,
      frame,
      run(seconds, step = 1 / 60) {
        frozen = true;
        for (let s = 0; s < seconds; s += step) tick(step);
      },
      resume() {
        frozen = false;
      },
    },
    dispose() {
      cancelAnimationFrame(raf);
      watcher.disconnect();
      window.removeEventListener('pointermove', onMove);
      host.removeEventListener('pointerdown', onTap);
      for (const o of owned) o.dispose();
      renderer.dispose();
      canvas.remove();
    },
  };
}
