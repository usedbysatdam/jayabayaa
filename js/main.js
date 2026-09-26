// ══ nomad · orchestration ═══════════════════════════════════════════════
// mark → iPod → (press play) → digicam → the canvas of work → pages.

// scene.js is NOT imported statically. It pulls three.js (1.3 MB) behind it,
// and the lite path never renders a polygon — a static import would make every
// phone on the planet download a renderer it will not use. See LITE below.
import { WorkCanvas } from './canvas.js';

let S = null;                       // the scene module, once asked for
let ipodModel = null, camModel = null;   // in flight from the moment it is

const $ = id => document.getElementById(id);
const body      = document.body;
const markWrap  = $('mark');
const markVideo = $('markVideo');
const glCanvas  = $('gl');
const workWrap  = $('work');
const hint      = $('hint');
const skipBtn   = $('skip');
const theme     = $('theme');
const vig       = $('vig');

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── the lite path ───────────────────────────────────────────────────────
   A touch device gets the mark and then the canvas of work, and nothing in
   between: no three.js, no PMREM, no 3.3 MB of models. Akif's call. The two
   acts are the best thing on the desktop site and the worst thing to ask a
   phone for — two glb loads and an environment bake before a visitor on
   cellular has seen a single film.
   `?full` forces the whole sequence on a phone, for checking it there. */
const LITE = matchMedia('(pointer: coarse)').matches
             && !/[?&]full(&|=|$)/.test(location.search);

/* ── audio ──────────────────────────────────────────────────────────────
   Muted playback is always permitted, so the track is set rolling muted on
   the first frame: it buffers, and the user's gesture only has to unmute.
   goAudible() is single-flight — two overlapping attempts once corrupted the
   saved mute state and left the track silent *and* paused. Never disarm
   except on confirmed success. */
theme.volume = 0;
theme.muted = true;
let audioArmed = false, audioBusy = false, audioOn = false;

function rollMuted(){
  theme.play().catch(() => { /* even muted can be refused; the gesture retries */ });
}
async function goAudible(){
  if (audioOn || audioBusy) return audioOn;
  audioBusy = true;
  try {
    theme.muted = false;
    await theme.play();
    audioOn = true;
    // ease the level up rather than slamming it in
    const t0 = performance.now();
    const ramp = (now) => {
      // rAF hands you the timestamp of the START of the frame, which can
      // predate the performance.now() that scheduled it — an unclamped p goes
      // negative, the cube flips sign, and setting a negative volume throws.
      const p = Math.max(0, Math.min(1, (now - t0) / 1400));
      theme.volume = 0.42 * (1 - Math.pow(1 - p, 3));
      if (p < 1) requestAnimationFrame(ramp);
    };
    requestAnimationFrame(ramp);
  } catch (err) {
    theme.muted = true;
    theme.volume = 0;
    rollMuted();                       // keep buffering, stay armed
  } finally {
    audioBusy = false;
  }
  return audioOn;
}
// a late safety net: if the intro was skipped by an odd path, any first
// gesture still lights the track. Removed only on confirmed success.
function armGlobalGesture(){
  if (audioArmed) return;
  audioArmed = true;
  const go = async () => {
    // the same gesture that lights the track can start a refused mark
    if (!markWrap.hidden && markVideo.paused) markVideo.play().catch(() => {});
    const ok = await goAudible();
    if (ok){
      window.removeEventListener('pointerdown', go);
      window.removeEventListener('keydown', go);
      window.removeEventListener('touchend', go);
    }
  };
  window.addEventListener('pointerdown', go);
  window.addEventListener('keydown', go);
  window.addEventListener('touchend', go);
}

/* ── routing ────────────────────────────────────────────────────────── */
const pages = { about: $('pageAbout'), contact: $('pageContact') };
let lastStage = 'work';

function routeFromHash(){
  const h = (location.hash || '').replace(/^#\/?/, '');
  return (h === 'about' || h === 'contact') ? h : '';
}
async function applyRoute(){
  const r = routeFromHash();
  for (const [name, el] of Object.entries(pages)){
    if (name === r) continue;
    if (!el.hidden){ el.classList.remove('is-lit'); await sleep(reduced ? 0 : 260); el.hidden = true; }
  }
  if (r){
    const el = pages[r];
    el.hidden = false;
    void el.offsetWidth;
    el.classList.add('is-lit');
    body.dataset.stage = 'page';
    el.querySelector('.page__back, .page__cta, h1').focus?.();
  } else if (body.dataset.stage === 'page'){
    body.dataset.stage = lastStage;
  }
}
window.addEventListener('hashchange', applyRoute);
document.querySelectorAll('[data-back]').forEach(b => {
  b.addEventListener('click', () => { history.pushState(null, '', location.pathname + location.search); applyRoute(); });
});
window.addEventListener('popstate', applyRoute);

/* ── the canvas of work ─────────────────────────────────────────────────
   Built and running well before it is seen: the digicam's monitor is
   textured with this very canvas, so what plays on the screen is the page
   itself rather than a preview of it, and the hand-off is not a cut. */
let work = null, workShown = false, workHeld = false;

/* `workHeld` is the lite path's compromise. Downloading the films costs
   bandwidth; PLAYING them costs a hardware decoder, and on a phone the mark is
   already using one. So the canvas is built while the mark is still on screen —
   the eight sources start arriving — but it is not started, and nothing calls
   play() until the mark is gone. Held, it is a shopping list; started, it is a
   competitor. */
function ensureWork(){
  if (work) return work;
  work = new WorkCanvas($('cv'), {
    onRoute: (r) => { location.hash = '#/' + r; },
    onFirstDrag: () => { hint.classList.add('is-gone'); }
  });
  if (!workHeld) work.start();
  /* A phone fires resize for every step of the URL bar sliding away, and each
     one reallocates four canvases. Coalesce to one per frame. */
  let pending = 0;
  const onResize = () => {
    if (pending) return;
    pending = requestAnimationFrame(() => { pending = 0; work.resize(); });
  };
  window.addEventListener('resize', onResize, { passive:true });
  window.addEventListener('orientationchange', onResize, { passive:true });
  if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize, { passive:true });
  return work;
}

