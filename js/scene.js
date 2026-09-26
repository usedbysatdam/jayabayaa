// ══ nomad · webgl ═══════════════════════════════════════════════════════
// One renderer, one transparent canvas, two acts:
//   act 1  the iPod pops out, lands dead centre with zero tilt, screen wakes
//   act 2  the digicam faces you, turns to its monitor, and the frame closes
//          in until the monitor's edges are the viewport's edges
//
// Deliberately no post-processing. UnrealBloomPass hard-codes alpha 1.0 in
// its blur shader, which makes a transparent canvas impossible — that cost a
// session on the last build. Nothing here needs it.

import * as THREE from 'three';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import { studioEnvironment, shadowSprite, STUDIO, RIM } from './env.js';

/* ── measured off the models, once, offline ──────────────────────────────
   iPod (raw model space): front face is +X, up is +Y.
     screen active area   y 7.00 … 11.38   z −3.126 … 2.884   plane x 0.7316
     play/pause glyph     y 1.273          z −0.240
   Digicam (scene space, node transforms applied — the raw buffers are in a
   different frame, which is what made the first pass show the base plate):
     lens is +Z, monitor is −Z, up is +Y
     monitor quad (material 07_display)  z −0.365  x −0.908…1.332  y −0.866…0.937
   The monitor ships with a stock photograph baked into its texture; it is
   replaced at runtime, never shown.
   ─────────────────────────────────────────────────────────────────────── */
const IPOD = {
  face: 0.7316,
  screen: { y0: 7.00, y1: 11.38, z0: -3.126, z1: 2.884 },
  play:   { y: 1.273, z: -0.240, r: 0.92 }
};
const CAM = {
  display: { z: -0.365, x0: -0.908, x1: 1.332, y0: -0.866, y1: 0.937 },
  // the quad runs a little under the bezel, so close in slightly past an
  // exact cover or the bezel shows along the edges
  overshoot: 1.10
};

const FOV = 34;
const DEG = Math.PI / 180;

/* ── easing ─────────────────────────────────────────────────────────────
   Exponential out only. Never bounce, never elastic — real objects
   decelerate, they do not wobble. */
const clamp01 = t => t < 0 ? 0 : t > 1 ? 1 : t;
const expoOut = t => (t >= 1) ? 1 : 1 - Math.pow(2, -10 * t);
const inOut   = t => t < .5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2;
const lerp    = (a, b, t) => a + (b - a) * t;
const clamp   = (v, a, b) => v < a ? a : v > b ? b : v;

/* A real cubic-bézier so the entrance can be authored the way it would be in
   a timeline, not left to 1−2^−10t — which resolves 83% of the move in the
   first quarter of its duration and reads as a snap, not a landing. */
function bez(x1, y1, x2, y2){
  const cx = 3*x1, bx = 3*(x2-x1) - cx, ax = 1 - cx - bx;
  const cy = 3*y1, by = 3*(y2-y1) - cy, ay = 1 - cy - by;
  const fx = t => ((ax*t + bx)*t + cx)*t;
  const dx = t => (3*ax*t + 2*bx)*t + cx;
  const fy = t => ((ay*t + by)*t + cy)*t;
  return (x) => {
    if (x <= 0) return 0; if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++){
      const e = fx(t) - x, d = dx(t);
      if (Math.abs(e) < 1e-6 || d === 0) break;
      t = clamp01(t - e / d);
    }
    return fy(t);
  };
}
const POP   = bez(0.22, 0.86, 0.28, 1.00);   // emerges quickly, settles
const GLIDE = bez(0.40, 0.02, 0.05, 1.00);   // eases in, long tail into place

/* ── shared renderer ─────────────────────────────────────────────────── */
export class GL {
  constructor(canvas){
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias:true, alpha:true, powerPreference:'high-performance'
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 400);
    this.camera.position.set(0, 0, 24);

