import { createScene } from './scene.js';

const scene = createScene(document.getElementById('stage'), {
  onFail: () => (document.getElementById('fail').hidden = false),
});

if (import.meta.env.DEV && scene) {
  window.__lw = scene.debug;
  // ref(opacity): lay a still of the reference over the picture, its height fitted to the window,
  // to line the scene up against it. ref(0) takes it away.
  window.ref = (opacity = 0.5) => {
    let img = document.getElementById('ref');
    if (!opacity) return img?.remove();
    if (!img) {
      img = document.createElement('img');
      img.id = 'ref';
      img.src = '/_ref/frame.jpg';
      img.style.cssText = 'position:fixed;top:0;left:50%;height:100%;translate:-50% 0;pointer-events:none;z-index:5';
      document.body.append(img);
    }
    img.style.opacity = opacity;
  };
}