function showWork(){
  ensureWork();
  workHeld = false;
  work.start();                      // idempotent; releases a held canvas
  if (workShown) return;
  workShown = true;
  workWrap.hidden = false;
  lastStage = 'work';
  body.dataset.stage = 'work';
  body.classList.remove('is-dark');
  setTimeout(() => hint.classList.add('is-lit'), 500);
  setTimeout(() => hint.classList.add('is-gone'), 7500);
}

/* ── the vignette ───────────────────────────────────────────────────────
   Full through the mark and the iPod, lifting as the frame closes in, gone
   by the time the page is the page. Driven off the acts' own progress, so a
   slow machine never leaves it stranded. */
let vigOff = false;
function dim(v){
  const c = Math.max(0, Math.min(1, v));
  vig.style.opacity = c.toFixed(3);
  const off = c <= 0.002;
  if (off !== vigOff){ vigOff = off; vig.hidden = off; }
}

/* ── the run ────────────────────────────────────────────────────────── */
let gl = null, ipod = null, cam = null, skipped = false;

const vignetteDriver = {
  tick(){
    if (cam)  dim(0.82 * (1 - cam.zoomed));
    else if (ipod) dim(1 - 0.18 * ipod.landed);
  }
};

async function main(){
  armGlobalGesture();
  rollMuted();

  // fonts must be resident before anything paints canvas type
  try {
    await Promise.race([
      Promise.all([
        // VCR sets two words on the iPod's screen and nothing else, so the
        // lite path must never pay for it
        LITE ? Promise.resolve() : document.fonts.load('400 40px "VCR OSD Mono"'),
        document.fonts.load('500 24px "SF Pro Display"'),
        document.fonts.load('400 24px "SF Pro Display"')
      ]),
      sleep(2500)
    ]);
  } catch (e) { /* fall back to the stack in the font-family list */ }

  if (!LITE){
    S = await import('./scene.js');
    gl = new S.GL(glCanvas);
    gl.acts.push(vignetteDriver);
    gl.start();
    // both models start downloading now and are awaited where they are used,
    // so the camera is resident long before anyone presses play
    ipodModel = S.load('./assets/models/ipod.glb');
    camModel  = S.load('./assets/models/camera.glb');
    ipodModel.catch(() => {}); camModel.catch(() => {});
  }

  /* ── the mark ─────────────────────────────────────────────────────────
     Three ways this fails on a phone and none of them are visible on a desk:
     autoplay refused outright (Low Power Mode does this, so does turning off
     Auto-Play Video Previews), the decoder busy with something else, or the
      clip simply never getting a frame out in time. The still covers the look
      of all three — the word fully drawn on black — and the clock below
      covers the wait, so nobody stares at a blank square for five and a half
      seconds because their battery is low. */
  // On the lite path the films start ARRIVING under the mark but must not
  // start PLAYING under it — see workHeld.
  if (LITE){ workHeld = true; setTimeout(ensureWork, 2600); }

  const rollMark = () => markVideo.play().catch(() => {});
  rollMark();
  const markDone = new Promise(res => {
    let fired = false;
    const go = () => { if (!fired){ fired = true; res(); } };
    markVideo.addEventListener('ended', go, { once:true });
    const full = setTimeout(go, reduced ? 900 : 5600);   // never hang on a stall
    // did it actually start? currentTime is the only honest answer — readyState
    // and the play() promise both lie when the decoder is merely busy.
    setTimeout(() => {
      if (markVideo.currentTime > 0.08) return;          // rolling, leave it be
      rollMark();                                        // one more try
      setTimeout(() => {
        if (markVideo.currentTime > 0.08) return;
        clearTimeout(full);
        go();                                            // hold the still, move on
      }, 700);
    }, reduced ? 200 : 1400);
  });
  await markDone;
  if (skipped) return;

  markWrap.classList.add('is-out');
  skipBtn.classList.add('is-lit');
  await sleep(reduced ? 20 : 480);
  markWrap.hidden = true;
  if (skipped) return;

  if (LITE) return lite();

  // ── the iPod
  let model;
  try { model = await ipodModel; }
  catch (e){ console.warn('ipod failed to load', e); return finish(); }
  if (skipped) return;

  ipod = new S.IpodAct(gl, model);
  gl.acts.push(ipod);
  gl.resize();
  body.classList.add('is-dark');
  body.dataset.stage = 'ipod';
  glCanvas.classList.add('is-lit', 'is-live');
  ipod.begin();
  // let the entrance play out before eight films start decoding behind it
  setTimeout(ensureWork, 3000);

  // drag to turn it, exactly as the PSP turned on the last site; a tap on
  // the wheel's play glyph is a press, a drag is not.
  glCanvas.addEventListener('pointerdown', e => {
    if (!ipod) return;
    glCanvas.setPointerCapture(e.pointerId);
    ipod.grabAt(e.clientX, e.clientY);
    glCanvas.classList.add('is-turning');
  });
  glCanvas.addEventListener('pointermove', e => {
    if (!ipod) return;
    if (!ipod.moveTo(e.clientX, e.clientY)){
      glCanvas.classList.toggle('is-hot', ipod.hover(e.clientX, e.clientY));
    }
  });
  const lift = async (e) => {
    if (!ipod) return;
    const travelled = ipod.release();
    glCanvas.classList.remove('is-turning');
    if (travelled > 7) return;                       // that was a turn
    if (!ipod.press(e.clientX, e.clientY)) return;
    glCanvas.classList.remove('is-hot');
    await goAudible();
    toCamera();
  };
  glCanvas.addEventListener('pointerup', lift);
  glCanvas.addEventListener('pointercancel', () => { if (ipod) ipod.release(); glCanvas.classList.remove('is-turning'); });
}