    // reflections do the work; the lamps only shape what the room leaves flat
    this.rooms = {
      studio: studioEnvironment(this.renderer, STUDIO),
      rim:    studioEnvironment(this.renderer, RIM)
    };
    this.hemi = new THREE.HemisphereLight(0xffffff, 0xe6e6ea, 0.32);
    this.key  = new THREE.DirectionalLight(0xffffff, 1.25); this.key.position.set(-5, 7, 6);
    this.rim  = new THREE.DirectionalLight(0xffffff, 0.42); this.rim.position.set(6, 2, -5);
    this.fil  = new THREE.DirectionalLight(0xffffff, 0.22); this.fil.position.set(2, -4, 7);
    // the two edge lights: grazing, from behind, so a black object on a black
    // page is separated from it by its own outline
    this.edgeL = new THREE.DirectionalLight(0xffffff, 0); this.edgeL.position.set(-11, 3, -5);
    this.edgeR = new THREE.DirectionalLight(0xffffff, 0); this.edgeR.position.set( 11, 4, -6);
    this.scene.add(this.hemi, this.key, this.rim, this.fil, this.edgeL, this.edgeR);
    this.look('studio');

    this.acts = [];
    this._raf = 0;
    this._t0 = 0;
    this.paused = false;

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize, { passive:true });
    this.resize();
  }

  /** 'rim' — black room, edge-lit, for the iPod against a black page.
      'studio' — flagged white cyclorama, for the digicam against paper. */
  look(name){
    if (this._look === name) return;
    this._look = name;
    const rim = name === 'rim';
    this.scene.environment = rim ? this.rooms.rim : this.rooms.studio;
    this.hemi.intensity  = rim ? 0.05 : 0.32;
    this.key.intensity   = rim ? 0.34 : 1.25;
    this.rim.intensity   = rim ? 0.12 : 0.42;
    this.fil.intensity   = rim ? 0.04 : 0.22;
    this.edgeL.intensity = rim ? 5.20 : 0;
    this.edgeR.intensity = rim ? 4.50 : 0;
    this.renderer.toneMappingExposure = rim ? 1.14 : 1.0;
  }

  resize(){
    const w = window.innerWidth, h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.acts.forEach(a => a.resize && a.resize(w, h));
  }

  start(){
    if (this._raf) return;
    this._t0 = performance.now();
    const loop = (now) => {
      this._raf = requestAnimationFrame(loop);
      const t = now - this._t0;
      for (const a of this.acts) a.tick && a.tick(t, now);
      this.renderer.render(this.scene, this.camera);
    };
    this._raf = requestAnimationFrame(loop);
  }
  stop(){ cancelAnimationFrame(this._raf); this._raf = 0; }

  /** Distance at which a world-space box of the given size sits inside the
      frame at `fill` of the smaller viewport axis (contain), or covers it. */
  distanceFor(w, h, fill = 1, mode = 'contain'){
    const vFov = FOV * DEG;
    const aspect = this.camera.aspect;
    const need = (visH) => visH / (2 * Math.tan(vFov / 2));
    if (mode === 'cover'){
      return need(Math.min(h, w / aspect));
    }
    const byH = h / fill;
    const byW = (w / fill) / aspect;
    return need(Math.max(byH, byW));
  }
}

/* ── loader ─────────────────────────────────────────────────────────── */
const loader = new GLTFLoader();
export function load(url){
  return new Promise((res, rej) => loader.load(url, g => res(g.scene), undefined, rej));
}

