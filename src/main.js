import { createScene } from './scene.js';

// ?gl=1 forces the WebGL 2 backend; ?fish=3 draws three times the school
const query = new URLSearchParams(location.search);
const fish = Math.min(Math.max(Number(query.get('fish')) || 1, 0.25), 20);

createScene(document.getElementById('stage'), {
  forceWebGL: query.get('gl') === '1',
  fish,
  onFail: () => (document.getElementById('fail').hidden = false),
  onStartle: () => document.getElementById('hint').classList.add('gone'),
}).then((scene) => {
  if (!(import.meta.env.DEV && scene)) return;
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
});
