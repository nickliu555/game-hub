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
      const skin = SKIN[(p.seat + (p.team === 'red' ? 0 : 2)) % SKIN.length];
      // Dash streak: fading afterimages behind a dashing player so the burst
      // clearly reads on the host screen.
      if (p.dash > 0) {
        const dir = p.dashDir || p.facing;
        for (let i = 3; i >= 1; i--) {
          const gx = p.x - dir * i * 20;
          ctx.save();
          ctx.globalAlpha = 0.10 * (4 - i);
          ctx.fillStyle = col.jersey;
          ctx.beginPath(); ctx.arc(gx, p.y - f.HEAD_CY, f.HEAD_R, 0, Math.PI * 2); ctx.fill();
          ctx.beginPath(); ctx.arc(gx, p.y - f.BODY_CY, f.BODY_R, 0, Math.PI * 2); ctx.fill();
          ctx.restore();
        }
      }
      const hipX = p.x, hipY = p.y - 46;

      // Legs (kicking leg swings toward the foot tip).
      const swing = 1 - Math.max(0, p.kick) / 0.30;
      const sw = p.kick > 0 ? Math.sin(Math.min(1, swing / 0.6) * Math.PI / 2) : 0;
      const kickFootX = p.x + p.facing * (26 + 62 * sw);
      const kickFootY = p.y - 20 - 46 * sw;
      const standFootX = p.x - p.facing * 12;
      // Back/standing leg.
      this._limb(ctx, hipX + p.facing * 4, hipY + 6, standFootX, p.y - 2, 12, col.jerseyDk, '#222');
      // Kicking / front leg.
      this._limb(ctx, hipX + p.facing * 8, hipY + 6, kickFootX, kickFootY, 12, col.jerseyDk, '#222');
      // Boots.
      this._boot(ctx, kickFootX, kickFootY, p.facing, '#1a1a1a');
      this._boot(ctx, standFootX, p.y - 2, p.facing, '#1a1a1a');

      // Torso (jersey).
      const bodyCY = p.y - f.BODY_CY;
      const grad = ctx.createLinearGradient(p.x - f.BODY_R, bodyCY - f.BODY_R, p.x + f.BODY_R, bodyCY + f.BODY_R);
      grad.addColorStop(0, col.jersey);
      grad.addColorStop(1, col.jerseyDk);
      ctx.fillStyle = grad;
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 3;
      this._roundedBody(ctx, p.x, bodyCY, f.BODY_R + 4, f.BODY_R + 10);
      ctx.fill();
      ctx.stroke();
      // Jersey number.
      ctx.fillStyle = '#fff';
      ctx.font = '700 22px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // Sequential across the match: red team numbered first, then blue
      // continues (1v1 → red "1", blue "2"; 2v2 → 1,2 / 3,4).
      const redCount = this.world.players.reduce((n, q) => n + (q.team === 'red' ? 1 : 0), 0);
      const jerseyNum = p.team === 'red' ? p.seat + 1 : redCount + p.seat + 1;
      ctx.fillText(String(jerseyNum), p.x, bodyCY + 2);

      // Arm hint.
      ctx.strokeStyle = skin;
      ctx.lineWidth = 9;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(p.x - p.facing * (f.BODY_R - 2), bodyCY - 4);
      ctx.lineTo(p.x - p.facing * (f.BODY_R + 12), bodyCY + 16);
      ctx.stroke();

      // Head.
      const hx = p.x, hy = p.y - f.HEAD_CY;
      const hg = ctx.createRadialGradient(hx - 12, hy - 14, 6, hx, hy, f.HEAD_R + 4);
      hg.addColorStop(0, this._lighten(skin, 0.18));
      hg.addColorStop(1, skin);
      ctx.fillStyle = hg;
      ctx.strokeStyle = 'rgba(0,0,0,0.3)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(hx, hy, f.HEAD_R, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // Team cap ("hat"): only the FIRST player on a team (seat 0) wears it, so
      // the two teammates are easy to tell apart in 2v2 (seat 1 is bare-headed).
      if (p.seat === 0) {
        ctx.fillStyle = col.jerseyDk;
        ctx.beginPath();
        ctx.arc(hx, hy, f.HEAD_R, Math.PI * 1.08, Math.PI * 1.92, false);
        ctx.lineTo(hx, hy);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = col.jersey;
        ctx.fillRect(hx - f.HEAD_R, hy - 10, f.HEAD_R * 2, 7);
      }

      // Eyes (looking toward facing) + brow + mouth.
      const ex = hx + p.facing * 12;
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.ellipse(ex - 9, hy + 2, 7, 9, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(ex + 9, hy + 2, 7, 9, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#20140d';
      ctx.beginPath(); ctx.arc(ex - 9 + p.facing * 3, hy + 4, 3.4, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(ex + 9 + p.facing * 3, hy + 4, 3.4, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#3a2418';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(ex - 16, hy - 10); ctx.lineTo(ex - 2, hy - 8); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(ex + 2, hy - 8); ctx.lineTo(ex + 16, hy - 10); ctx.stroke();
      // Mouth: open when kicking.
      ctx.strokeStyle = '#5a2c22';
      ctx.lineWidth = 3;
      ctx.beginPath();
      if (p.kick > 0) { ctx.arc(hx + p.facing * 8, hy + 20, 6, 0, Math.PI * 2); }
      else { ctx.moveTo(hx + p.facing * 2, hy + 20); ctx.lineTo(hx + p.facing * 16, hy + 20); }
      ctx.stroke();

      // Nametag.
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      const label = p.name.length > 10 ? p.name.slice(0, 9) + '…' : p.name;
      ctx.font = '700 15px Inter, sans-serif';
      const tw = ctx.measureText(label).width + 14;
      this._roundRect(ctx, hx - tw / 2, hy - f.HEAD_R - 26, tw, 20, 8);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(label, hx, hy - f.HEAD_R - 15);

      if (!p.connected) {
        ctx.globalAlpha = 0.6;
        ctx.fillStyle = '#000';
        ctx.beginPath(); ctx.arc(hx, hy, f.HEAD_R + 4, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
      }
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
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.ellipse(x + facing * 6, y + 2, 14, 8, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    _roundedBody(ctx, cx, cy, rw, rh) {
      this._roundRect(ctx, cx - rw, cy - rh, rw * 2, rh * 2, 16);
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
      // Base.
      const g = ctx.createRadialGradient(-b.r * 0.4, -b.r * 0.4, b.r * 0.2, 0, 0, b.r);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(1, '#c9d2da');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(0, 0, b.r, 0, Math.PI * 2); ctx.fill();
      // Pentagon panels.
      ctx.fillStyle = '#20303a';
      ctx.beginPath(); ctx.arc(0, 0, b.r * 0.34, 0, Math.PI * 2); ctx.fill();
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        const px = Math.cos(a) * b.r * 0.62;
        const py = Math.sin(a) * b.r * 0.62;
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(a);
        ctx.fillStyle = '#26363f';
        ctx.beginPath(); ctx.ellipse(0, 0, b.r * 0.16, b.r * 0.1, 0, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
      // Outline + sheen.
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, b.r, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }

    _lighten(hex, amt) {
      const c = hex.replace('#', '');
      const r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), bl = parseInt(c.slice(4, 6), 16);
      const f = (v) => Math.round(lerp(v, 255, amt));
      return 'rgb(' + f(r) + ',' + f(g) + ',' + f(bl) + ')';
    }
  }

  window.SoccerHeadRender = { Renderer };
})();