/* ── act one · the iPod ─────────────────────────────────────────────── */
export class IpodAct {
  constructor(gl, model){
    this.gl = gl;
    this.done = false;
    this.onPlay = null;
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

    // screen — a self-lit plane sitting a hair proud of the glass
    const cw = 512, ch = Math.round(cw * (IPOD.screen.y1 - IPOD.screen.y0) /
                                        (IPOD.screen.z1 - IPOD.screen.z0));
    const c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    this.screenCtx = c.getContext('2d');
    this.screenTex = new THREE.CanvasTexture(c);
    this.screenTex.colorSpace = THREE.SRGBColorSpace;
    this.screenTex.anisotropy = 4;

    const sw = IPOD.screen.z1 - IPOD.screen.z0;
    const sh = IPOD.screen.y1 - IPOD.screen.y0;
    this.screen = new THREE.Mesh(
      new THREE.PlaneGeometry(sw, sh),
      new THREE.MeshBasicMaterial({ map:this.screenTex, transparent:true, toneMapped:false })
    );
    this.screen.rotation.y = Math.PI / 2;                 // face +X
    this.screen.position.set(IPOD.face + 0.012,
                             (IPOD.screen.y0 + IPOD.screen.y1) / 2,
                             (IPOD.screen.z0 + IPOD.screen.z1) / 2);
    model.add(this.screen);

    // invisible hit target over the play/pause glyph
    this.hit = new THREE.Mesh(
      new THREE.CircleGeometry(IPOD.play.r, 24),
      new THREE.MeshBasicMaterial({ colorWrite:false, depthWrite:false, transparent:true, opacity:0 })
    );
    this.hit.rotation.y = Math.PI / 2;
    this.hit.position.set(IPOD.face + 0.02, IPOD.play.y, IPOD.play.z);
    model.add(this.hit);

    // normalise: pivot on the body centre, front (+X) toward the camera
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const mid  = box.getCenter(new THREE.Vector3());
    this.scale = 10 / Math.max(size.x, size.y, size.z);

    this.inner = new THREE.Group();
    this.inner.add(model);
    model.position.set(-mid.x, -mid.y, -mid.z);

    this.fit = new THREE.Group();
    this.fit.rotation.y = -Math.PI / 2;                   // model +X → world +Z
    this.fit.scale.setScalar(this.scale);
    this.fit.add(this.inner);

    this.rig = new THREE.Group();
    this.rig.add(this.fit);
    this.rig.visible = false;
    gl.scene.add(this.rig);

    /* The shell ships as `metalness: 1` over a near-black base colour. A black
       metal reflects almost nothing — which is precisely why it read as a
       matte cut-out. A real iPod front is lacquered black plastic: a dielectric
       with a polished coat over it. So the shell becomes a physical material
       with clearcoat, and the metal is dialled back far enough that the room's
       soft boxes land as specular streaks instead of being swallowed. */
    model.traverse(o => {
      if (!o.isMesh || !o.material || !o.material.isMeshStandardMaterial) return;
      const m = o.material;
      const pm = new THREE.MeshPhysicalMaterial({
        map: m.map, normalMap: m.normalMap, normalScale: m.normalScale,
        aoMap: m.aoMap, aoMapIntensity: 1.0,
        roughnessMap: m.roughnessMap, metalnessMap: m.metalnessMap,
        // the model's own albedo, untouched. The dark tint this once carried
        // was compensating for a bright cyclorama; under the flagged room it
        // crushes the click wheel into an unreadable black slab.
        color: m.color, side: m.side, transparent: m.transparent,
        roughness: 0.26, metalness: 0.22,
        clearcoat: 1.0, clearcoatRoughness: 0.065,
        envMapIntensity: 1.15
      });
      pm.name = m.name;
      o.material = pm;
      m.dispose();
    });


    this.worldH = size.y * this.scale;
    this.worldW = size.z * this.scale;

    this.ray = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.hot = false;
    this.armed = false;
    this.landed = 0;
    this.t0 = 0;
    this.freeze = null;          // verification harness only
    // drag-to-turn, exactly as the PSP on the last site: the body follows the
    // pointer and springs back to dead-front. Exponential decay, not a spring
    // with overshoot — a resting tilt is forbidden here.
    this.spin = { x: 0, y: 0 };
    this.grab = null;
    this._last = 0;
    this.paintScreen(0, 0);
  }

  resize(){
    const fill = window.innerWidth < 640 ? 0.82 : 0.72;
    this.dist = this.gl.distanceFor(this.worldW, this.worldH, fill);
  }

  begin(){
    this.rig.visible = true;
    this.gl.look('rim');
    this.t0 = this._last = performance.now();
    this.running = true;
  }

  /* ── drag ──────────────────────────────────────────────────────────── */
  grabAt(x, y){ this.grab = { x, y, moved: 0 }; }
  moveTo(x, y){
    if (!this.grab) return false;
    const dx = x - this.grab.x, dy = y - this.grab.y;
    this.grab.x = x; this.grab.y = y;
    this.grab.moved += Math.abs(dx) + Math.abs(dy);
    this.spin.y = clamp(this.spin.y + dx * 0.0062, -1.15, 1.15);
    this.spin.x = clamp(this.spin.x + dy * 0.0050, -0.62, 0.62);
    return true;
  }
  /** @returns how far the pointer travelled — a tap is a press, a drag is not */
  release(){ const m = this.grab ? this.grab.moved : 1e9; this.grab = null; return m; }

