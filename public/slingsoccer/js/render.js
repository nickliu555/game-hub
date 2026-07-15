/* Sling Soccer — top-down canvas renderer.
 *
 * Draws a birds-eye grass pitch (stripes, boundary + centre + penalty lines,
 * side goals with nets) and the dynamic layer (numbered tokens, the ball, the
 * active-token highlight, and the live slingshot aim: pull band, launch arrow,
 * dotted trajectory + power). World units come from the engine (1500x1000 plus
 * the goal pockets); the canvas is fit with letterboxing at device resolution.
 */
(function () {
  'use strict';

  const COL = {
    grassA: '#2f9e57',
    grassB: '#2a924f',
    line: 'rgba(255,255,255,0.85)',
    lineSoft: 'rgba(255,255,255,0.6)',
    surround: '#0c3a22',
    net: 'rgba(255,255,255,0.5)',
    post: '#f4f7f5',
    red: '#e4483b',
    redDeep: '#a52a22',
    blue: '#2f7de0',
    blueDeep: '#1b4e96',
    ball: '#ffffff',
    ballDark: '#1c2530',
    aim: '#f4c430',
  };

  function lerp(a, b, t) { return a + (b - a) * t; }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  class Renderer {
    constructor(canvas, world) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.world = world;
      this.f = world.field;
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      // Extra world margin so the goal pockets (x<0, x>W) are on-screen.
      this.padX = this.f.GOAL_DEPTH + 26;
      this.padY = 26;
      this.scale = 1; this.offX = 0; this.offY = 0;
      this.particles = [];
      this.resize();
    }

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      const cw = Math.max(1, Math.round(rect.width * this.dpr));
      const ch = Math.max(1, Math.round(rect.height * this.dpr));
      if (this.canvas.width !== cw) this.canvas.width = cw;
      if (this.canvas.height !== ch) this.canvas.height = ch;
      const worldW = this.f.W + 2 * this.padX;
      const worldH = this.f.H + 2 * this.padY;
      const s = Math.min(cw / worldW, ch / worldH);
      this.scale = s;
      this.offX = (cw - worldW * s) / 2 + this.padX * s;
      this.offY = (ch - worldH * s) / 2 + this.padY * s;
    }

    // Map convenience.
    _applyTransform() {
      const s = this.scale;
      this.ctx.setTransform(s, 0, 0, s, this.offX, this.offY);
    }

    render(opts) {
      const ctx = this.ctx;
      const f = this.f;
      opts = opts || {};
      // Clear to the stadium surround.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = COL.surround;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

      this._applyTransform();
      this._drawPitch();
      this._drawGoals();
      // Aim (drawn under the tokens so the disc + number stay crisp on top).
      if (opts.aim) this._drawAim(opts.aim);
      this._drawBall();
      this._drawTokens(opts.active);
      this._updateParticles(opts.dt || 0.016);
      this._drawParticles();
    }

    _drawPitch() {
      const ctx = this.ctx, f = this.f;
      // Mowed stripes.
      const stripes = 10;
      for (let i = 0; i < stripes; i++) {
        ctx.fillStyle = i % 2 === 0 ? COL.grassA : COL.grassB;
        ctx.fillRect((f.W / stripes) * i, 0, f.W / stripes + 1, f.H);
      }
      // Boundary.
      ctx.strokeStyle = COL.line;
      ctx.lineWidth = 6;
      const m = f.FIELD_MARGIN || 24;
      ctx.strokeRect(m, m, f.W - 2 * m, f.H - 2 * m);
      // Halfway line + centre circle + spot.
      ctx.beginPath();
      ctx.moveTo(f.W / 2, m); ctx.lineTo(f.W / 2, f.H - m);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(f.W / 2, f.H / 2, f.H * 0.14, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = COL.line;
      ctx.beginPath(); ctx.arc(f.W / 2, f.H / 2, 8, 0, Math.PI * 2); ctx.fill();
      // Penalty boxes (near each goal mouth).
      const boxW = f.PBOX_W || 180, boxH = f.GOAL_H + f.H * 0.2;
      const boxTop = (f.H - boxH) / 2;
      ctx.strokeRect(m, boxTop, boxW, boxH);
      ctx.strokeRect(f.W - m - boxW, boxTop, boxW, boxH);
      // Six-yard boxes.
      const sixW = Math.round((f.PBOX_W || 180) * 0.5), sixH = f.GOAL_H + f.H * 0.06;
      const sixTop = (f.H - sixH) / 2;
      ctx.strokeRect(m, sixTop, sixW, sixH);
      ctx.strokeRect(f.W - m - sixW, sixTop, sixW, sixH);
    }

    _drawGoals() {
      const ctx = this.ctx, f = this.f;
      // Nets in the pockets.
      for (const side of ['left', 'right']) {
        const x0 = side === 'left' ? -f.GOAL_DEPTH : f.W;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, f.GOAL_TOP, f.GOAL_DEPTH, f.GOAL_H);
        ctx.clip();
        ctx.fillStyle = 'rgba(255,255,255,0.10)';
        ctx.fillRect(x0, f.GOAL_TOP, f.GOAL_DEPTH, f.GOAL_H);
        ctx.strokeStyle = COL.net;
        ctx.lineWidth = 1.5;
        for (let gx = x0; gx <= x0 + f.GOAL_DEPTH; gx += 14) {
          ctx.beginPath(); ctx.moveTo(gx, f.GOAL_TOP); ctx.lineTo(gx, f.GOAL_TOP + f.GOAL_H); ctx.stroke();
        }
        for (let gy = f.GOAL_TOP; gy <= f.GOAL_TOP + f.GOAL_H; gy += 14) {
          ctx.beginPath(); ctx.moveTo(x0, gy); ctx.lineTo(x0 + f.GOAL_DEPTH, gy); ctx.stroke();
        }
        ctx.restore();
      }
      // Goal line (the scoring line) + posts.
      ctx.strokeStyle = COL.post;
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.moveTo(0, f.GOAL_TOP); ctx.lineTo(0, f.GOAL_BOT);
      ctx.moveTo(f.W, f.GOAL_TOP); ctx.lineTo(f.W, f.GOAL_BOT);
      ctx.stroke();
      ctx.fillStyle = COL.post;
      for (const p of f.posts) {
        ctx.beginPath(); ctx.arc(p.x, p.y, f.POST_R, 0, Math.PI * 2); ctx.fill();
      }
    }

    _drawTokens(active) {
      const ctx = this.ctx;
      for (const t of this.world.tokens) {
        const isRed = t.team === 'red';
        const isActive = active && active.team === t.team && active.idx === t.idx;
        // Shadow.
        ctx.fillStyle = 'rgba(0,0,0,0.22)';
        ctx.beginPath(); ctx.ellipse(t.x + 3, t.y + 5, t.r, t.r * 0.9, 0, 0, Math.PI * 2); ctx.fill();
        // Disc.
        const g = ctx.createRadialGradient(t.x - t.r * 0.4, t.y - t.r * 0.4, t.r * 0.2, t.x, t.y, t.r);
        g.addColorStop(0, isRed ? '#ff6a5e' : '#6aa8f2');
        g.addColorStop(1, isRed ? COL.redDeep : COL.blueDeep);
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(t.x, t.y, t.r, 0, Math.PI * 2); ctx.fill();
        // Rim.
        ctx.lineWidth = 4;
        ctx.strokeStyle = isRed ? '#ffd2cc' : '#cfe2fb';
        ctx.beginPath(); ctx.arc(t.x, t.y, t.r - 2, 0, Math.PI * 2); ctx.stroke();
        // Number.
        ctx.fillStyle = '#fff';
        ctx.font = '900 ' + Math.round(t.r * 1.15) + 'px Inter, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(t.idx + 1), t.x, t.y + 1);
        // Active highlight ring (pulsing).
        if (isActive) {
          const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 140);
          ctx.strokeStyle = COL.aim;
          ctx.lineWidth = 4 + pulse * 3;
          ctx.beginPath(); ctx.arc(t.x, t.y, t.r + 8 + pulse * 4, 0, Math.PI * 2); ctx.stroke();
        }
      }
    }

    _drawBall() {
      const ctx = this.ctx, b = this.world.ball;
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.beginPath(); ctx.ellipse(b.x + 2, b.y + 4, b.r, b.r * 0.9, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = COL.ball;
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r - 1, 0, Math.PI * 2); ctx.stroke();
      // Simple pentagon spots for a soccer-ball read.
      ctx.fillStyle = COL.ballDark;
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r * 0.34, 0, Math.PI * 2); ctx.fill();
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
        ctx.beginPath();
        ctx.arc(b.x + Math.cos(a) * b.r * 0.66, b.y + Math.sin(a) * b.r * 0.66, b.r * 0.16, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // aim = { team, idx, dx, dy }  where (dx,dy) is the PULL vector (|v|<=1 = power).
    _drawAim(aim) {
      const t = this.world.tokenAt(aim.team, aim.idx);
      if (!t) return;
      const power = Math.min(1, Math.hypot(aim.dx || 0, aim.dy || 0));
      if (power < 0.02) return;
      const ctx = this.ctx;
      const lx = -(aim.dx / power), ly = -(aim.dy / power); // unit launch dir
      const ang = Math.atan2(ly, lx);
      const diameter = t.r * 2;
      const col = power > 0.75 ? '#ff5a4d' : power > 0.45 ? '#ffb03a' : COL.aim;
      // Pull band drawn back behind the token (opposite the launch).
      const pullLen = 18 + power * 90;
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(t.x, t.y);
      ctx.lineTo(t.x - lx * pullLen, t.y - ly * pullLen);
      ctx.stroke();
      // Short launch indicator: a stubby rounded bar 1–3 token-lengths long that
      // grows with power, sitting just ahead of the token in the launch line.
      const barLen = diameter * (1 + power * 2);   // ~1..3 players long
      const halfW = t.r * 0.55;
      const gap = t.r + 3;
      ctx.save();
      ctx.translate(t.x, t.y);
      ctx.rotate(ang);
      ctx.globalAlpha = 0.92;
      ctx.fillStyle = col;
      roundRect(ctx, gap, -halfW, barLen, halfW * 2, halfW);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.restore();
      // Power pip ring on the token.
      ctx.strokeStyle = col;
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(t.x, t.y, t.r + 6, -Math.PI / 2, -Math.PI / 2 + power * Math.PI * 2);
      ctx.stroke();
    }

    // ---- Particles (goal + respawn puffs) ----
    spawnBurst(x, y, color, n) {
      n = n || 20;
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = 120 + Math.random() * 340;
        this.particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.6 + Math.random() * 0.5, age: 0, color, r: 3 + Math.random() * 4 });
      }
    }
    _updateParticles(dt) {
      for (const p of this.particles) {
        p.age += dt;
        p.x += p.vx * dt; p.y += p.vy * dt;
        p.vx *= 0.94; p.vy *= 0.94;
      }
      this.particles = this.particles.filter((p) => p.age < p.life);
    }
    _drawParticles() {
      const ctx = this.ctx;
      for (const p of this.particles) {
        ctx.globalAlpha = Math.max(0, 1 - p.age / p.life);
        ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }

  window.SlingSoccerRender = { Renderer };
})();
