/* Soccer Head — canvas renderer.
 *
 * Draws a floodlit stadium (sky, stands, crowd, pitch, goals + nets) once to a
 * cached offscreen canvas, then paints the dynamic layer (big-head characters,
 * ball, shadows, particles) every frame on top. World units are 1200x600; the
 * canvas is fit to its container with letterboxing at device-pixel resolution.
 */
(function () {
  'use strict';

  const SKIN = ['#f2c69b', '#d99a6c', '#a56a43', '#8a5a3b', '#f7d9b8'];

  function lerp(a, b, t) { return a + (b - a) * t; }

  class Renderer {
    constructor(canvas, world) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.world = world;
      this.f = world.field;
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.scale = 1; this.offX = 0; this.offY = 0;
      this.bg = null;
      this.particles = [];
      this.time = 0;
      this._buildBackground();
      this.resize();
    }

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      const cw = Math.max(1, Math.round(rect.width * this.dpr));
      const ch = Math.max(1, Math.round(rect.height * this.dpr));
      if (this.canvas.width !== cw) this.canvas.width = cw;
      if (this.canvas.height !== ch) this.canvas.height = ch;
      const s = Math.min(cw / this.f.W, ch / this.f.H);
      this.scale = s;
      this.offX = (cw - this.f.W * s) / 2;
      this.offY = (ch - this.f.H * s) / 2;
    }

    // ---------------- Static background (built once) ----------------
    _buildBackground() {
      const f = this.f;
      const c = document.createElement('canvas');
      c.width = f.W; c.height = f.H;
      const g = c.getContext('2d');

      // Sky / arena gradient.
      const sky = g.createLinearGradient(0, 0, 0, f.GROUND_Y);
      sky.addColorStop(0, '#0b2c47');
      sky.addColorStop(1, '#12496f');
      g.fillStyle = sky;
      g.fillRect(0, 0, f.W, f.GROUND_Y);

      // Floodlights glow (top corners).
      for (const lx of [f.W * 0.18, f.W * 0.82]) {
        const gl = g.createRadialGradient(lx, 6, 4, lx, 6, 220);
        gl.addColorStop(0, 'rgba(255,255,240,0.35)');
        gl.addColorStop(1, 'rgba(255,255,240,0)');
        g.fillStyle = gl;
        g.fillRect(lx - 240, 0, 480, 260);
      }

      // Stands with a crowd speckle.
      const standsTop = 40, standsBottom = 150;
      const st = g.createLinearGradient(0, standsTop, 0, standsBottom);
      st.addColorStop(0, '#0a1f31');
      st.addColorStop(1, '#153a58');
      g.fillStyle = st;
      g.fillRect(0, standsTop, f.W, standsBottom - standsTop);
      const crowdCols = ['#e6e6e6', '#f2c14e', '#e2544c', '#4a90d9', '#8bd07f', '#d98cc6', '#f0f0f0'];
      for (let i = 0; i < 1400; i++) {
        const x = Math.random() * f.W;
        const y = standsTop + 6 + Math.random() * (standsBottom - standsTop - 12);
        g.fillStyle = crowdCols[(Math.random() * crowdCols.length) | 0];
        g.globalAlpha = 0.5 + Math.random() * 0.5;
        g.beginPath();
        g.arc(x, y, 2.1, 0, Math.PI * 2);
        g.fill();
      }
      g.globalAlpha = 1;
      // Advertising boards.
      g.fillStyle = '#0c2135';
      g.fillRect(0, standsBottom, f.W, 26);
      g.fillStyle = 'rgba(255,255,255,0.06)';
      for (let x = 0; x < f.W; x += 140) g.fillRect(x + 8, standsBottom + 6, 124, 14);

      // Pitch with mowed stripes.
      const stripes = 12;
      for (let i = 0; i < stripes; i++) {
        g.fillStyle = i % 2 === 0 ? '#2f8d50' : '#2a8149';
        g.fillRect((f.W / stripes) * i, f.GROUND_Y, f.W / stripes + 1, f.H - f.GROUND_Y);
      }
      // Subtle grass sheen.
      const grassSheen = g.createLinearGradient(0, f.GROUND_Y, 0, f.H);
      grassSheen.addColorStop(0, 'rgba(255,255,255,0.10)');
      grassSheen.addColorStop(1, 'rgba(0,0,0,0.10)');
      g.fillStyle = grassSheen;
      g.fillRect(0, f.GROUND_Y, f.W, f.H - f.GROUND_Y);

      // Pitch line + centre mark on the ground surface.
      g.strokeStyle = 'rgba(255,255,255,0.55)';
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(f.W / 2, f.GROUND_Y);
      g.lineTo(f.W / 2, f.H);
      g.stroke();
      // Centre spot.
      g.fillStyle = 'rgba(255,255,255,0.5)';
      g.beginPath(); g.arc(f.W / 2, f.GROUND_Y + (f.H - f.GROUND_Y) * 0.5, 4, 0, Math.PI * 2); g.fill();
      // Goal-area lines near each net so the pitch reads as a real field.
      g.strokeStyle = 'rgba(255,255,255,0.4)';
      g.lineWidth = 2.5;
      for (const gx of [f.GOAL_DEPTH + 120, f.W - f.GOAL_DEPTH - 120]) {
        g.beginPath(); g.moveTo(gx, f.GROUND_Y); g.lineTo(gx, f.H); g.stroke();
      }

      // Goals (frame + net) drawn into the background.
      this._drawGoal(g, 'left');
      this._drawGoal(g, 'right');

      this.bg = c;
    }

    _drawGoal(g, side) {
      const f = this.f;
      const left = side === 'left';
      const x0 = left ? 0 : f.W - f.GOAL_DEPTH;
      const x1 = left ? f.GOAL_DEPTH : f.W;
      const top = f.TOP_Y;
      const bot = f.GROUND_Y;

      // Net mesh.
      g.save();
      g.beginPath();
      g.rect(x0, top, x1 - x0, bot - top);
      g.clip();
      g.strokeStyle = 'rgba(255,255,255,0.28)';
      g.lineWidth = 1;
      for (let x = x0; x <= x1; x += 12) {
        g.beginPath(); g.moveTo(x, top); g.lineTo(x, bot); g.stroke();
      }
      for (let y = top; y <= bot; y += 12) {
        g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke();
      }
      g.fillStyle = 'rgba(0,0,0,0.16)';
      g.fillRect(x0, top, x1 - x0, bot - top);
      g.restore();

      // Frame: crossbar + front post + back post.
      g.strokeStyle = '#f4f7fb';
      g.lineWidth = 9;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(x0, top);
      g.lineTo(x1, top);            // crossbar
      g.stroke();
      // Front post (the one facing the field).
      const frontX = left ? x1 : x0;
      g.beginPath();
      g.moveTo(frontX, top);
      g.lineTo(frontX, bot);
      g.stroke();
    }

    // ---------------- Particles ----------------
    spawnBurst(x, y, color, n, speed) {
      n = n || 10;
      speed = speed || 260;
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = speed * (0.4 + Math.random() * 0.8);
        this.particles.push({
          x, y,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp - 120,
          life: 0, maxLife: 0.5 + Math.random() * 0.5,
          size: 3 + Math.random() * 4,
          color,
        });
      }
    }
    spawnKick(x, y) { this.spawnBurst(x, y, '#ffffff', 7, 200); }
    spawnGoal(x, y, color) {
      this.spawnBurst(x, y, color, 34, 420);
      this.spawnBurst(x, y, '#ffffff', 20, 320);
    }
    _updateParticles(dt) {
      const ps = this.particles;
      for (let i = ps.length - 1; i >= 0; i--) {
        const p = ps[i];
        p.life += dt;
        if (p.life >= p.maxLife) { ps.splice(i, 1); continue; }
        p.vy += 900 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
      }
    }

    // ---------------- Frame ----------------
    render(dt) {
      this.time += dt;
      this._updateParticles(dt);
      const ctx = this.ctx;
      const f = this.f;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      // Letterbox background.
      ctx.fillStyle = '#06182a';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.setTransform(this.scale, 0, 0, this.scale, this.offX, this.offY);

      ctx.drawImage(this.bg, 0, 0);

      // Soft vignette for depth (darkens the field edges, not the players).
      const vg = ctx.createRadialGradient(f.W / 2, f.GROUND_Y * 0.62, f.H * 0.18, f.W / 2, f.GROUND_Y * 0.62, f.W * 0.6);
      vg.addColorStop(0, 'rgba(0,0,0,0)');
      vg.addColorStop(1, 'rgba(0,0,0,0.26)');
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, f.W, f.H);

      // Shadows first.
      for (const p of this.world.players) this._drawShadow(ctx, p.x, f.GROUND_Y, p.y);
      this._drawBallShadow(ctx, this.world.ball);

      // Characters (draw far players first for slight depth).
      const ordered = this.world.players.slice().sort((a, b) => a.seat - b.seat);
      for (const p of ordered) this._drawPlayer(ctx, p);

      // Ball.
      this._drawBall(ctx, this.world.ball);

      // Front net overlay so the ball/players sit "inside" the goal.
      this._drawNetFront(ctx, 'left');
      this._drawNetFront(ctx, 'right');

      // Particles.
      for (const p of this.particles) {
        ctx.globalAlpha = Math.max(0, 1 - p.life / p.maxLife);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      // Goal-celebration emote bubbles, on top of everything so they read
      // clearly. Purely cosmetic — driven by p.emote set on the host.
      const nowMs = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      for (const p of this.world.players) this._drawEmote(ctx, p, nowMs);
    }

    _drawEmote(ctx, p, nowMs) {
      const em = p.emote;
      if (!em) return;
      const remain = em.until - nowMs;
      if (remain <= 0) { p.emote = null; return; }
      const f = this.f;
      // Fade out over the last 300ms; gentle pop-in over the first 140ms.
      const FADE = 300;
      let alpha = 1;
      if (remain < FADE) alpha = remain / FADE;
      const age = nowMs - (em.born || nowMs);
      const pop = age < 140 ? 0.6 + 0.4 * (age / 140) : 1;

      const hy = p.y - 110;           // head centre (HEAD_CY)
      const HEAD_R = 40;
      const r = 33;                   // bubble radius
      const mouthX = p.x + p.facing * 7, mouthY = hy + 21;
      // Sit beside the head at mouth height (clear of the nametag above),
      // pushed out a bit so the bubble doesn't crowd the face; clamp inside
      // the field so it never runs off the pitch.
      let bx = p.x + p.facing * (HEAD_R + r + 30);
      let by = hy - 4;
      bx = Math.max(r + 6, Math.min(f.W - r - 6, bx));
      by = Math.max(r + 6, by);

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(bx, by);
      ctx.scale(pop, pop);
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = 'rgba(0,0,0,0.16)';
      ctx.lineWidth = 2;
      // Short tail: a small pointer on the bubble edge nearest the mouth (never
      // a long stretch across the face). Drawn first so the body hides its base.
      let dx = mouthX - bx, dy = mouthY - by;
      const dl = Math.hypot(dx, dy) || 1;
      const ux = dx / dl, uy = dy / dl;      // toward the mouth
      const nx = -uy, ny = ux;               // perpendicular
      const baseHalf = 8, tip = r + 22;
      ctx.beginPath();
      ctx.moveTo(ux * (r - 3) + nx * baseHalf, uy * (r - 3) + ny * baseHalf);
      ctx.lineTo(ux * tip, uy * tip);
      ctx.lineTo(ux * (r - 3) - nx * baseHalf, uy * (r - 3) - ny * baseHalf);
      ctx.closePath();
      ctx.fill();
      // Bubble body over the tail base.
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // Emoji.
      ctx.globalAlpha = alpha;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '40px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
      ctx.fillText(em.char, 0, 2);
      ctx.restore();
    }

    _drawNetFront(ctx, side) {
      // A faint front mesh in front of characters standing in the goal.
      const f = this.f;
      const left = side === 'left';
      const x0 = left ? 0 : f.W - f.GOAL_DEPTH;
      const x1 = left ? f.GOAL_DEPTH : f.W;
      ctx.save();
      ctx.globalAlpha = 0.18;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      for (let x = x0; x <= x1; x += 12) {
        ctx.beginPath(); ctx.moveTo(x, f.TOP_Y); ctx.lineTo(x, f.GROUND_Y); ctx.stroke();
      }
      ctx.restore();
    }

    _drawShadow(ctx, x, groundY, feetY) {
      const air = Math.max(0, groundY - feetY);
      const k = Math.max(0.25, 1 - air / 260);
      ctx.save();
      ctx.globalAlpha = 0.28 * k;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse(x, groundY + 4, 42 * k, 10 * k, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    _drawBallShadow(ctx, b) {
      const groundY = this.f.GROUND_Y;
      const air = Math.max(0, groundY - (b.y + b.r));
      const k = Math.max(0.3, 1 - air / 300);
      ctx.save();
      ctx.globalAlpha = 0.26 * k;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse(b.x, groundY + 4, b.r * 1.1 * k, 7 * k, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    _teamColors(team) {
      if (team === 'blue') return { jersey: '#2F7DE0', jerseyDk: '#1B4E96', trim: '#bcd7f7' };
      return { jersey: '#E43B3B', jerseyDk: '#A62222', trim: '#ffd0d0' };
    }

    _drawPlayer(ctx, p) {
      const f = this.f;
      const col = this._teamColors(p.team);
      // Skin tone is per-TEAM (not per-seat) so teammates match — the bald 2nd
      // player shares seat 0's skin. Seat 0 is unchanged, so 1v1 is unaffected.
      const skin = SKIN[(p.team === 'red' ? 0 : 2) % SKIN.length];
      const skinDk = this._shade(skin, -0.18);
      // The 2nd player on each team (seat 1) is bald — an easy way to tell the
      // two teammates apart in 2v2 (seat 0 keeps the team hairstyle).
      const bald = p.seat === 1;

      const hx = p.x;
      const hy = p.y - f.HEAD_CY;        // head centre
      const bodyCY = p.y - f.BODY_CY;    // torso centre
      const hipY = p.y - 40;

      // Dash streak: fading afterimages behind a dashing player so the burst
      // clearly reads on the host screen.
      if (p.dash > 0) {
        const dir = p.dashDir || p.facing;
        for (let i = 3; i >= 1; i--) {
          const gx = p.x - dir * i * 20;
          ctx.save();
          ctx.globalAlpha = 0.10 * (4 - i);
          ctx.fillStyle = col.jersey;
          ctx.beginPath(); ctx.arc(gx, hy, f.HEAD_R, 0, Math.PI * 2); ctx.fill();
          ctx.beginPath(); ctx.arc(gx, bodyCY, f.BODY_R, 0, Math.PI * 2); ctx.fill();
          ctx.restore();
        }
      }

      // ---- Legs (kicking leg swings toward the boot) ----
      const swing = 1 - Math.max(0, p.kick) / 0.30;
      const sw = p.kick > 0 ? Math.sin(Math.min(1, swing / 0.6) * Math.PI / 2) : 0;
      let kickFootX, kickFootY, standFootX, standFootY, kickBend, standBend;
      if (p.kick > 0) {
        // Soccer kick: a short forward snap. The boot starts cocked behind, then
        // whips forward to just past the ball at shin height — not a long stick.
        kickFootX = p.x + p.facing * (-16 + 72 * sw);
        kickFootY = p.y - 4 - 26 * sw;
        standFootX = p.x - p.facing * 12;
        standFootY = p.y - 2;
        kickBend = 13 + 6 * (1 - sw);
        standBend = 6;
      } else {
        // Standing stance: a clear front foot and back foot (never tucked
        // together), with the front boot out where a ball bounces off the body
        // so contact looks solid.
        kickFootX = p.x + p.facing * 20;   // front foot
        kickFootY = p.y - 2;
        standFootX = p.x - p.facing * 16;  // back foot
        standFootY = p.y - 2;
        kickBend = 7;
        standBend = 7;
      }
      // Standing leg keeps a gentle knee; the kicking leg holds a strong knee
      // bend throughout so the shin visibly snaps through the ball.
      this._leg(ctx, hx - p.facing * 3, hipY + 2, standFootX, standFootY, skin, col.jerseyDk, p.facing, standBend);
      this._leg(ctx, hx + p.facing * 6, hipY + 2, kickFootX, kickFootY, skin, col.jerseyDk, p.facing, kickBend);
      this._boot(ctx, standFootX, standFootY, p.facing, '#171717');
      this._boot(ctx, kickFootX, kickFootY, p.facing, '#171717');

      // ---- Shorts ----
      ctx.fillStyle = col.jerseyDk;
      ctx.strokeStyle = 'rgba(0,0,0,0.32)';
      ctx.lineWidth = 3;
      this._roundRect(ctx, hx - (f.BODY_R + 1), hipY - 12, (f.BODY_R + 1) * 2, 26, 11);
      ctx.fill(); ctx.stroke();

      // ---- Arms (skin, tucked behind the torso) ----
      ctx.lineCap = 'round';
      for (const s of [-1, 1]) {
        ctx.strokeStyle = 'rgba(0,0,0,0.26)'; ctx.lineWidth = 11;
        ctx.beginPath(); ctx.moveTo(hx + s * f.BODY_R, bodyCY - 6); ctx.lineTo(hx + s * (f.BODY_R + 10), bodyCY + 16); ctx.stroke();
        ctx.strokeStyle = skin; ctx.lineWidth = 8;
        ctx.beginPath(); ctx.moveTo(hx + s * f.BODY_R, bodyCY - 6); ctx.lineTo(hx + s * (f.BODY_R + 10), bodyCY + 16); ctx.stroke();
      }

      // ---- Sleeves (rounded shoulders) + trim cuffs ----
      for (const s of [-1, 1]) {
        ctx.fillStyle = col.jerseyDk;
        ctx.beginPath(); ctx.arc(hx + s * (f.BODY_R - 2), bodyCY - 8, 13, 0, Math.PI * 2); ctx.fill();
        // Trim cuff along the sleeve hem.
        ctx.strokeStyle = col.trim; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(hx + s * (f.BODY_R - 2), bodyCY - 8, 12, Math.PI * 0.18, Math.PI * 0.82); ctx.stroke();
      }

      // ---- Torso (jersey) ----
      const grad = ctx.createLinearGradient(0, bodyCY - f.BODY_R - 10, 0, bodyCY + f.BODY_R + 10);
      grad.addColorStop(0, this._shade(col.jersey, 0.16));
      grad.addColorStop(1, col.jerseyDk);
      ctx.fillStyle = grad;
      ctx.strokeStyle = 'rgba(0,0,0,0.34)';
      ctx.lineWidth = 3;
      this._roundedBody(ctx, hx, bodyCY, f.BODY_R + 4, f.BODY_R + 10);
      ctx.fill(); ctx.stroke();
      // Vertical jersey stripes (soccer-kit look), clipped to the torso.
      ctx.save();
      this._roundedBody(ctx, hx, bodyCY, f.BODY_R + 4, f.BODY_R + 10); ctx.clip();
      ctx.fillStyle = col.jerseyDk;
      ctx.globalAlpha = 0.85;
      const _sw = 9;
      for (let sx = hx - (f.BODY_R + 12); sx < hx + (f.BODY_R + 12); sx += _sw * 2) {
        ctx.fillRect(sx, bodyCY - (f.BODY_R + 14), _sw, (f.BODY_R + 14) * 2);
      }
      ctx.restore();
      // Soft left-light / right-shade sheen.
      ctx.save();
      this._roundedBody(ctx, hx, bodyCY, f.BODY_R + 4, f.BODY_R + 10); ctx.clip();
      const sheen = ctx.createLinearGradient(hx - f.BODY_R, 0, hx + f.BODY_R, 0);
      sheen.addColorStop(0, 'rgba(255,255,255,0.14)');
      sheen.addColorStop(0.55, 'rgba(255,255,255,0)');
      sheen.addColorStop(1, 'rgba(0,0,0,0.16)');
      ctx.fillStyle = sheen;
      ctx.fillRect(hx - f.BODY_R - 8, bodyCY - f.BODY_R - 14, (f.BODY_R + 8) * 2, (f.BODY_R + 14) * 2);
      ctx.restore();
      // Collar (V-neck).
      ctx.strokeStyle = col.trim;
      ctx.lineWidth = 4; ctx.lineCap = 'round';
      const topY = bodyCY - (f.BODY_R + 8);
      ctx.beginPath(); ctx.moveTo(hx - 9, topY + 2); ctx.lineTo(hx, topY + 11); ctx.lineTo(hx + 9, topY + 2); ctx.stroke();

      // ---- Jersey number ----
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const redCount = this.world.players.reduce((n, q) => n + (q.team === 'red' ? 1 : 0), 0);
      const jerseyNum = p.team === 'red' ? p.seat + 1 : redCount + p.seat + 1;
      ctx.save();
      ctx.fillStyle = '#fff';
      ctx.font = '800 22px Inter, sans-serif';
      ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 3; ctx.shadowOffsetY = 1;
      ctx.fillText(String(jerseyNum), hx, bodyCY + 3);
      ctx.restore();

      // ---- Chest crest (little badge) ----
      ctx.save();
      const crestX = hx - f.BODY_R * 0.55, crestY = bodyCY - f.BODY_R * 0.34;
      ctx.fillStyle = col.trim;
      ctx.strokeStyle = 'rgba(0,0,0,0.32)'; ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(crestX - 4.5, crestY - 5.5);
      ctx.lineTo(crestX + 4.5, crestY - 5.5);
      ctx.lineTo(crestX + 4.5, crestY + 1.5);
      ctx.quadraticCurveTo(crestX, crestY + 7, crestX - 4.5, crestY + 1.5);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.restore();

      // ---- Hair behind the head (long locks / afro volume) ----
      if (!bald) this._hairBehind(ctx, p, hx, hy, f);

      // ---- Head ----
      // Ears show on the bald player (seat 1); otherwise the hair covers them.
      if (bald) {
        ctx.fillStyle = skinDk;
        for (const s of [-1, 1]) { ctx.beginPath(); ctx.arc(hx + s * (f.HEAD_R - 3), hy + 4, 8, 0, Math.PI * 2); ctx.fill(); }
      }
      // Face sphere with a soft top-left key light.
      const hg = ctx.createRadialGradient(hx - 13, hy - 15, 6, hx, hy + 6, f.HEAD_R + 8);
      hg.addColorStop(0, this._shade(skin, 0.22));
      hg.addColorStop(0.72, skin);
      hg.addColorStop(1, skinDk);
      ctx.fillStyle = hg;
      ctx.beginPath(); ctx.arc(hx, hy, f.HEAD_R, 0, Math.PI * 2); ctx.fill();
      // Outline: a bald head gets a full soft outline (no hair to frame it);
      // otherwise only the EXPOSED chin/jaw is stroked (red's hair frames the
      // sides, blue's lower face is bare).
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.3)';
      if (bald) {
        ctx.beginPath(); ctx.arc(hx, hy, f.HEAD_R, 0, Math.PI * 2); ctx.stroke();
        // Bald-pate shine.
        ctx.fillStyle = 'rgba(255,255,255,0.16)';
        ctx.beginPath(); ctx.ellipse(hx - f.HEAD_R * 0.24, hy - f.HEAD_R * 0.5, f.HEAD_R * 0.30, f.HEAD_R * 0.16, -0.5, 0, Math.PI * 2); ctx.fill();
      } else {
        const jaw0 = p.team === 'red' ? Math.PI * 0.34 : Math.PI * 0.15;
        const jaw1 = p.team === 'red' ? Math.PI * 0.66 : Math.PI * 0.85;
        ctx.beginPath(); ctx.arc(hx, hy, f.HEAD_R, jaw0, jaw1); ctx.stroke();
      }
      // Subtle nose.
      ctx.fillStyle = skinDk;
      ctx.beginPath(); ctx.ellipse(hx + p.facing * 20, hy + 9, 5, 6, 0, 0, Math.PI * 2); ctx.fill();

      // ---- Hair (styled by team; drawn on top of the face) ----
      if (!bald) this._hairFront(ctx, p, hx, hy, f);

      // ---- Face: eyes + brows + mouth ----
      const ex = hx + p.facing * 11;
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.ellipse(ex - 9, hy + 3, 7, 9, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(ex + 9, hy + 3, 7, 9, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#20140d';
      ctx.beginPath(); ctx.arc(ex - 9 + p.facing * 3, hy + 5, 3.6, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(ex + 9 + p.facing * 3, hy + 5, 3.6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.beginPath(); ctx.arc(ex - 9 + p.facing * 3 - 1.4, hy + 3.4, 1.2, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(ex + 9 + p.facing * 3 - 1.4, hy + 3.4, 1.2, 0, Math.PI * 2); ctx.fill();
      // Eyebrows — furrow when kicking.
      ctx.strokeStyle = '#3a2418'; ctx.lineWidth = 3; ctx.lineCap = 'round';
      const brow = p.kick > 0 ? 3 : 0;
      ctx.beginPath(); ctx.moveTo(ex - 16, hy - 9 + brow); ctx.lineTo(ex - 2, hy - 7); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(ex + 2, hy - 7); ctx.lineTo(ex + 16, hy - 9 + brow); ctx.stroke();
      // Mouth — opens on a kick.
      if (p.kick > 0) {
        ctx.fillStyle = '#5a2c22';
        ctx.beginPath(); ctx.ellipse(hx + p.facing * 7, hy + 21, 6, 7, 0, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.strokeStyle = '#5a2c22'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(hx + p.facing * 2, hy + 20); ctx.quadraticCurveTo(hx + p.facing * 9, hy + 24, hx + p.facing * 16, hy + 20); ctx.stroke();
      }

      // ---- Nametag ----
      const label = p.name.length > 10 ? p.name.slice(0, 9) + '…' : p.name;
      ctx.font = '700 15px Inter, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const tw = ctx.measureText(label).width + 16;
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      this._roundRect(ctx, hx - tw / 2, hy - f.HEAD_R - 30, tw, 21, 9);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.16)'; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.fillText(label, hx, hy - f.HEAD_R - 19);

      if (!p.connected) {
        ctx.save();
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = '#06182a';
        ctx.beginPath(); ctx.arc(hx, hy, f.HEAD_R + 6, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(hx, bodyCY, f.BODY_R + 10, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
    }

    // Hair drawn BEHIND the head (before the face sphere): the red team's long
    // wavy blonde locks flowing past the shoulders, or the blue team's black
    // afro volume ringing the crown. Face is drawn on top, so these read as a
    // mass around the head.
    _hairBehind(ctx, p, hx, hy, f) {
      const R = f.HEAD_R;
      if (p.team === 'blue') {
        // Black afro: a bumpy cloud across the crown + upper sides.
        ctx.fillStyle = '#141414';
        const N = 12;
        for (let i = 0; i < N; i++) {
          const phi = Math.PI * (0.05 + 0.90 * (i / (N - 1)));
          const rr = R * 1.02;
          const bx = hx - Math.cos(phi) * rr;
          const by = hy - Math.sin(phi) * rr - R * 0.06;
          const br = R * (0.40 + 0.05 * Math.sin(i * 1.9));
          ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2); ctx.fill();
        }
        for (const s of [-1, 1]) {
          ctx.beginPath(); ctx.arc(hx + s * R * 0.96, hy - R * 0.14, R * 0.46, 0, Math.PI * 2); ctx.fill();
        }
      } else {
        // Sleek northern-European blonde: a SLIM mass hugging the head (not
        // bulky) — crown + sides over the ears down to a neat jaw/neck flick.
        // Groomed, so no scraggly shoulder wisps.
        const dk = '#EACD76';
        ctx.fillStyle = dk;
        ctx.beginPath();
        ctx.moveTo(hx - R * 0.50, hy - R * 0.80);
        ctx.quadraticCurveTo(hx, hy - R * 1.12, hx + R * 0.50, hy - R * 0.80);
        ctx.quadraticCurveTo(hx + R * 1.05, hy - R * 0.40, hx + R * 1.01, hy + R * 0.18);
        ctx.quadraticCurveTo(hx + R * 1.03, hy + R * 0.60, hx + R * 0.84, hy + R * 0.96);
        ctx.quadraticCurveTo(hx + R * 0.72, hy + R * 1.08, hx + R * 0.60, hy + R * 0.92);
        ctx.quadraticCurveTo(hx, hy + R * 0.95, hx - R * 0.60, hy + R * 0.92);
        ctx.quadraticCurveTo(hx - R * 0.72, hy + R * 1.08, hx - R * 0.84, hy + R * 0.96);
        ctx.quadraticCurveTo(hx - R * 1.03, hy + R * 0.60, hx - R * 1.01, hy + R * 0.18);
        ctx.quadraticCurveTo(hx - R * 1.05, hy - R * 0.40, hx - R * 0.50, hy - R * 0.80);
        ctx.closePath(); ctx.fill();
        // One neat shine strand each side (healthy, groomed — not messy).
        ctx.strokeStyle = '#F3E4A2'; ctx.lineWidth = 2; ctx.lineCap = 'round';
        for (const s of [-1, 1]) {
          ctx.beginPath(); ctx.moveTo(hx + s * R * 0.72, hy - R * 0.20); ctx.quadraticCurveTo(hx + s * R * 0.90, hy + R * 0.40, hx + s * R * 0.74, hy + R * 0.90); ctx.stroke();
        }
      }
    }

    // Hair drawn ON TOP of the face (clipped to the head): the fringe / hairline.
    _hairFront(ctx, p, hx, hy, f) {
      const R = f.HEAD_R;
      ctx.save();
      ctx.beginPath(); ctx.arc(hx, hy, R, 0, Math.PI * 2); ctx.clip();
      if (p.team === 'blue') {
        // Afro hairline across the forehead + a row of tight-curl bumps.
        ctx.fillStyle = '#141414';
        ctx.beginPath();
        ctx.moveTo(hx - R, hy - R);
        ctx.lineTo(hx + R, hy - R);
        ctx.lineTo(hx + R, hy - R * 0.32);
        ctx.quadraticCurveTo(hx + R * 0.5, hy - R * 0.12, hx, hy - R * 0.28);
        ctx.quadraticCurveTo(hx - R * 0.5, hy - R * 0.12, hx - R, hy - R * 0.32);
        ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#222';
        for (let i = -2; i <= 2; i++) {
          ctx.beginPath(); ctx.arc(hx + i * R * 0.4, hy - R * 0.30, R * 0.16, 0, Math.PI * 2); ctx.fill();
        }
      } else {
        // Sleek blonde covering the crown, sides and ears with a neat, slightly
        // wider face opening (groomed, not bulky) + a clean centre part.
        ctx.fillStyle = '#EACD76';
        ctx.beginPath();
        ctx.arc(hx, hy, R, 0, Math.PI * 2);
        ctx.moveTo(hx + R * 0.56, hy + R * 0.16);
        ctx.ellipse(hx, hy + R * 0.16, R * 0.56, R * 0.84, 0, 0, Math.PI * 2, true);
        ctx.fill('evenodd');
        // Neat centre part + a soft sweep each side (groomed).
        ctx.strokeStyle = '#F3E4A2'; ctx.lineWidth = 2; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(hx, hy - R * 0.92); ctx.lineTo(hx, hy - R * 0.52); ctx.stroke();
        for (const s of [-1, 1]) {
          ctx.beginPath(); ctx.moveTo(hx + s * R * 0.10, hy - R * 0.86); ctx.quadraticCurveTo(hx + s * R * 0.64, hy - R * 0.34, hx + s * R * 0.66, hy + R * 0.30); ctx.stroke();
        }
        // Subtle white sheen on the crown.
        ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(hx - R * 0.34, hy - R * 0.72); ctx.quadraticCurveTo(hx, hy - R * 0.44, hx + R * 0.24, hy - R * 0.74); ctx.stroke();
      }
      ctx.restore();
    }

    // A two-tone leg with a bent knee: skin thigh into a team-coloured sock.
    // `facing` sets which way the knee bulges; `bend` is the bulge strength.
    _leg(ctx, x0, y0, x1, y1, skin, sock, facing, bend) {
      const dx = x1 - x0, dy = y1 - y0;
      const len = Math.hypot(dx, dy) || 1;
      // Perpendicular, oriented to bulge the knee toward `facing`.
      let px = -dy / len, py = dx / len;
      if (px * facing < 0) { px = -px; py = -py; }
      const kx = x0 + dx * 0.46 + px * bend;
      const ky = y0 + dy * 0.46 + py * bend;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      // Outline through hip → knee → foot.
      ctx.strokeStyle = 'rgba(0,0,0,0.32)'; ctx.lineWidth = 21;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(kx, ky); ctx.lineTo(x1, y1); ctx.stroke();
      // Thigh (skin) then shin (sock).
      ctx.strokeStyle = skin; ctx.lineWidth = 17;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(kx, ky); ctx.stroke();
      ctx.strokeStyle = sock; ctx.lineWidth = 17;
      ctx.beginPath(); ctx.moveTo(kx, ky); ctx.lineTo(x1, y1); ctx.stroke();
      // Knee cap.
      ctx.fillStyle = skin;
      ctx.beginPath(); ctx.arc(kx, ky, 8, 0, Math.PI * 2); ctx.fill();
    }

    _limb(ctx, x0, y0, x1, y1, w, color, outline) {
      ctx.strokeStyle = outline;
      ctx.lineWidth = w + 3;
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = w;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    }
    _boot(ctx, x, y, facing, color) {
      ctx.save();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.ellipse(x + facing * 8, y + 3, 18, 10, 0, 0, Math.PI * 2);
      ctx.fill();
      // Glossy highlight.
      ctx.fillStyle = 'rgba(255,255,255,0.16)';
      ctx.beginPath();
      ctx.ellipse(x + facing * 6, y + 0.5, 11, 4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    // Athletic jersey silhouette: broad shoulders that taper down through a
    // pinched waist and flare into a rounded hem, so it never reads as a box.
    _roundedBody(ctx, cx, cy, rw, rh) {
      const top = cy - rh;
      const bot = cy + rh;
      const neckW = rw * 0.34;       // gap at the collar
      const shoulderW = rw * 1.16;   // widest point, at the shoulders
      const waistW = rw * 0.70;      // pinched waist
      const hemW = rw * 0.92;        // flared, rounded hem
      const shoulderY = top + rh * 0.26;
      const waistY = cy + rh * 0.42;
      ctx.beginPath();
      // Collar across the top.
      ctx.moveTo(cx - neckW, top);
      ctx.lineTo(cx + neckW, top);
      // Right shoulder bulge.
      ctx.bezierCurveTo(cx + shoulderW * 0.7, top, cx + shoulderW, top + rh * 0.05, cx + shoulderW, shoulderY);
      // Right side taper down to the waist.
      ctx.bezierCurveTo(cx + shoulderW, shoulderY + rh * 0.34, cx + waistW, waistY - rh * 0.18, cx + waistW, waistY);
      // Flare out to the rounded hem.
      ctx.bezierCurveTo(cx + waistW, waistY + rh * 0.24, cx + hemW, bot - rh * 0.14, cx + hemW * 0.9, bot - rh * 0.02);
      ctx.quadraticCurveTo(cx + hemW * 0.55, bot + rh * 0.04, cx, bot + rh * 0.04);
      ctx.quadraticCurveTo(cx - hemW * 0.55, bot + rh * 0.04, cx - hemW * 0.9, bot - rh * 0.02);
      // Left side back up (mirror).
      ctx.bezierCurveTo(cx - hemW, bot - rh * 0.14, cx - waistW, waistY + rh * 0.24, cx - waistW, waistY);
      ctx.bezierCurveTo(cx - waistW, waistY - rh * 0.18, cx - shoulderW, shoulderY + rh * 0.34, cx - shoulderW, shoulderY);
      ctx.bezierCurveTo(cx - shoulderW, top + rh * 0.05, cx - shoulderW * 0.7, top, cx - neckW, top);
      ctx.closePath();
    }
    _roundRect(ctx, x, y, w, h, r) {
      r = Math.min(r, w / 2, h / 2);
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    _drawBall(ctx, b) {
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.spin);
      const R = b.r;
      const black = '#191d22';

      // Sphere base.
      const g = ctx.createRadialGradient(-R * 0.35, -R * 0.42, R * 0.15, 0, 0, R * 1.05);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.72, '#eef2f5');
      g.addColorStop(1, '#c1c9d0');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fill();

      // Keep the pentagon pattern inside the ball.
      ctx.save();
      ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.clip();

      // Central pentagon vertices (a point facing up).
      const rc = R * 0.42;
      const cv = [];
      for (let i = 0; i < 5; i++) {
        const a = (i * 72 - 90) * Math.PI / 180;
        cv.push([Math.cos(a) * rc, Math.sin(a) * rc, a]);
      }

      // Seams: from each central vertex out to the rim.
      ctx.strokeStyle = black;
      ctx.lineWidth = Math.max(1.4, R * 0.07);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (const v of cv) {
        ctx.beginPath();
        ctx.moveTo(v[0], v[1]);
        ctx.lineTo(Math.cos(v[2]) * R * 1.05, Math.sin(v[2]) * R * 1.05);
        ctx.stroke();
      }

      // Central black pentagon.
      ctx.fillStyle = black;
      ctx.beginPath();
      cv.forEach((v, i) => { i ? ctx.lineTo(v[0], v[1]) : ctx.moveTo(v[0], v[1]); });
      ctx.closePath(); ctx.fill();

      // Outer black patches, aligned with the central pentagon's edges and
      // riding the rim so they read as the classic wrapped panels.
      const ro = R * 0.98, pr = R * 0.40;
      for (let i = 0; i < 5; i++) {
        const a = ((i * 72 - 90) + 36) * Math.PI / 180; // edge midpoint direction
        const cx = Math.cos(a) * ro, cy = Math.sin(a) * ro;
        ctx.fillStyle = black;
        ctx.beginPath();
        for (let k = 0; k < 5; k++) {
          const pa = a + (k * 72) * Math.PI / 180; // one vertex points outward
          const px = cx + Math.cos(pa) * pr, py = cy + Math.sin(pa) * pr;
          k ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
        }
        ctx.closePath(); ctx.fill();
      }
      ctx.restore(); // unclip

      // Glossy highlight (top-left).
      const sh = ctx.createRadialGradient(-R * 0.4, -R * 0.45, 0, -R * 0.4, -R * 0.45, R * 0.95);
      sh.addColorStop(0, 'rgba(255,255,255,0.5)');
      sh.addColorStop(0.42, 'rgba(255,255,255,0)');
      ctx.fillStyle = sh;
      ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fill();

      // Rim outline.
      ctx.strokeStyle = 'rgba(0,0,0,0.3)';
      ctx.lineWidth = Math.max(1.5, R * 0.06);
      ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }

    _lighten(hex, amt) {
      const c = hex.replace('#', '');
      const r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), bl = parseInt(c.slice(4, 6), 16);
      const f = (v) => Math.round(lerp(v, 255, amt));
      return 'rgb(' + f(r) + ',' + f(g) + ',' + f(bl) + ')';
    }

    // Lighten (amt>0) or darken (amt<0) a hex colour by lerping toward white/black.
    _shade(hex, amt) {
      const c = hex.replace('#', '');
      const r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), bl = parseInt(c.slice(4, 6), 16);
      const t = amt < 0 ? 0 : 255, k = Math.abs(amt);
      const f = (v) => Math.round(lerp(v, t, k));
      return 'rgb(' + f(r) + ',' + f(g) + ',' + f(bl) + ')';
    }
  }

  window.SoccerHeadRender = { Renderer };
})();