  /* the pop-out: three overlapping keyframe tracks, rotation resolving
     first so the body settles into a dead-square face before it stops
     growing. Lands on exactly zero — no residual tilt, ever. */
  tick(_, now){
    if (!this.running) return;
    const e = this.freeze != null ? this.freeze : now - this.t0;
    const D = this.reduced ? 0.28 : 1;
    // three overlapping tracks: it pops out of nothing, glides forward, and
    // the rotation is the last thing to resolve — so the body is already the
    // right size when it squares up, which is what reads as "landing".
    const pScl = POP  (clamp01((e - 0)   / (1500 * D)));
    const pPos = GLIDE(clamp01((e - 60)  / (2200 * D)));
    const pRot = GLIDE(clamp01((e - 0)   / (2400 * D)));

    // the spin the viewer has added, decaying back to dead-front
    const dt = Math.min(64, now - this._last); this._last = now;
    if (!this.grab){
      const k = Math.pow(0.050, dt / 1000);
      this.spin.x *= k; this.spin.y *= k;
      if (Math.abs(this.spin.x) < 1e-4) this.spin.x = 0;
      if (Math.abs(this.spin.y) < 1e-4) this.spin.y = 0;
    }

    this.rig.position.set(0, lerp(-2.4, 0, pPos), lerp(-9.5, 0, pPos));
    this.rig.rotation.set(lerp(0.38, 0, pRot) + this.spin.x,
                          lerp(-2.75, 0, pRot) + this.spin.y,
                          lerp(-0.20, 0, pRot));
    const s = lerp(0.14, 1, pScl);
    this.rig.scale.setScalar(s);
    this.landed = Math.min(pScl, pPos);      // read by the vignette
    this.gl.camera.position.set(0, 0, this.dist);
    this.gl.camera.lookAt(0, 0, 0);

    if (pRot === 1 && pScl === 1 && pPos === 1){
      this.rig.rotation.set(this.spin.x, this.spin.y, 0);
      this.rig.scale.setScalar(1);
      this.rig.position.set(0, 0, 0);
    }

    // screen wakes once the body has all but landed
    const wake = clamp01((e - 2050 * D) / (560 * D));
    const type = clamp01((e - 2620 * D) / (460 * D));
    if (wake !== this._wake || type !== this._type){
      this._wake = wake; this._type = type;
      this.paintScreen(inOut(wake), expoOut(type));
      if (type >= 1 && !this.armed){ this.armed = true; }
    }
  }

