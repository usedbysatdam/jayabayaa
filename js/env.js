// ══ nomad · the rooms ═══════════════════════════════════════════════════
// Procedural floating-point studios, run through PMREM. Two of them:
//
//   STUDIO — white cyclorama with black flags either side. The digicam lives
//            here. What makes metal read as metal is not brightness, it is
//            CONTRAST in what it reflects: flag the sides, drop the floor to
//            near-black, and the same model that looked like white plastic
//            renders as a photographed camera.
//
//   RIM    — a black room with two grazing strips. The iPod lives here,
//            against a black page, lit only along its edges.
//
// Floating point on purpose: an LDR canvas caps the light boxes at 1.0 and
// gives no highlight worth the name.

import * as THREE from 'three';

export const STUDIO = {
  base:   0.26,   // cyclorama brightness
  floor:  0.012,  // how dark the ground is
  gobo:   0.78,   // black flags either side — the metal-maker
  strip:  3.70,   // overhead softbox, long front-to-back, narrow across
  window: 1.38,   // the photographer's own window, behind the camera:
                  // a face pointing at the lens mirrors THIS, not the strip
  lobes: [        // [x, y, z, tightness, power]
    [-0.55, 0.70, 0.45, 80, 11.0]
  ]
};

/* The black room. Everything here is deliberately tiny.
   PMREM blurs a light lobe far wider than its own solid angle, so a lobe
   bright enough to *be* an edge light lands on the flat front of the device
   as well and turns a black iPod silver — which is exactly what happened.
   The room only has to be dark and slightly directional; the edges are lit
   by the two grazing DirectionalLights in `GL.look('rim')`, where the falloff
   is governed by the surface normal and stays where it is put. */
export const RIM = {
  base:   0.012,
  floor:  0.003,
  gobo:   0.00,   // the room is already dark; nothing to flag
  strip:  0.22,
  window: 0.09,   // a whisper, so the face is not perfectly dead
  lobes: [        // faint grazing strips — shape, not illumination
    [-0.93,  0.26, -0.26, 40, 1.60],
    [ 0.90,  0.30, -0.32, 44, 1.10],
    [ 0.05,  0.97,  0.22, 60, 0.50]
  ]
};

export function studioEnvironment(renderer, o = STUDIO){
  const W = 256, H = 128, d = new Float32Array(W * H * 4);
  let i = 0;
  for (let y = 0; y < H; y++){
    const th = (y + 0.5) / H * Math.PI, st = Math.sin(th), ct = Math.cos(th);
    for (let x = 0; x < W; x++){
      const ph = (x + 0.5) / W * Math.PI * 2;
      const dx = st * Math.sin(ph), dy = ct, dz = st * Math.cos(ph);

      /* The gradient scales WITH `base`, it does not merely start from it.
         Written the other way round, a "dark" room still had a ceiling at
         0.56 and the iPod's front — which mirrors the room, not the lamps —
         came out silver instead of black. */
      let v = ct > 0 ? o.base * (1 + 1.60 * ct)
                     : Math.max(o.floor, o.base * (0.40 + 1.30 * ct));
      if (o.gobo > 0){
        const side = Math.abs(dx);
        v *= 1 - o.gobo * Math.max(0, (side - 0.35) / 0.65);
      }
      v = Math.max(o.floor, v);

      const up = Math.max(0, dy);
      v += o.strip * Math.pow(up, 3) * Math.exp(-Math.pow(dx / 0.30, 2));

      const w = Math.max(0, dx * 0.28 + dy * 0.28 + dz * 0.92);
      v += o.window * Math.pow(w, 5);

      for (const [lx, ly, lz, tight, power] of o.lobes){
        const l = dx * lx + dy * ly + dz * lz;
        if (l > 0) v += power * Math.pow(l, tight);
      }

      d[i++] = v;
      d[i++] = v * (0.997 + 0.006 * ct);
      d[i++] = v * (0.998 - 0.010 * ct);
      d[i++] = 1;
    }
  }
  const tex = new THREE.DataTexture(d, W, H, THREE.RGBAFormat, THREE.FloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.needsUpdate = true;
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const env = pmrem.fromEquirectangular(tex).texture;
  tex.dispose(); pmrem.dispose();
  return env;
}

/** A soft cast shadow sprite: offset and blurred, never a zero-offset halo. */
export function shadowSprite(){
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(128, 128, 8, 128, 128, 126);
  g.addColorStop(0.00, 'rgba(17,16,20,0.30)');
  g.addColorStop(0.45, 'rgba(17,16,20,0.16)');
  g.addColorStop(1.00, 'rgba(17,16,20,0)');
  x.fillStyle = g; x.fillRect(0, 0, 256, 256);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map:new THREE.CanvasTexture(c), transparent:true,
      depthWrite:false, opacity:0, toneMapped:false }));
  m.renderOrder = -1;
  return m;
}
