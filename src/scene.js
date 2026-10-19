// The scene and its frame loop.
//
// Each frame:
//   1. the caustic pattern of the light, and a top-down map of how high the fish are   (small)
//   2. the chamber and the fish, in HDR                                                 -> scene
//   3. the light in the water, marched through the column at half size                -> volume
//   4. bloom, then grading to the screen
import * as THREE from 'three';
import { CAUSTIC_FRAG } from './gl/light.js';
import { WORLD_VERT, FLOOR_FRAG, ROOM_FRAG } from './gl/room.js';
import { FISH_VERT, FISH_FRAG, MASK_VERT, MASK_FRAG } from './gl/fish.js';
import { QUAD_VERT, VOLUME_FRAG, BRIGHT_FRAG, DOWN_FRAG, UP_FRAG, FINAL_FRAG } from './gl/passes.js';
import { fishGeometry, School } from './school.js';

// the room, in metres
export const ROOM = {
  ceiling: 8.2, // floor to ceiling
  half: 1.55, // half the side of the square hole (and of the column of light)
  shaft: 1.0, // how deep the hole is, up to the water
  turn: THREE.MathUtils.degToRad(41), // the hole is turned this far about the vertical
};

export function createScene(host, { onFail } = {}) {
  const canvas = document.createElement('canvas');
  canvas.className = 'stage';
  host.appendChild(canvas);
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
  } catch {
    canvas.remove();
    onFail?.();
    return null;
  }
  if (!renderer.extensions.has('EXT_color_buffer_float') && !renderer.extensions.has('EXT_color_buffer_half_float')) {
    renderer.dispose();
    canvas.remove();
    onFail?.();
    return null;
  }
  const coarse = matchMedia('(pointer: coarse)').matches;
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, coarse ? 1.5 : 2));
  renderer.autoClear = false;
  renderer.setClearColor(0x000000, 1);

  const owned = [];
  const keep = (x) => (owned.push(x), x);
  const half = (w, h) => [Math.max(1, Math.round(w / 2)), Math.max(1, Math.round(h / 2))];

  /* ---------------------------------------------------------------- targets */
  const sceneRT = keep(new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4, depthBuffer: true }));
  sceneRT.depthTexture = new THREE.DepthTexture(1, 1);
  sceneRT.depthTexture.type = THREE.UnsignedIntType;
  const volumeRT = keep(new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false }));
  const lightRT = keep(new THREE.WebGLRenderTarget(384, 384, { type: THREE.HalfFloatType, depthBuffer: false }));
  const heightRT = keep(new THREE.WebGLRenderTarget(256, 256, { type: THREE.HalfFloatType, depthBuffer: false }));
  const bloomLevels = 4;
  const bloomDown = Array.from({ length: bloomLevels }, () => keep(new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false })));
  const bloomUp = Array.from({ length: bloomLevels }, () => keep(new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false })));

  /* ---------------------------------------------------------------- shared uniforms */
  const beam = new THREE.Vector4(ROOM.half, Math.cos(ROOM.turn), Math.sin(ROOM.turn), ROOM.ceiling);
  const shared = {
    uBeam: { value: beam },
    uLight: { value: lightRT.texture },
    uHeights: { value: heightRT.texture },
    uTime: { value: 0 },
    uCam: { value: new THREE.Vector3() },
  };

  const camera = new THREE.PerspectiveCamera(60, 9 / 16, 0.1, 80);
  const flat = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = keep(new THREE.PlaneGeometry(2, 2));
  const pass = (frag, uniforms, extra = {}) => {
    const material = keep(new THREE.ShaderMaterial({ uniforms, vertexShader: QUAD_VERT, fragmentShader: frag, depthTest: false, depthWrite: false, ...extra }));
    const scene = new THREE.Scene();
    const mesh = new THREE.Mesh(quad, material);
    mesh.frustumCulled = false;
    scene.add(mesh);
    return { scene, u: material.uniforms };
  };

  /* ---------------------------------------------------------------- the chamber */
  const world = new THREE.Scene();
  const material = (frag, uniforms = {}, extra = {}) => keep(new THREE.ShaderMaterial({ uniforms: { ...shared, ...uniforms }, vertexShader: WORLD_VERT, fragmentShader: frag, ...extra }));

  const floor = new THREE.Mesh(keep(new THREE.PlaneGeometry(60, 60).rotateX(-Math.PI / 2)), material(FLOOR_FRAG));
  world.add(floor);

  // the ceiling, with a square hole turned the way the light is
  const corners = (h) => [[h, h], [-h, h], [-h, -h], [h, -h]].map(([u, v]) => new THREE.Vector2(u * Math.cos(ROOM.turn) - v * Math.sin(ROOM.turn), u * Math.sin(ROOM.turn) + v * Math.cos(ROOM.turn)));
  const slab = new THREE.Shape([new THREE.Vector2(-30, -30), new THREE.Vector2(30, -30), new THREE.Vector2(30, 30), new THREE.Vector2(-30, 30)]);
  slab.holes.push(new THREE.Path(corners(ROOM.half).reverse()));
  // a Shape lies in xy; turned to lie flat facing down, its y becomes z, just as the corners have it
  const ceilingGeo = keep(new THREE.ShapeGeometry(slab).rotateX(Math.PI / 2));
  ceilingGeo.translate(0, ROOM.ceiling, 0);
  const ceiling = new THREE.Mesh(ceilingGeo, material(ROOM_FRAG, { uPart: { value: 0 }, uShaft: { value: ROOM.shaft } }, { side: THREE.DoubleSide }));
  world.add(ceiling);

  // the walls, far off in the dark: every ray then ends on something, and the fog has an end
  const wallGeo = keep(new THREE.PlaneGeometry(28, ROOM.ceiling));
  for (let i = 0; i < 4; i++) {
    const wall = new THREE.Mesh(wallGeo, material(ROOM_FRAG, { uPart: { value: 0 }, uShaft: { value: ROOM.shaft } }));
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
  world.add(new THREE.Mesh(shaftGeo, material(ROOM_FRAG, { uPart: { value: 1 }, uShaft: { value: ROOM.shaft } }, { side: THREE.DoubleSide })));
  const waterGeo = keep(new THREE.PlaneGeometry(ROOM.half * 2, ROOM.half * 2).rotateX(Math.PI / 2).rotateY(-ROOM.turn));
  waterGeo.translate(0, ROOM.ceiling + ROOM.shaft, 0);
  world.add(new THREE.Mesh(waterGeo, material(ROOM_FRAG, { uPart: { value: 2 }, uShaft: { value: ROOM.shaft } }, { side: THREE.DoubleSide })));

  /* ---------------------------------------------------------------- the fish */
  const school = new School({ half: ROOM.half, turn: ROOM.turn, low: 3.2, high: 7.2 });
  const fishGeo = keep(fishGeometry());
  school.looks(fishGeo);
  const fishMat = keep(new THREE.ShaderMaterial({ uniforms: shared, vertexShader: FISH_VERT, fragmentShader: FISH_FRAG, side: THREE.DoubleSide }));
  const fish = new THREE.InstancedMesh(fishGeo, fishMat, school.fish.length);
  fish.frustumCulled = false;
  world.add(fish);

  // the same fish, drawn from above into the height map
  const maskMat = keep(
    new THREE.ShaderMaterial({
      uniforms: shared,
      vertexShader: MASK_VERT,
      fragmentShader: MASK_FRAG,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.MaxEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    })
  );
  const maskScene = new THREE.Scene();
  const maskFish = new THREE.InstancedMesh(fishGeo, maskMat, school.fish.length);
  maskFish.instanceMatrix = fish.instanceMatrix; // the very same matrices
  maskFish.frustumCulled = false;
  maskScene.add(maskFish);

  /* ---------------------------------------------------------------- passes */
  const causticPass = pass(CAUSTIC_FRAG, { uTime: shared.uTime, uHalf: { value: ROOM.half } });
  const volumePass = pass(VOLUME_FRAG, {
    ...shared,
    uDepth: { value: sceneRT.depthTexture },
    uProjInv: { value: camera.projectionMatrixInverse },
    uViewInv: { value: camera.matrixWorld },
    uSteps: { value: coarse ? 24 : 40 },
    uShaft: { value: ROOM.shaft },
    uHalo: { value: 1 },
    uDebug: { value: 0 },
  });
  const brightPass = pass(BRIGHT_FRAG, { uScene: { value: sceneRT.texture }, uVolume: { value: volumeRT.texture } });
  const downPass = pass(DOWN_FRAG, { uTex: { value: null }, uTexel: { value: new THREE.Vector2() } });
  const upPass = pass(UP_FRAG, { uTex: { value: null }, uBase: { value: null }, uTexel: { value: new THREE.Vector2() } });
  const finalPass = pass(FINAL_FRAG, {
    uScene: { value: sceneRT.texture },
    uVolume: { value: volumeRT.texture },
    uBloom: { value: bloomUp[0].texture },
    uTime: shared.uTime,
    uAspect: { value: new THREE.Vector2(1, 1) },
    uExposure: { value: 1.0 },
    uBloomAmt: { value: 0.28 },
  });

  /* ---------------------------------------------------------------- framing */
  // The picture is composed for a tall screen: the hole near the top, the lit floor along the
  // bottom. On a wider screen the same height is kept and the dark simply goes on to the sides; on
  // a narrower one the lens widens until the column fits across.
  const view = { look: new THREE.Vector3(0, 4.55, 0), from: new THREE.Vector3(0.35, 2.6, 9.6), fovTall: 71 };
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
    finalPass.u.uAspect.value.set(w / Math.max(w, h), h / Math.max(w, h));
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

  /* ---------------------------------------------------------------- a frame */
  function draw() {
    // 1. the light's pattern, and where the fish are from above
    renderer.setRenderTarget(lightRT);
    renderer.render(causticPass.scene, flat);
    renderer.setRenderTarget(heightRT);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    renderer.render(maskScene, flat);
    // 2. the chamber
    renderer.setRenderTarget(sceneRT);
    renderer.clear();
    renderer.render(world, camera);
    // 3. the light in the water
    renderer.setRenderTarget(volumeRT);
    renderer.render(volumePass.scene, flat);
    // 4. bloom
    renderer.setRenderTarget(bloomDown[0]);
    renderer.render(brightPass.scene, flat);
    for (let i = 1; i < bloomLevels; i++) {
      downPass.u.uTex.value = bloomDown[i - 1].texture;
      downPass.u.uTexel.value.set(1 / bloomDown[i - 1].width, 1 / bloomDown[i - 1].height);
      renderer.setRenderTarget(bloomDown[i]);
      renderer.render(downPass.scene, flat);
    }
    let from = bloomDown[bloomLevels - 1];
    for (let i = bloomLevels - 2; i >= 0; i--) {
      upPass.u.uTex.value = from.texture;
      upPass.u.uBase.value = bloomDown[i].texture;
      upPass.u.uTexel.value.set(1 / from.width, 1 / from.height);
      renderer.setRenderTarget(bloomUp[i]);
      renderer.render(upPass.scene, flat);
      from = bloomUp[i];
    }
    finalPass.u.uBloom.value = from.texture;
    // 5. out
    renderer.setRenderTarget(null);
    renderer.render(finalPass.scene, flat);
  }

  let raf = 0;
  let before = 0;
  let t = 0;
  let frozen = false;
  function tick(dt) {
    t += dt;
    shared.uTime.value = t;
    pointer.sx += (pointer.x - pointer.sx) * (1 - Math.exp(-2 * dt));
    pointer.sy += (pointer.y - pointer.sy) * (1 - Math.exp(-2 * dt));
    aim(t);
    shared.uCam.value.copy(camera.position);
    school.step(Math.min(dt, 1 / 30), t);
    school.write(fish);
    draw();
  }
  function loop(now) {
    raf = requestAnimationFrame(loop);
    const dt = before ? Math.min((now - before) / 1000, 0.05) : 1 / 60;
    before = now;
    if (!frozen) tick(dt);
  }
  // let the school settle into a shape before anyone sees it
  for (let i = 0; i < 240; i++) school.step(1 / 30, i / 30);
  tick(0);
  raf = requestAnimationFrame(loop);

  return {
    debug: {
      renderer,
      camera,
      view,
      school,
      shared,
      volume: volumePass.u,
      final: finalPass.u,
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
      for (const o of owned) o.dispose();
      renderer.dispose();
      canvas.remove();
    },
  };
}
