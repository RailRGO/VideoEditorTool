import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'fs';

const BASE = process.env.WEBAPP_URL || 'http://127.0.0.1:8931';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push('jsdomError: ' + (e.detail?.message || e.message)));
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));

const dom = new JSDOM(html, {
  url: BASE + '/',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(window) {
    const base = BASE;
    window.fetch = (url, opts) => globalThis.fetch(
      typeof url === 'string' && url.startsWith('/') ? base + url : url, opts);
    window.URL.createObjectURL = (...a) => globalThis.URL.createObjectURL(...a);
    window.URL.revokeObjectURL = (...a) => globalThis.URL.revokeObjectURL(...a);
    const grad = { addColorStop() {} };
    const ctxStub = () => new Proxy({}, {
      get(t, p) {
        if (p === 'measureText') return () => ({ width: 42 });
        if (p === 'createLinearGradient') return () => grad;
        if (p === 'canvas') return {};
        return () => {};
      },
      set() { return true; },
    });
    window.HTMLCanvasElement.prototype.getContext = function () {
      return this._ctx || (this._ctx = ctxStub());
    };
    Object.defineProperties(window.HTMLVideoElement.prototype, {
      videoWidth: { get() { return 960; } },
      videoHeight: { get() { return 270; } },
    });
    window.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
    window.HTMLMediaElement.prototype.pause = function () {};
    window.Element.prototype.setPointerCapture = function () {};
    window.Element.prototype.getBoundingClientRect = function () {
      return { left: 0, top: 0, width: 800, height: 450, right: 800, bottom: 450, x: 0, y: 0, toJSON() {} };
    };
    Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { get() { return 800; } });
  },
});
const { window } = dom;
const { document } = window;

// controllable media clock (jsdom has no real playback)
const proxy = document.getElementById('proxy');
let _ct = 0;
Object.defineProperty(proxy, 'currentTime', {
  get: () => _ct, set: v => { _ct = v; }, configurable: true,
});
Object.defineProperty(proxy, 'duration', { get: () => 6 });
Object.defineProperty(proxy, 'paused', { get: () => true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const apiState = async () => (await fetch(BASE + '/api/state')).json();
let pass = 0;
const check = (name, cond, extra = '') => {
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));
  if (cond) pass++; else process.exitCode = 1;
};

// 1) boot: badge + tabs + exact still
let badge = '';
for (let i = 0; i < 30 && !badge.includes('fake3840'); i++) {
  await sleep(500);
  badge = document.getElementById('filebadge').textContent;
}
check('badge shows file', badge.includes('fake3840'), badge.slice(0, 80));
const sliders = document.querySelectorAll('#tabbody input[type=range]').length;
check('layout tab built with sliders', sliders > 10, `${sliders} sliders`);
let exSrc = '';
for (let i = 0; i < 20 && !exSrc.startsWith('blob:'); i++) {
  await sleep(500);
  exSrc = document.getElementById('exactimg').src;
}
check('exact still loaded', exSrc.startsWith('blob:'), exSrc.slice(0, 24));
check('no page errors at boot', errors.length === 0, errors.slice(0, 3).join(' / '));

// 2) slider -> server sync (first Width slider = cam w)
const widthSlider = [...document.querySelectorAll('#tabbody .srow')]
  .find(r => r.querySelector('label')?.textContent === 'Width')
  .querySelector('input');
widthSlider.value = '0.45';
widthSlider.dispatchEvent(new window.Event('input', { bubbles: true }));
await sleep(1200);
let st = await apiState();
check('slider syncs layout to server', Math.abs(st.layout.cam.w - 0.45) < 1e-6,
  `cam.w=${st.layout.cam.w}`);

// 3) preset apply
const sel = document.querySelector('#tabbody select');
sel.value = 'hero-circle';
[...document.querySelectorAll('#tabbody button')].find(b => b.textContent === 'Apply').click();
await sleep(1200);
st = await apiState();
check('preset applied', st.layout.contentHidden === true && st.layout.camStyle.shape === 'circle');

// 4) timeline click seeks (clientX=400 of 800px -> t=3.0)
const tl = document.getElementById('timeline');
tl.dispatchEvent(new window.MouseEvent('click', { bubbles: true, clientX: 400 }));
await sleep(300);
check('timeline click seeks', Math.abs(_ct - 3.0) < 0.01, `t=${_ct}`);

// 5) box drag moves camera (50px of 800px stage -> +0.0625 x)
const box = document.getElementById('box-cam');
const before = (await apiState()).layout.cam.x;
const PEVT = (type, x, y) => new window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
box.dispatchEvent(PEVT('pointerdown', 100, 100));
box.dispatchEvent(PEVT('pointermove', 150, 100));
box.dispatchEvent(PEVT('pointerup', 150, 100));
await sleep(1200);
st = await apiState();
check('box drag moves camera', st.layout.cam.x > before + 0.05,
  `x: ${before} -> ${st.layout.cam.x}`);

// 6) cuts tab: claims apply
document.querySelector('#tabs button[data-t="cuts"]').click();
await sleep(300);
const ta = document.querySelector('#tabbody textarea');
ta.value = '00:01 - 00:02 cut test claim';
[...document.querySelectorAll('#tabbody button')].find(b => b.textContent === 'Apply claims').click();
await sleep(1500);
st = await apiState();
check('claims applied to timeline',
  st.claims.length === 1 && st.segments.some(s => s.type === 'cut'),
  `claims=${JSON.stringify(st.claims)} segs=${st.segments.length}`);

// 7) render tab builds + audio tab builds
document.querySelector('#tabs button[data-t="render"]').click();
await sleep(300);
check('render tab builds',
  [...document.querySelectorAll('#tabbody button')].some(b => b.textContent.includes('RENDER FULL')));
document.querySelector('#tabs button[data-t="audio"]').click();
await sleep(300);
check('audio tab builds',
  [...document.querySelectorAll('#tabbody button')].some(b => b.textContent.includes('audio sample')));

check('no page errors overall', errors.length === 0, errors.slice(0, 5).join(' / '));
console.log(`\n${pass} checks passed${process.exitCode ? ' (WITH FAILURES)' : ''}`);
window.close();