async function toCamera(){
  if (skipped) return;
  const act = ipod;
  ipod = null;
  glCanvas.classList.remove('is-live', 'is-hot');
  await act.fadeOut(reduced ? 60 : 560);
  gl.acts = gl.acts.filter(a => a !== act);
  act.dispose();
  if (skipped) return;

  let model;
  try { model = await camModel; }
  catch (e){ console.warn('camera failed to load', e); return finish(); }
  if (skipped) return;

  body.classList.remove('is-dark');   // back to paper for the digicam

  cam = new S.CameraAct(gl, model, ensureWork().cv, {
    // the plane goes up underneath only once the monitor's edges ARE the
    // viewport's edges; the camera's own fade is then the cross-dissolve
    onReveal: () => { showWork(); skipBtn.classList.remove('is-lit'); },
    onDone: finish
  });
  gl.acts.push(cam);
  gl.resize();
  cam.begin();
}

/* The mark fades, the plane comes up under it, and the vignette — which on
   the full path is driven off the acts' own progress — eases off on its own
   clock, because on this path there is no act to read a progress from. Both
   ends of the ramp are clamped: rAF hands you the timestamp of the START of
   the frame, which can predate the performance.now() that scheduled it, and
   an unclamped p goes negative. */
function lite(){
  glCanvas.hidden = true;
  skipBtn.classList.remove('is-lit');
  showWork();
  const t0 = performance.now(), D = reduced ? 1 : 1000;
  const ease = (now) => {
    const p = Math.max(0, Math.min(1, (now - t0) / D));
    dim(0.82 * (1 - p * p * (3 - 2 * p)));
    if (p < 1) requestAnimationFrame(ease);
  };
  requestAnimationFrame(ease);
  applyRoute();
}

function finish(){
  if (cam){ gl.acts = gl.acts.filter(a => a !== cam); cam.dispose(); cam = null; }
  if (ipod){ gl.acts = gl.acts.filter(a => a !== ipod); ipod.dispose(); ipod = null; }
  if (gl){ gl.stop(); }
  glCanvas.classList.remove('is-lit', 'is-live', 'is-hot');
  glCanvas.hidden = true;
  skipBtn.classList.remove('is-lit');
  body.classList.remove('is-dark');
  dim(0);
  showWork();
  applyRoute();
}

// a handle for the verification harness — inert in normal use
window.__NOMAD = {
  lite: LITE,
  get gl(){ return gl; }, get ipod(){ return ipod; },
  get cam(){ return cam; }, get work(){ return work; },
  /** hold an act at a fixed moment so a frame can be captured deterministically */
  freeze(act, ms){
    const a = act === 'cam' ? cam : ipod;
    if (!a) return false;
    a.freeze = ms; a.running = true;
    if (a.rig) a.rig.visible = true;
    return true;
  },
  seek(act, ms){
    const a = act === 'cam' ? cam : ipod;
    if (!a) return false;
    a.freeze = null;
    a.t0 = performance.now() - ms; a.running = true;
    if (a.rig) a.rig.visible = true;
    return true;
  }
};

skipBtn.addEventListener('click', async () => {
  if (skipped) return;
  skipped = true;
  markWrap.classList.add('is-out');
  markWrap.hidden = true;
  await goAudible();
  finish();
});

applyRoute();
main();
