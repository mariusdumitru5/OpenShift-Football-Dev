// Renderer isometrico del rigore (Canvas 2D, nessuna dipendenza).
//
// Coordinate del mondo in metri:
//   x = lungo la linea di porta (negativo = sinistra vista dal tiratore)
//   y = profondità (0 = linea di porta, 11 = dischetto)
//   z = altezza
// Proiezione isometrica: sx = (x - y)·cos30, sy = (x + y)·sin30 - z

const C30 = Math.cos(Math.PI / 6);
const S30 = 0.5;
const GOAL_HALF = 3.66;
const BAR = 2.44;
const NET_DEPTH = 1.8;
const SPOT_Y = 11;
const KEEPER_Y = 0.35;

// Punto della porta in cui arriva il pallone per ciascuna direzione
export const TARGETS = {
  TL: { x: -2.9, z: 1.95 },
  TR: { x: 2.9, z: 1.95 },
  C: { x: 0, z: 1.15 },
  BL: { x: -2.9, z: 0.35 },
  BR: { x: 2.9, z: 0.35 },
};

const KITS = {
  blue: { shirt: "#2457d6", shorts: "#f5f7f0", socks: "#2457d6", keeper: "#8fb6ff" },
  orange: { shirt: "#f08a00", shorts: "#13261a", socks: "#f08a00", keeper: "#ffd27a" },
};
const INK = "#13261a";
const CHALK = "#f5f7f0";
const SKIN = "#e0b48a";

const clamp01 = (t) => Math.max(0, Math.min(1, t));
const lerp = (a, b, t) => a + (b - a) * t;
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

