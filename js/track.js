// ══ nomad · trackers ════════════════════════════════════════════════════
// The overlay that drifts across the canvas of work: soft morphing blobs
// wandering the frame, and an autofocus bracket that locks onto whichever
// film is nearest the centre and follows it as the plane moves. On a site
// you are supposedly viewing through a camera's monitor, an AF bracket is
// the honest ornament.
//
// Everything composites with `difference` in ONE neutral grey — the trick
// carried over from the last build. A plain white hairline disappears over
// white paper and a black one disappears over dark footage; a mid grey under
// difference reads the same faint line over paper, over a bright frame and
// over a dark one alike.

const TAU = Math.PI * 2;
const INK = 'rgb(118,118,124)';

export class Trackers {
  constructor(){
    this.t = 0;
    this.lock = null;      // the bracket's current rect, lerped
    this.blobs = [];
    for (let i = 0; i < 7; i++){
      this.blobs.push({
        // they drift a ring around the frame rather than crossing the middle,
        // so they never sit on top of the focus bracket
        rate: 0.021 + i * 0.0031,
        phase: (i / 7) * TAU,
        band: 0.34 + (i % 3) * 0.055,
        breathe: 0.017 + i * 0.0026,
        r: 7 + (i % 3) * 5,
        wob: 0.55 + (i % 4) * 0.13,
        arms: 2 + (i % 3)
      });
    }
  }

  resize(w, h){ this.w = w; this.h = h; }

  /** @param tiles rects of the films currently on screen */
  draw(ctx, dt, tiles){
    this.t += dt;
    const t = this.t / 1000;

    ctx.save();
    ctx.globalCompositeOperation = 'difference';
    ctx.strokeStyle = INK;
    ctx.fillStyle = INK;
    ctx.lineWidth = 1;

    // ── the drifting blobs, and the hairlines between near neighbours
    const pts = [];
    const cx0 = this.w / 2, cy0 = this.h / 2;
    const ring = Math.min(this.w, this.h);
    for (const b of this.blobs){
      const a0 = b.rate * TAU * t + b.phase;
      const rad = ring * (b.band + 0.045 * Math.sin(b.breathe * TAU * t + b.phase));
      const x = cx0 + Math.cos(a0) * rad * (this.w / ring) * 0.92;
      const y = cy0 + Math.sin(a0) * rad;
      pts.push([x, y]);
      ctx.beginPath();
      for (let a = 0; a <= 44; a++){
        const th = a / 44 * TAU;
        // gently unequal radius: an organic blob, not a starburst
        const r = b.r * (1 + 0.13 * Math.sin(b.arms * th + t * b.wob)
                           + 0.06 * Math.sin(2 * b.arms * th - t * 0.41));
        const px = x + Math.cos(th) * r, py = y + Math.sin(th) * r;
        a ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      }
      ctx.closePath();
      ctx.stroke();
    }
    for (let i = 0; i < pts.length; i++){
      for (let j = i + 1; j < pts.length; j++){
        const dx = pts[i][0] - pts[j][0], dy = pts[i][1] - pts[j][1];
        const d = Math.hypot(dx, dy);
        if (d > 320) continue;
        ctx.globalAlpha = 0.55 * (1 - d / 320);
        ctx.beginPath(); ctx.moveTo(pts[i][0], pts[i][1]); ctx.lineTo(pts[j][0], pts[j][1]); ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    // ── autofocus: lock the bracket to the film nearest the centre
    const cx = this.w / 2, cy = this.h / 2;
    let best = null, bestD = Infinity;
    for (const r of tiles){
      const d = Math.hypot(r.x + r.w / 2 - cx, r.y + r.h / 2 - cy);
      if (d < bestD){ bestD = d; best = r; }
    }
    if (best){
      const pad = 10;
      const target = { x: best.x - pad, y: best.y - pad, w: best.w + pad * 2, h: best.h + pad * 2 };
      if (!this.lock) this.lock = { ...target };
      // snap rather than crawl across the plane when the lock changes film
      const jump = Math.hypot(this.lock.x - target.x, this.lock.y - target.y) > best.w * 1.2;
      const k = jump ? 1 : 1 - Math.pow(0.002, dt / 1000);
      for (const key of ['x', 'y', 'w', 'h']) this.lock[key] += (target[key] - this.lock[key]) * k;

      const L = this.lock, arm = Math.min(26, L.w * 0.10);
      const corner = (x, y, sx, sy) => {
        ctx.beginPath();
        ctx.moveTo(x, y + sy * arm); ctx.lineTo(x, y); ctx.lineTo(x + sx * arm, y);
        ctx.stroke();
      };
      corner(L.x,        L.y,        1, 1);
      corner(L.x + L.w,  L.y,       -1, 1);
      corner(L.x,        L.y + L.h,  1, -1);
      corner(L.x + L.w,  L.y + L.h, -1, -1);

      // a small breathing crosshair at the centre of the lock
      const mx = L.x + L.w / 2, my = L.y + L.h / 2;
      const s = 5 + Math.sin(t * 1.6) * 1.4;
      ctx.beginPath();
      ctx.moveTo(mx - s, my); ctx.lineTo(mx + s, my);
      ctx.moveTo(mx, my - s); ctx.lineTo(mx, my + s);
      ctx.stroke();
    }

    ctx.restore();
  }
}