  paintScreen(lit, txt){
    const ctx = this.screenCtx, w = ctx.canvas.width, h = ctx.canvas.height;
    ctx.clearRect(0, 0, w, h);
    // backlight ramps from a cold dead panel to paper white
    const bg = Math.round(lerp(10, 246, lit));
    ctx.fillStyle = `rgb(${bg},${bg},${Math.round(bg * 0.99 + 2)})`;
    ctx.fillRect(0, 0, w, h);
    if (lit > 0.02){
      const g = ctx.createRadialGradient(w/2, h/2, h*0.1, w/2, h/2, h*0.78);
      g.addColorStop(0, `rgba(255,255,255,${0.30 * lit})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    }
    if (txt > 0){
      ctx.globalAlpha = txt;
      ctx.fillStyle = '#111014';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const px = Math.round(h * 0.125);
      ctx.font = `${px}px "VCR OSD Mono", monospace`;
      ctx.fillText('press play', w / 2, h / 2);
      ctx.globalAlpha = 1;
    }
    this.screenTex.needsUpdate = true;
  }

  /** returns true when the pointer is over the play button */
  hover(x, y){
    if (!this.armed) return false;
    this.pointer.set((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
    this.ray.setFromCamera(this.pointer, this.gl.camera);
    this.hot = this.ray.intersectObject(this.hit, false).length > 0;
    return this.hot;
  }

  press(x, y){
    if (!this.armed) return false;
    if (!this.hover(x, y)) return false;
    this.paintScreen(1, 1);
    return true;
  }

  fadeOut(ms = 520){
    return new Promise(res => {
      const t0 = performance.now(), s0 = this.rig.scale.x;
      const step = (now) => {
        const p = clamp01((now - t0) / ms), e = inOut(p);
        this.rig.scale.setScalar(lerp(s0, s0 * 0.86, e));
        this.rig.position.z = lerp(0, -5.5, e);
        this.rig.traverse(o => {
          if (o.material && o.material.transparent !== undefined){
            o.material.transparent = true;
            o.material.opacity = 1 - e;
          }
        });
        if (p < 1) requestAnimationFrame(step);
        else { this.rig.visible = false; res(); }
      };
      requestAnimationFrame(step);
    });
  }

  dispose(){ this.gl.scene.remove(this.rig); }
}

/* ── act two · the digicam ──────────────────────────────────────────── */
export class CameraAct {
  constructor(gl, model, sourceCanvas, hooks = {}){
    this.gl = gl;
    this.src = sourceCanvas || null;
    this.onReveal = hooks.onReveal || (() => {});   // plane goes up behind
    this.onDone   = hooks.onDone   || (() => {});   // camera is gone
    this._revealed = false; this._done = false;
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const mid  = box.getCenter(new THREE.Vector3());
    this.scale = 10 / Math.max(size.x, size.y, size.z);

    // The lens already faces +Z at identity, so there is no base rotation:
    // the act starts square-on to the lens and turns 180° to the monitor.
    this.model = model;
    this.inner = new THREE.Group(); this.inner.add(model);
    this.fit = new THREE.Group();
    this.fit.scale.setScalar(this.scale);
    this.fit.add(this.inner);
    this.rig = new THREE.Group();
    this.rig.add(this.fit);
    this.rig.visible = false;
    gl.scene.add(this.rig);

    this.bodyPivot = mid.clone();
    this.dispPivot = new THREE.Vector3(
      (CAM.display.x0 + CAM.display.x1) / 2,
      (CAM.display.y0 + CAM.display.y1) / 2,
      CAM.display.z
    );
    this.inner.position.copy(this.bodyPivot).multiplyScalar(-1);

    this.dispW = (CAM.display.x1 - CAM.display.x0) * this.scale;
    this.dispH = (CAM.display.y1 - CAM.display.y0) * this.scale;
    this.bodyW = size.x * this.scale;
    this.bodyH = size.y * this.scale;

    /* ── the monitor. Whatever the model shipped with is discarded, and what
       goes on it is the live canvas of work itself — not a preview of it. The
       page you are about to be handed is already running on the screen, so
       when the body dissolves there is nothing to cut to: the pixels are
       already the same pixels. */
    this.mtex = this.src ? new THREE.CanvasTexture(this.src) : null;
    if (this.mtex){
      this.mtex.colorSpace = THREE.SRGBColorSpace;
      this.mtex.wrapS = this.mtex.wrapT = THREE.ClampToEdgeWrapping;
      this.mtex.generateMipmaps = false;
      this.mtex.minFilter = THREE.LinearFilter;
    }

    this._mats = [];
    model.traverse(o => {
      if (!o.isMesh) return;
      const name = o.material && o.material.name || '';
      /* Silver metal has no diffuse worth the name — all of it is reflection.
         Tinting it grey and roughening it, which is what this used to do, is
         what made it read as a cartoon: it flattened every surface to one
         value. The fix belongs in the room (black flags), not in the material.
         Here we only sharpen: a crisper surface catches the flags harder. */
      if (o.material && o.material.isMeshStandardMaterial){
        o.material = o.material.clone();
        o.material.envMapIntensity = 1.15;
        o.material.roughness = Math.min(1, (o.material.roughness ?? 0.5) * 0.50);
      }
      if (name === '07_display'){
        this.panel = new THREE.MeshBasicMaterial({
          map: this.mtex, color: 0x000000, toneMapped: false, transparent: true });
        o.material = this.panel;
      } else if (name === '07_glass_NONE' || name === '07_glass'){
        // the sheen sheet sits between the viewer and the panel; keep it,
        // but never let it veil the picture
        o.material = o.material.clone();
        o.material.transparent = true;
        o.material.opacity = 0.10;
        o.material.depthWrite = false;
      }
      this._mats.push(o.material);
    });

    this.shadow = shadowSprite();
    this.shadow.scale.set(this.bodyW * 1.9, this.bodyH * 2.1, 1);
    this.shadow.position.set(this.bodyW * 0.07, -this.bodyH * 0.16, -3.6);
    this.shadow.visible = false;
    gl.scene.add(this.shadow);

    this.opacity = 0;
    this.zoomed = 0;
    this.freeze = null;          // verification harness only
    this.resize();
  }

  resize(){
    const fill = window.innerWidth < 640 ? 0.86 : 0.60;
    this.dFar  = this.gl.distanceFor(this.bodyW, this.bodyH, fill);
    this.dNear = this.gl.distanceFor(this.dispW, this.dispH, 1, 'cover') / CAM.overshoot;

    /* Map the page onto the panel so that at full zoom the part of the panel
       still on screen is EXACTLY the whole page, pixel for pixel — otherwise
       the hand-off is a visible jump in scale. Two mappings, lerped by the
       zoom: aspect-correct cover while the camera is still whole, and the
       exact one by the time the panel is the viewport. */
    const aspect = this.gl.camera.aspect;
    const visH = 2 * this.dNear * Math.tan(FOV * DEG / 2);
    const visW = visH * aspect;
    const fx = Math.min(1, visW / this.dispW), fy = Math.min(1, visH / this.dispH);
    this.uvEnd = { rx: 1 / fx, ry: 1 / fy,
                   ox: -(1 - fx) / (2 * fx), oy: -(1 - fy) / (2 * fy) };

    const Aq = this.dispW / this.dispH;
    let rx = 1, ry = 1;
    if (aspect > Aq) rx = Aq / aspect; else ry = aspect / Aq;
    this.uvStart = { rx, ry, ox: (1 - rx) / 2, oy: (1 - ry) / 2 };
  }

  /** total run time of the act, ms */
  get duration(){ return this.reduced ? 900 : 5400; }

  begin(){
    this.rig.visible = true;
    this.shadow.visible = true;
    this.gl.look('studio');
    this.t0 = performance.now();
    this.running = true;
    this._mats.forEach(m => { m.transparent = true; m._o0 = (m.opacity === undefined ? 1 : m.opacity); m.opacity = 0; });
  }

  tick(_, now){
    if (!this.running) return;
    const e = this.freeze != null ? this.freeze : now - this.t0;
    const R = this.reduced;

    const pIn   = clamp01(e / (R ? 120 : 460));
    const pTurn = inOut(clamp01((e - (R ? 120 : 820)) / (R ? 200 : 1560)));
    const pWake = clamp01((e - (R ? 200 : 1900)) / (R ? 200 : 700));
    const pZoom = inOut(clamp01((e - (R ? 320 : 2620)) / (R ? 300 : 1980)));
    const pOut  = clamp01((e - (R ? 620 : 4620)) / (R ? 200 : 640));

    // lens at the viewer, then turned right around to the monitor
    this.rig.rotation.y = lerp(0, Math.PI, pTurn);
    // a whisper of settle on the other axis so it reads as handled by someone,
    // not motorised — resolves to exactly zero
    this.rig.rotation.x = lerp(-0.09, 0, inOut(clamp01((e - 820) / 2200)));

    // the pivot slides from the body's centre to the monitor's centre, so the
    // monitor is dead centre by the time the frame closes in on it
    const p = this.bodyPivot.clone().lerp(this.dispPivot, pTurn);
    this.inner.position.copy(p).multiplyScalar(-1);

    this.zoomed = pZoom;                     // read by the vignette
    const d = lerp(this.dFar, this.dNear, pZoom);
    this.gl.camera.position.set(0, 0, d);
    this.gl.camera.lookAt(0, 0, 0);

    this.paintPanel(inOut(pWake), pZoom);

    // the shadow retires as the frame closes in — by then the monitor is the
    // whole viewport and there is no paper left to cast onto
    this.shadow.material.opacity = 0.8 * Math.min(pIn, 1 - pOut) * (1 - pZoom);

    const o = Math.min(pIn, 1 - pOut);
    if (o !== this.opacity){
      this.opacity = o;
      this._mats.forEach(m => { m.opacity = (m._o0 === undefined ? 1 : m._o0) * o; });
    }
    // the hand-off rides the act's own progress, never a wall clock: on a
    // slow machine a setTimeout fires while the camera is still turning.
    if (pZoom > 0.99 && !this._revealed){ this._revealed = true; this.onReveal(); }
    if (pOut >= 1 && !this._done){
      this._done = true; this.running = false;
      this.rig.visible = false; this.shadow.visible = false; this.onDone();
    }
  }

  /** The panel wakes from dead black to the page itself. `color` on a basic
      material multiplies the map, so it doubles as the backlight ramp. */
  paintPanel(lit, zoom){
    if (!this.panel) return;
    this.panel.color.setScalar(lit);
    if (!this.mtex) return;
    const a = this.uvStart, b = this.uvEnd, t = zoom;
    this.mtex.repeat.set(lerp(a.rx, b.rx, t), lerp(a.ry, b.ry, t));
    this.mtex.offset.set(lerp(a.ox, b.ox, t), lerp(a.oy, b.oy, t));
    if (lit > 0.01) this.mtex.needsUpdate = true;   // the page is live
  }

  dispose(){ this.gl.scene.remove(this.rig); this.gl.scene.remove(this.shadow); }
}