export class PitchRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.shooterKit = KITS.blue;
    this.keeperKit = KITS.orange;
    this.anim = null;
    this.resize();
    window.addEventListener("resize", () => this.resize());
    requestAnimationFrame((t) => this.frame(t));
  }

  // --- API pubblica ---------------------------------------------------------
  setRoles(shooterColor, keeperColor) {
    this.shooterKit = KITS[shooterColor] || KITS.blue;
    this.keeperKit = KITS[keeperColor] || KITS.orange;
    this.anim = null;
  }

  /** Anima un rigore. Restituisce una Promise risolta a fine animazione. */
  play({ shot, dive, goal }) {
    return new Promise((resolve) => {
      this.anim = { start: performance.now(), shot, dive, goal, resolve, done: false };
    });
  }

  // --- Geometria ------------------------------------------------------------
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.W = window.innerWidth;
    this.H = window.innerHeight;
    this.canvas.width = Math.round(this.W * dpr);
    this.canvas.height = Math.round(this.H * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Scala: tutto il necessario (porta + dischetto + rincorsa) deve stare a schermo
    this.s = Math.min(this.W / 17, this.H / 16);
    this.ox = this.W / 2 + 3.5 * C30 * this.s;
    this.oy = this.H / 2 - 1.0 * this.s;
  }

  P(x, y, z = 0) {
    return {
      x: this.ox + (x - y) * C30 * this.s,
      y: this.oy + (x + y) * S30 * this.s - z * this.s,
    };
  }

  path(points, close = false) {
    const ctx = this.ctx;
    ctx.beginPath();
    points.forEach(([x, y, z], i) => {
      const p = this.P(x, y, z || 0);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    if (close) ctx.closePath();
  }

  // --- Ciclo di disegno -----------------------------------------------------
  frame(now) {
    const st = this.computeState(now);
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.W, this.H);
    this.drawField();
    this.drawNet(st.ripple, st.rippleAt);
    if (st.ball.y < 0.05) this.drawBall(st.ball);
    this.drawFrame();
    this.drawShadow(st.keeper.x, KEEPER_Y, 0.55);
    this.drawFigure({ x: st.keeper.x, y: KEEPER_Y, z: st.keeper.z }, {
      kit: this.keeperKit, keeper: true, angle: st.keeper.angle, armsUp: st.keeper.armsUp,
    });
    if (st.ball.y >= 0.05) this.drawBall(st.ball);
    this.drawShadow(st.shooter.x, st.shooter.y, 0.5);
    this.drawFigure({ x: st.shooter.x, y: st.shooter.y, z: 0 }, {
      kit: this.shooterKit, runPhase: st.shooter.phase, kick: st.shooter.kick,
    });
    requestAnimationFrame((t) => this.frame(t));
  }

  computeState(now) {
    const idleSway = Math.sin(now / 600) * 0.25;
    const st = {
      ball: { x: 0, y: SPOT_Y, z: 0.11 },
      shooter: { x: 1.0, y: 13.4, phase: 0, kick: 0 },
      keeper: { x: idleSway, z: 0, angle: 0, armsUp: 0.35 },
      ripple: 0,
      rippleAt: null,
    };
    const a = this.anim;
    if (!a) return st;

    const t = (now - a.start) / 1000;
    const T = TARGETS[a.shot] || TARGETS.C;
    const D = TARGETS[a.dive] || TARGETS.C;

    // Rincorsa del tiratore
    const tr = clamp01(t / 0.7);
    st.shooter.x = lerp(1.0, 0.35, tr);
    st.shooter.y = lerp(13.4, 11.45, tr);
    st.shooter.phase = tr < 1 ? t * 18 : 0;
    st.shooter.kick = t > 0.66 && t < 1.0 ? 1 : 0;

    // Volo del pallone
    const tb = clamp01((t - 0.72) / 0.5);
    const end = a.goal
      ? { x: T.x, y: -0.5, z: T.z }
      : { x: T.x * 0.92, y: KEEPER_Y + 0.15, z: T.z };
    const arc = T.z > 1 ? 0.35 : 0.55;
    st.ball = {
      x: lerp(0, end.x, tb),
      y: lerp(SPOT_Y, end.y, tb),
      z: lerp(0.11, end.z, tb) + Math.sin(Math.PI * tb) * arc,
    };
    if (t > 1.22) {
      if (a.goal) {
        const tg = clamp01((t - 1.22) / 0.5);
        st.ball = { x: end.x, y: lerp(end.y, -1.4, easeOut(tg)), z: Math.max(0.11, end.z * (1 - tg * tg)) };
        st.ripple = Math.exp(-(t - 1.22) * 3.5);
        st.rippleAt = T;
      } else {
        const tq = clamp01((t - 1.22) / 0.8);
        const rx = T.x === 0 ? 1.6 : T.x * 0.35;
        st.ball = {
          x: lerp(end.x, rx, tq),
          y: lerp(end.y, 4.5, tq),
          z: lerp(end.z, 0.11, tq) + Math.abs(Math.sin(Math.PI * tq * 2)) * 0.7 * (1 - tq),
        };
      }
    }

    // Tuffo del portiere
    const td = easeOut(clamp01((t - 0.78) / 0.42));
    const isCenter = D.x === 0;
    const baseX = D.x * 0.5;
    const baseZ = isCenter ? D.z * 0.5 : D.z * 0.4;
    st.keeper.x = lerp(idleSway, baseX, td);
    st.keeper.z = baseZ * td;
    st.keeper.armsUp = lerp(0.35, 1, td);
    if (!isCenter) {
      const from = this.P(baseX, KEEPER_Y, baseZ);
      // tuffo alto: mani verso l'incrocio; tuffo basso: corpo quasi steso sul prato
      const to = this.P(D.x, KEEPER_Y, D.z > 1 ? D.z + 0.1 : 0.12);
      st.keeper.angle = Math.atan2(to.x - from.x, -(to.y - from.y)) * td;
    }
    // ricaduta a terra
    const fall = clamp01((t - 1.45) / 0.35);
    st.keeper.z *= 1 - fall;

    if (t > 2.3 && !a.done) {
      a.done = true;
      a.resolve();
    }
    return st;
  }

  // --- Elementi -------------------------------------------------------------
  drawField() {
    const ctx = this.ctx;
    ctx.fillStyle = "#1d5531";
    ctx.fillRect(0, 0, this.W, this.H);
    for (let y = -40; y < 50; y += 2) {
      ctx.fillStyle = (Math.floor(y / 2) & 1) ? "#2e7d46" : "#348c4f";
      this.path([[-80, y], [80, y], [80, y + 2], [-80, y + 2]], true);
      ctx.fill();
    }
    ctx.strokeStyle = "rgba(245,247,240,.9)";
    ctx.lineWidth = Math.max(1.5, this.s * 0.07);
    ctx.lineJoin = "round";
    this.path([[-80, 0], [80, 0]]); ctx.stroke();
    this.path([[-9.16, 0], [-9.16, 5.5], [9.16, 5.5], [9.16, 0]]); ctx.stroke();
    this.path([[-20.16, 0], [-20.16, 16.5], [20.16, 16.5], [20.16, 0]]); ctx.stroke();
    // lunetta
    const arc = [];
    for (let th = 0.645; th <= 2.497; th += 0.05) arc.push([9.15 * Math.cos(th), SPOT_Y + 9.15 * Math.sin(th)]);
    this.path(arc); ctx.stroke();
    // dischetto
    const spot = [];
    for (let th = 0; th < Math.PI * 2; th += 0.4) spot.push([0.16 * Math.cos(th), SPOT_Y + 0.16 * Math.sin(th)]);
    ctx.fillStyle = CHALK;
    this.path(spot, true); ctx.fill();
  }

  netBack(x, z, ripple, at) {
    let y = -NET_DEPTH;
    if (ripple && at) {
      const d2 = (x - at.x) ** 2 + (z - at.z) ** 2;
      y -= ripple * 0.6 * Math.exp(-d2 / 1.2);
    }
    return [x, y, z * 0.92];
  }

  drawNet(ripple, at) {
    const ctx = this.ctx;
    const step = 0.4;
    ctx.fillStyle = "rgba(245,247,240,.08)";
    this.path([[-GOAL_HALF, -NET_DEPTH], [GOAL_HALF, -NET_DEPTH], [GOAL_HALF, -NET_DEPTH, BAR * 0.92], [-GOAL_HALF, -NET_DEPTH, BAR * 0.92]], true);
    ctx.fill();
    ctx.strokeStyle = "rgba(245,247,240,.38)";
    ctx.lineWidth = 1;
    // telo di fondo
    for (let x = -GOAL_HALF; x <= GOAL_HALF + 0.01; x += step) {
      const pts = [];
      for (let z = 0; z <= BAR + 0.01; z += step / 2) pts.push(this.netBack(x, z, ripple, at));
      this.path(pts); ctx.stroke();
    }
    for (let z = 0; z <= BAR + 0.01; z += step) {
      const pts = [];
      for (let x = -GOAL_HALF; x <= GOAL_HALF + 0.01; x += step / 2) pts.push(this.netBack(x, z, ripple, at));
      this.path(pts); ctx.stroke();
    }
    // teli laterali e tetto
    for (const side of [-GOAL_HALF, GOAL_HALF]) {
      for (let y = 0; y >= -NET_DEPTH - 0.01; y -= step) {
        const k = -y / NET_DEPTH;
        this.path([[side, y, 0], [side, y, BAR * (1 - 0.08 * k)]]); ctx.stroke();
      }
      for (let z = step; z <= BAR; z += step) {
        this.path([[side, 0, z], [side, -NET_DEPTH, z * 0.92]]); ctx.stroke();
      }
    }
    for (let x = -GOAL_HALF; x <= GOAL_HALF + 0.01; x += step) {
      this.path([[x, 0, BAR], this.netBack(x, BAR, ripple, at)]); ctx.stroke();
    }
  }

  drawFrame() {
    const ctx = this.ctx;
    const frame = [[-GOAL_HALF, 0, 0], [-GOAL_HALF, 0, BAR], [GOAL_HALF, 0, BAR], [GOAL_HALF, 0, 0]];
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = INK;
    ctx.lineWidth = Math.max(4, this.s * 0.17);
    this.path(frame); ctx.stroke();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = Math.max(2.5, this.s * 0.11);
    this.path(frame); ctx.stroke();
  }

  drawShadow(x, y, r) {
    const p = this.P(x, y, 0);
    const ctx = this.ctx;
    ctx.fillStyle = "rgba(10,30,15,.28)";
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, r * this.s, r * this.s * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  drawBall(b) {
    const ctx = this.ctx;
    const g = this.P(b.x, b.y, 0);
    ctx.fillStyle = "rgba(10,30,15,.3)";
    ctx.beginPath();
    ctx.ellipse(g.x, g.y, this.s * 0.16, this.s * 0.08, 0, 0, Math.PI * 2);
    ctx.fill();
    const p = this.P(b.x, b.y, b.z);
    const r = Math.max(4, this.s * 0.17);
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = INK;
    ctx.lineWidth = Math.max(1.5, r * 0.25);
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = INK;
    ctx.beginPath(); ctx.arc(p.x - r * 0.2, p.y - r * 0.15, r * 0.35, 0, Math.PI * 2); ctx.fill();
  }

  drawFigure(base, { kit, keeper = false, angle = 0, armsUp = 0, runPhase = 0, kick = 0 }) {
    const ctx = this.ctx;
    const u = this.s;
    const p = this.P(base.x, base.y, base.z);
    const outline = Math.max(1.2, u * 0.04);
    const shirt = keeper ? kit.keeper : kit.shirt;

    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(angle);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    const limb = (x1, y1, x2, y2, color, w) => {
      ctx.strokeStyle = INK; ctx.lineWidth = w + outline * 2;
      ctx.beginPath(); ctx.moveTo(x1 * u, y1 * u); ctx.lineTo(x2 * u, y2 * u); ctx.stroke();
      ctx.strokeStyle = color; ctx.lineWidth = w;
      ctx.beginPath(); ctx.moveTo(x1 * u, y1 * u); ctx.lineTo(x2 * u, y2 * u); ctx.stroke();
    };

    // gambe
    const swing = Math.sin(runPhase) * 0.22;
    limb(-0.09, -0.85, -0.09 + swing, -0.02, kit.socks, u * 0.14);
    limb(0.09, -0.85, 0.09 - swing - kick * 0.35, -0.02 - kick * 0.25, kit.socks, u * 0.14);

    // braccia
    const shoulderY = -1.42;
    if (keeper) {
      const reachY = lerp(-1.05, -2.05, armsUp);
      const reachX = lerp(0.42, 0.24, armsUp);
      limb(-0.18, shoulderY, -reachX, reachY, shirt, u * 0.12);
      limb(0.18, shoulderY, reachX, reachY, shirt, u * 0.12);
      for (const sx of [-reachX, reachX]) {
        ctx.fillStyle = "#ffffff"; ctx.strokeStyle = INK; ctx.lineWidth = outline;
        ctx.beginPath(); ctx.arc(sx * u, reachY * u, u * 0.09, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
    } else {
      limb(-0.18, shoulderY, -0.3 - swing, -1.0, shirt, u * 0.11);
      limb(0.18, shoulderY, 0.3 + swing, -1.0, shirt, u * 0.11);
    }

    // pantaloncini e maglia
    ctx.strokeStyle = INK; ctx.lineWidth = outline;
    ctx.fillStyle = kit.shorts;
    ctx.beginPath(); ctx.roundRect(-0.2 * u, -1.02 * u, 0.4 * u, 0.24 * u, 0.04 * u); ctx.fill(); ctx.stroke();
    ctx.fillStyle = shirt;
    ctx.beginPath(); ctx.roundRect(-0.22 * u, -1.52 * u, 0.44 * u, 0.54 * u, 0.08 * u); ctx.fill(); ctx.stroke();

    // testa
    ctx.fillStyle = SKIN;
    ctx.beginPath(); ctx.arc(0, -1.7 * u, 0.15 * u, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.restore();
  }
}
