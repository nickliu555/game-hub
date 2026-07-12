/* Soccer Head — arcade soccer physics engine (host-authoritative).
 *
 * Runs entirely on the host browser. A fixed-timestep world with two big-head
 * characters per side, a bouncy ball, side goals with crossbars, and an
 * arcade feel tuned to echo Head Soccer: snappy grounded movement, floaty-ish
 * jumps with a faster fall, a swinging boot that launches the ball, lively
 * headers, and a quick dash on a cooldown.
 *
 * Units are "world" pixels; the renderer scales this to the canvas. Time is in
 * seconds. The host steps the world at a fixed dt (1/120s) for stable feel
 * regardless of display refresh rate.
 */
(function () {
  'use strict';

  // ---- Field geometry ----
  // A big, roomy pitch — this is the 1v1 size. 2v2 scales it up further via
  // MODE_SCALE so four characters have room to spread out.
  const W = 2000, H = 750;
  const GROUND_Y = 675;
  const CEIL_Y = 0;
  // A DEFENDABLE goal (~2.4 characters tall): a keeper covers the bottom standing
  // and the rest with a jump, so goals are earned by beating them out of position
  // — not by lobbing into a giant open net.
  const GOAL_H = 360;
  const GOAL_DEPTH = 84;
  const TOP_Y = GROUND_Y - GOAL_H; // crossbar y = 315
  const BAR_THICK = 9;
  const GOAL_LINE_L = GOAL_DEPTH * 0.55;
  const GOAL_LINE_R = W - GOAL_DEPTH * 0.55;

  // ---- Mode → field scale ----
  // 2v2 grows the field BOX (W/H/GROUND_Y) while every player/ball/goal size
  // stays fixed in pixels, so a bigger pitch just means more room — the goal is
  // exactly as defendable in both modes. 1v1 uses scale 1 (the base size above).
  const MODE_SCALE = { '1v1': 1, '2v2': 1.2 };
  // Goal opening height per mode (fixed pixels, NOT scaled by the field box) —
  // 2v2 gets a taller net. Falls back to GOAL_H for any unknown mode.
  const MODE_GOAL_H = { '1v1': 345, '2v2': 375 };

  // ---- Ball ----
  const BALL_R = 22;
  const BALL_G = 2100;
  const BALL_DRAG = 0.11;      // more air drag → shots bleed speed, keepers get time
  const GROUND_REST = 0.66;   // ball bounciness off the turf (higher = livelier)
  const WALL_REST = 0.72;
  const BAR_REST = 0.68;
  const ROLL_FRIC = 1.4;       // horizontal decay while rolling on ground
  // Kicks land ~1040 so they stay saveable; the higher cap only lets a committed
  // DASH body-check (below) fire off a genuinely fast, cooldown-gated cannon.
  const BALL_MAX = 2350;
  const REST_HEAD = 0.72;
  const REST_BODY = 0.74;

  // ---- Player ----
  // Slightly shorter character so there is clear air to lob the ball over a
  // standing defender and drop it under the tall crossbar.
  // Big cartoon head, small body (fits "Soccer HEAD" + makes headers easier):
  // HEAD_R is much larger than BODY_R. HEAD_CY is chosen so HEAD_CY + HEAD_R is
  // unchanged (156), i.e. the enlarged head grows DOWNWARD into the torso rather
  // than making the whole character taller. Both the hitbox AND the drawn head
  // read from these via world.field, so they can never drift out of sync.
  const HEAD_R = 50, HEAD_CY = 106;
  const BODY_R = 30, BODY_CY = 58;
  // Lower body / shins. The body circle's bottom sits ~24px above the feet
  // (BODY_CY-BODY_R), leaving a band down to the ground that used to be covered
  // only by the grounded foot-wall — so an AIRBORNE ball could slip through the
  // legs-to-torso area. This third circle overlaps the body circle and reaches
  // the feet so the silhouette is solid top-to-bottom with no gap.
  const LEG_R = 26, LEG_CY = 22;
  const HALF_W = 34;           // wall clamp half-width
  const GRAVITY = 2350, FALL_MULT = 1.28, MAX_FALL = 1650;
  // A big, floaty defensive leap tuned to the goal height: a full jump carries
  // the feet up to about the crossbar. apex rise = JUMP_V^2/(2*GRAVITY) =
  // 1170^2/4700 ≈ 291px ≈ GOAL_H, so you can spring up to the top of the goal to
  // defend or head high balls. (Near your own goal the bar clamp still caps your
  // head at the crossbar so you can't fly out the top.)
  const JUMP_V = 1170;
  const MOVE_ACCEL = 6200, MAX_SPEED = 440;
  const AIR_ACCEL = 3500, AIR_DAMP = 0.5, GROUND_DAMP = 16;
  const JUMP_BUFFER = 0.12, COYOTE = 0.09;
  // A real dash: a big, snappy lunge (~2.6x run speed) so it clearly reads as a
  // burst. Dashing INTO the ball is a POWER body-check (see DASH_HIT_*) — a hard
  // cannon in the dash direction, far faster than any kick, not the soft "carry"
  // of a walk-in.
  const DASH_SPEED = 1150, DASH_DUR = 0.18, DASH_CD = 2.2;
  const DASH_HIT_VX = 2100, DASH_HIT_LIFT = 340;
  // A loftier boot: a big upward component so you can chip the ball up and over
  // a defender. Softer forward drive + a longer cooldown so it's a deliberate
  // shot, not a rapid-fire cannon that keepers can't react to.
  const KICK_DUR = 0.30, KICK_CD = 0.52, FOOT_R = 30, KICK_VX = 940, KICK_VY = 1160, KICK_LIFT = 190;

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function makePlayer(info) {
    return {
      id: info.id,
      name: info.name,
      team: info.team,
      seat: info.seat,
      facing: info.team === 'red' ? 1 : -1,
      x: info.x, y: GROUND_Y,
      vx: 0, vy: 0,
      grounded: true,
      // held inputs
      left: false, right: false, jumpHeld: false,
      jumpBuffer: 0, coyote: 0, jumpCut: false,
      kickQueued: false,
      kick: 0, kickCd: 0, kicked: false,
      dash: 0, dashCd: 0, dashDir: 1,
      connected: true,
      // Transient goal-celebration emote (host-set): { char, until } or null.
      emote: null,
    };
  }

  class World {
    constructor(opts) {
      opts = opts || {};
      this.mode = opts.mode || '1v1';
      const s = MODE_SCALE[this.mode] || 1;
      this.scale = s;
      // Field box scales with the mode; players/ball/goal keep their pixel size,
      // so a bigger field just adds room. s = 1 reproduces 1v1 exactly.
      this.W = W * s;
      this.H = H * s;
      this.GROUND_Y = GROUND_Y * s;
      const goalH = MODE_GOAL_H[this.mode] || GOAL_H;
      this.TOP_Y = this.GROUND_Y - goalH; // crossbar (goal height is fixed px, per mode)
      this.dropY = this.GROUND_Y * 0.39;   // ball kickoff drop height
      this.field = { W: this.W, H: this.H, GROUND_Y: this.GROUND_Y, CEIL_Y, GOAL_H: goalH, GOAL_DEPTH, TOP_Y: this.TOP_Y, BAR_THICK, BALL_R, HEAD_R, HEAD_CY, BODY_R, BODY_CY };
      this.players = [];
      this.byId = new Map();
      this.ball = { x: this.W / 2, y: this.dropY, vx: 0, vy: 0, r: BALL_R, spin: 0 };
      this.frozen = true;
    }

    setRoster(roster) {
      this.players = [];
      this.byId = new Map();
      const W2 = this.W, gy = this.GROUND_Y;
      const spawnX = {
        red: [W2 * 0.30, W2 * 0.15],
        blue: [W2 * 0.70, W2 * 0.85],
      };
      for (const r of roster) {
        const x = spawnX[r.team][r.seat] || (r.team === 'red' ? W2 * 0.28 : W2 * 0.72);
        const p = makePlayer({ id: r.id, name: r.name, team: r.team, seat: r.seat, x });
        p.y = gy;
        this.players.push(p);
        this.byId.set(r.id, p);
      }
    }

    kickoff(towardTeam) {
      // Reset every character to its spawn and drop the ball at centre. If a
      // team is given the ball nudges slightly toward the conceding side.
      const W2 = this.W, gy = this.GROUND_Y;
      const spawnX = { red: [W2 * 0.30, W2 * 0.15], blue: [W2 * 0.70, W2 * 0.85] };
      for (const p of this.players) {
        p.x = spawnX[p.team][p.seat] || (p.team === 'red' ? W2 * 0.28 : W2 * 0.72);
        p.y = gy; p.vx = 0; p.vy = 0; p.grounded = true;
        p.left = p.right = p.jumpHeld = false;
        p.jumpBuffer = 0; p.kick = 0; p.kicked = false; p.kickQueued = false;
        p.dash = 0;
      }
      this.ball.x = W2 / 2;
      this.ball.y = this.dropY;
      // Bounce the ball toward the player who just conceded so they get first
      // touch — toward their own side of the pitch (red spawns left, blue right).
      // At the very start (towardTeam null) it just drops dead centre.
      this.ball.vx = (towardTeam === 'red' ? -170 : towardTeam === 'blue' ? 170 : 0) * this.scale;
      this.ball.vy = 0;
      this.ball.spin = 0;
    }

    setInput(id, code, down) {
      const p = this.byId.get(id);
      if (!p) return;
      if (code === 0) p.left = down;
      else if (code === 1) p.right = down;
      else if (code === 2) {
        if (down) { p.jumpBuffer = JUMP_BUFFER; p.jumpHeld = true; }
        else { p.jumpHeld = false; }
      } else if (code === 3) {
        if (down) p.kickQueued = true;
      }
    }

    clearInputs(id) {
      const p = this.byId.get(id);
      if (!p) return;
      p.left = p.right = p.jumpHeld = false;
      p.jumpBuffer = 0; p.kickQueued = false;
    }

    dash(id, dir) {
      const p = this.byId.get(id);
      if (!p) return;
      if (p.dashCd > 0 || p.dash > 0) return;
      p.dash = DASH_DUR;
      p.dashDir = dir < 0 ? -1 : 1;
      p.dashCd = DASH_CD;
      p.facing = p.facing; // facing stays fixed per team
    }

    // One fixed physics step. Returns 'red' | 'blue' if that team just scored.
    step(dt) {
      if (this.frozen) return null;
      // Remember start-of-step positions (used by the swept anti-tunnel so the
      // ball can never pass through a player, even a fast shot or one shoved in
      // by an opponent running into it).
      for (const p of this.players) { p.prevX = p.x; p.prevY = p.y; }
      this.ball.prevX = this.ball.x; this.ball.prevY = this.ball.y;
      for (const p of this.players) this._stepPlayer(p, dt);
      // Player-vs-player soft separation (keeps bodies from overlapping).
      this._separatePlayers();
      return this._stepBall(dt);
    }

    _stepPlayer(p, dt) {
      const dir = (p.right ? 1 : 0) - (p.left ? 1 : 0);

      // Dash overrides normal horizontal control for its brief duration.
      if (p.dash > 0) {
        p.dash -= dt;
        p.vx = p.dashDir * DASH_SPEED;
      } else {
        if (p.grounded) {
          if (dir !== 0) {
            p.vx += dir * MOVE_ACCEL * dt;
          } else {
            p.vx *= Math.exp(-GROUND_DAMP * dt);
            if (Math.abs(p.vx) < 4) p.vx = 0;
          }
        } else {
          if (dir !== 0) p.vx += dir * AIR_ACCEL * dt;
          p.vx *= Math.exp(-AIR_DAMP * dt);
        }
        p.vx = clamp(p.vx, -MAX_SPEED, MAX_SPEED);
      }
      if (p.dashCd > 0) p.dashCd -= dt;

      // Jump (buffered + coyote time for a responsive, natural feel).
      if (p.jumpBuffer > 0) p.jumpBuffer -= dt;
      if (p.coyote > 0) p.coyote -= dt;
      if (p.jumpBuffer > 0 && (p.grounded || p.coyote > 0)) {
        p.vy = -JUMP_V;
        p.grounded = false;
        p.jumpBuffer = 0;
        p.coyote = 0;
        p.jumpCut = false;
      }
      // Variable jump height: releasing early cuts the rise once.
      if (!p.jumpHeld && !p.jumpCut && p.vy < 0) {
        p.vy *= 0.5;
        p.jumpCut = true;
      }

      // Gravity with a snappier fall.
      p.vy += GRAVITY * dt;
      if (p.vy > 0) p.vy += GRAVITY * (FALL_MULT - 1) * dt;
      if (p.vy > MAX_FALL) p.vy = MAX_FALL;

      // Kick trigger.
      if (p.kickCd > 0) p.kickCd -= dt;
      if (p.kickQueued && p.kick <= 0 && p.kickCd <= 0) {
        p.kick = KICK_DUR; p.kicked = false; p.kickCd = KICK_CD;
      }
      p.kickQueued = false;
      if (p.kick > 0) p.kick -= dt;

      // Integrate.
      p.x += p.vx * dt;
      p.y += p.vy * dt;

      // Ground.
      if (p.y >= this.GROUND_Y) {
        p.y = this.GROUND_Y;
        if (p.vy > 0) p.vy = 0;
        if (!p.grounded) { p.grounded = true; }
        p.coyote = COYOTE;
      } else {
        p.grounded = false;
      }

      // Side walls.
      if (p.x < HALF_W) { p.x = HALF_W; if (p.vx < 0) p.vx = 0; }
      if (p.x > this.W - HALF_W) { p.x = this.W - HALF_W; if (p.vx > 0) p.vx = 0; }

      // Own crossbar bonk (goalie jumping under the bar).
      this._playerBarClamp(p);
    }

    _playerBarClamp(p) {
      // The goal's top is SOLID: the whole region above the crossbar
      // (y < TOP_Y) within the goal depth is a solid block. Collide the head
      // against that block, always pushing the player OUT (sideways into the
      // field) or DOWN (under the bar) — never up — so you can neither float on
      // top of the goal nor get the bar wedged through your body.
      const cx = p.x, cy = p.y - HEAD_CY, rr = HEAD_R, T = this.TOP_Y;
      // Left goal block: x <= GOAL_DEPTH. Right goal block: x >= W - GOAL_DEPTH.
      const goals = [
        { edge: GOAL_DEPTH, inside: cx <= GOAL_DEPTH, out: 1 },              // push +x into field
        { edge: this.W - GOAL_DEPTH, inside: cx >= this.W - GOAL_DEPTH, out: -1 }, // push -x
      ];
      for (let i = 0; i < goals.length; i++) {
        const g = goals[i];
        const distX = (g.out > 0) ? (g.edge - cx) : (cx - g.edge); // >0 when inside the block's x-span
        if (cy <= T) {
          // Above the bar line.
          if (distX > -rr) {
            if (distX >= 0) {
              // Head is over the goal box, above the bar: eject the SHORT way —
              // out the front face or down under the bar, whichever is closer.
              const pushOut = distX + rr;
              const pushDown = (T - cy) + rr;
              if (pushOut <= pushDown) { p.x += g.out * pushOut; if (p.vx * g.out < 0) p.vx = 0; }
              else { p.y += pushDown; if (p.vy < 0) p.vy = 0; }
            } else {
              // Head is in front of the post but overlapping it: push out sideways.
              const pen = rr + distX; // distX in (-rr, 0)
              p.x += g.out * pen; if (p.vx * g.out < 0) p.vx = 0;
            }
          }
        } else {
          // Below the bar line: only the top-front corner is solid here.
          if (distX >= 0) {
            // Directly under the bar → keeper head bonk (push down).
            const pen = rr - (cy - T);
            if (pen > 0) { p.y += pen; if (p.vy < 0) p.vy = 0; }
          } else {
            // In front, near the corner → round off the corner (push away+down).
            const ddx = -distX, ddy = cy - T; // ddx>0 out into field
            const dd = Math.hypot(ddx, ddy);
            if (dd < rr && dd > 0) {
              const ux = (ddx / dd) * g.out, uy = ddy / dd, pen = rr - dd;
              p.x += ux * pen; p.y += uy * pen;
              const vn = p.vx * ux + p.vy * uy;
              if (vn < 0) { p.vx -= vn * ux; p.vy -= vn * uy; }
            }
          }
        }
      }
    }

    _separatePlayers() {
      const ps = this.players;
      for (let i = 0; i < ps.length; i++) {
        for (let j = i + 1; j < ps.length; j++) {
          const a = ps[i], b = ps[j];
          // Opponents pass THROUGH each other — no body-blocking. Only keep
          // TEAMMATES from stacking on the exact same spot (matters in 2v2).
          if (a.team !== b.team) continue;
          // Height-aware: a player jumping clearly above another passes over
          // them (you can leap over a body) instead of being shoved aside.
          if (Math.abs(a.y - b.y) > 80) continue;
          const dx = b.x - a.x;
          const minD = BODY_R * 1.7;
          if (Math.abs(dx) < minD) {
            const overlap = (minD - Math.abs(dx)) / 2;
            const s = dx < 0 ? -1 : 1;
            a.x -= s * overlap;
            b.x += s * overlap;
            // Damp their closing speed a touch.
            const avg = (a.vx + b.vx) / 2;
            a.vx = a.vx * 0.4 + avg * 0.6;
            b.vx = b.vx * 0.4 + avg * 0.6;
          }
        }
      }
    }

    _stepBall(dt) {
      const b = this.ball;
      // Reset each step; set true by any player contact below (kick / head /
      // body / leg). The host uses this to detect a ball nobody is touching.
      b.touchedThisStep = false;
      // Kicks (do this before integration so a well-timed boot is crisp).
      for (const p of this.players) {
        if (p.kick > 0 && !p.kicked) {
          const foot = this._footTip(p);
          const dx = b.x - foot.x, dy = b.y - foot.y;
          const d = Math.hypot(dx, dy);
          if (d < b.r + FOOT_R) {
            p.kicked = true;
            b.touchedThisStep = true;
            b.vx = p.facing * KICK_VX + p.vx * 0.35;
            b.vy = -KICK_VY + p.vy * 0.3;
            // Contact angle: striking from under the ball (dy < 0) adds loft;
            // catching it high drives it flatter.
            if (d > 0.01) { b.vx += (dx / d) * 120; b.vy += (dy / d) * KICK_LIFT; }
          }
        }
      }

      // Gravity + drag.
      b.vy += BALL_G * dt;
      b.vx *= Math.exp(-BALL_DRAG * dt);
      // Cap speed.
      const sp = Math.hypot(b.vx, b.vy);
      if (sp > BALL_MAX) { b.vx *= BALL_MAX / sp; b.vy *= BALL_MAX / sp; }

      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.spin += b.vx * dt * 0.06;

      // Swept anti-tunnel (runs BEFORE the normal resolution): if the ball
      // flipped to the FAR side of any player circle in this one step — a fast
      // shot, or an opponent shoving a ball that was resting against a defender
      // — snap it back to the side it came from. Uses motion relative to the
      // player, so it also catches a player running the ball into another.
      for (const p of this.players) {
        this._sweepBallVsCircle(b, p, HEAD_CY, HEAD_R);
        this._sweepBallVsCircle(b, p, BODY_CY, BODY_R);
        this._sweepBallVsCircle(b, p, LEG_CY, LEG_R);
      }

      // Ball vs player head + body + legs (headers / bumps / dash body-checks).
      // Order matters: body runs before legs. When the body deflects a ball it
      // pushes it out past the leg circle's reach, so the leg never double-hits;
      // the leg only ever resolves a ball the body missed (the shin-band gap).
      for (const p of this.players) {
        this._ballVsCircle(b, p, p.x, p.y - HEAD_CY, HEAD_R, REST_HEAD, true);
        this._ballVsCircle(b, p, p.x, p.y - BODY_CY, BODY_R, REST_BODY, false);
        this._ballVsCircle(b, p, p.x, p.y - LEG_CY, LEG_R, REST_BODY, false, true);
      }

      // Ceiling.
      if (b.y - b.r < CEIL_Y) { b.y = CEIL_Y + b.r; if (b.vy < 0) b.vy = -b.vy * WALL_REST; }

      // Ground + rolling friction.
      if (b.y + b.r > this.GROUND_Y) {
        b.y = this.GROUND_Y - b.r;
        if (b.vy > 0) b.vy = -b.vy * GROUND_REST;
        if (Math.abs(b.vy) < 40) b.vy = 0;
        b.vx *= Math.exp(-ROLL_FRIC * dt);
      }

      // Crossbars (both goals) — segment collision.
      this._ballVsBar(b, 0, GOAL_DEPTH);
      this._ballVsBar(b, this.W - GOAL_DEPTH, this.W);

      // Side walls + goal detection.
      const scored = this._ballVsSidesAndGoals(b);
      return scored;
    }

    _footTip(p) {
      const s = 1 - Math.max(0, p.kick) / KICK_DUR; // 0..1 through the swing
      const swing = Math.sin(clamp(s / 0.6, 0, 1) * Math.PI / 2);
      return {
        x: p.x + p.facing * (26 + 62 * swing),
        y: p.y - 20 - 46 * swing,
      };
    }

    // Swept guard: if, in ONE step, the ball crossed to the OPPOSITE side of a
    // player circle (and its path actually pierced that circle), keep it on the
    // side it approached from. Motion is measured relative to the player, so it
    // works whether the ball was shot fast or an opponent ran it into a player.
    // It deliberately does nothing for normal contacts (ball ends on the same
    // side) or a lob that arcs AROUND the circle, so headers/dribbling/lobs are
    // unaffected.
    _sweepBallVsCircle(b, p, cyOff, cr) {
      const R = cr + b.r;
      const sx = b.prevX - p.prevX, sy = b.prevY - (p.prevY - cyOff);
      const ex = b.x - p.x, ey = b.y - (p.y - cyOff);
      // Only when the ball flipped to the opposite side of the player centre.
      if (sx * ex + sy * ey >= 0) return;
      // Only when the travelled segment actually passed through the solid circle
      // (closest approach to the centre is inside R) — not an arc around it.
      const dx = ex - sx, dy = ey - sy;
      const a = dx * dx + dy * dy;
      let t = a > 1e-6 ? -(sx * dx + sy * dy) / a : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ccx = sx + t * dx, ccy = sy + t * dy;
      if (ccx * ccx + ccy * ccy >= R * R) return;
      // Put the ball back on the approach side, at the circle surface.
      let nx, ny;
      const slen = Math.hypot(sx, sy);
      if (slen > 1e-3) { nx = sx / slen; ny = sy / slen; }
      else { const el = Math.hypot(ex, ey) || 1; nx = -ex / el; ny = -ey / el; }
      b.x = p.x + nx * R;
      b.y = (p.y - cyOff) + ny * R;
      // Remove the velocity heading into the player (relative), with a light bounce.
      const rvn = (b.vx - p.vx) * nx + (b.vy - p.vy) * ny;
      if (rvn < 0) { const rest = 0.5; b.vx -= (1 + rest) * rvn * nx; b.vy -= (1 + rest) * rvn * ny; }
      b.touchedThisStep = true;
    }

    _ballVsCircle(b, p, cx, cy, cr, rest, isHead, isLeg) {
      const pvx = p.vx, pvy = p.vy;
      const dx = b.x - cx, dy = b.y - cy;
      const d = Math.hypot(dx, dy);
      const min = cr + b.r;
      if (d >= min || d === 0) return;
      // Any overlap with a body part counts as a touch (keeps a ball pinned to a
      // player from tripping the host's untouched-ball watchdog).
      b.touchedThisStep = true;
      let nx = dx / d, ny = dy / d;
      // Dash body-check first: a committed power shot beats everything.
      if (p.dash > 0 && (nx * p.dashDir) > -0.35) {
        b.x = cx + nx * min;
        b.y = cy + ny * min;
        // The strike connects ONCE and is spent — the player recoils so the ball
        // can't glue to their leading edge for the rest of the dash.
        b.vx = p.dashDir * DASH_HIT_VX + pvx * 0.2;
        b.vy = -DASH_HIT_LIFT + Math.min(0, b.vy) * 0.3;
        p.dash = 0;
        p.vx *= 0.4;
        return;
      }
      // Ball resting/rolling on the ground with a player circle pressing down on
      // it (ny > 0). Never separate it DOWNWARD (that wedges/jitters it) — resolve
      // horizontally. A GROUNDED player is a solid vertical foot-wall (block flat
      // shots the way they came, dribble the ball ahead); an AIRBORNE player only
      // GRAZING the ball gets a light nudge so it doesn't visibly "jump" when a
      // jumping foot brushes past.
      if ((b.y + b.r) >= this.GROUND_Y - 3 && ny > 0) {
        // The leg circle never handles ground balls — those belong to the body
        // circle's foot-wall (already run this step), which keeps dribbling and
        // the airborne-graze nudge exactly as tuned (no double-handling).
        if (isLeg) return;
        b.y = this.GROUND_Y - b.r;
        // Push the ball out to the side it is ACTUALLY on (its real position),
        // never a velocity guess. The swept guard already guarantees the ball
        // is on the side it approached from, so this can't fling it across the
        // body. (The old velocity-based "block the way it came" could teleport a
        // ball that had bounced and was already leaving — unrealistic.)
        const sideX = dx < 0 ? -1 : dx > 0 ? 1 : (p.facing || 1);
        if (p.grounded) {
          b.x = cx + sideX * min;
          if (b.vx * sideX < 0) b.vx = -b.vx * rest;   // moving INTO the player → bounce back out
          b.vx += pvx * 0.30;                          // a little carry so you can still dribble
          if (b.vx * sideX < 120) b.vx = sideX * 120;  // gentle guaranteed clearance off the feet
        } else {
          // Airborne graze: push out only by the actual overlap, softly — no big
          // teleport and no velocity kick, so the ball just gets brushed.
          const horiz = Math.sqrt(Math.max(1, min * min - (b.y - cy) * (b.y - cy)));
          b.x = cx + sideX * horiz;
          if (b.vx * sideX < 0) b.vx = -b.vx * rest * 0.6;
          b.vx += pvx * 0.15;
        }
        b.spin = b.vx * 0.02;
        return;
      }
      // Normal (aerial) resolution: headers, body deflections, bumps. The ball
      // is pushed straight out along the GEOMETRIC contact normal — no
      // velocity-based normal flipping / side-swapping (that was an unrealistic
      // hack). The ball can never pass through a player because the swept guard
      // (_sweepBallVsCircle) already kept it on the side it approached from.
      b.x = cx + nx * min;
      b.y = cy + ny * min;
      // Relative velocity along the normal.
      const rvn = (b.vx - pvx) * nx + (b.vy - pvy) * ny;
      if (rvn < 0) {
        const j = -(1 + rest) * rvn;
        b.vx += j * nx;
        b.vy += j * ny;
      }
      // Carry some of the player's motion (running/jumping into the ball). A
      // rising body (jumping up) lofts the ball, so skimming it on the way up
      // flicks it up on an angle — the classic head-soccer body deflection.
      b.vx += pvx * 0.30;
      b.vy += pvy * (isHead ? 0.42 : 0.40);
      // Bumper pop: even a glancing skim leaves the round surface at the contact
      // angle with a guaranteed minimum speed, so contacts never feel dead.
      const minPop = isHead ? 70 : 150;
      const outSp = b.vx * nx + b.vy * ny;
      if (outSp < minPop) { const add = minPop - outSp; b.vx += nx * add; b.vy += ny * add; }
    }

    _ballVsBar(b, x0, x1) {
      // Horizontal bar segment at y = TOP_Y from x0..x1, thickness BAR_THICK.
      const nx = clamp(b.x, x0, x1);
      const ny = this.TOP_Y;
      const dx = b.x - nx, dy = b.y - ny;
      const d = Math.hypot(dx, dy);
      const min = b.r + BAR_THICK;
      if (d >= min || d === 0) return;
      const ux = dx / d, uy = dy / d;
      b.x = nx + ux * min;
      b.y = ny + uy * min;
      const vn = b.vx * ux + b.vy * uy;
      if (vn < 0) { b.vx -= (1 + BAR_REST) * vn * ux; b.vy -= (1 + BAR_REST) * vn * uy; }
    }

    _ballVsSidesAndGoals(b) {
      // A goal counts the instant the WHOLE ball has crossed the goal line
      // (the front of the net, x = GOAL_DEPTH) below the crossbar — not only
      // when it reaches the screen edge.
      if (b.y > this.TOP_Y) {
        if (b.x + b.r <= GOAL_DEPTH) return 'blue';        // fully in the left net
        if (b.x - b.r >= this.W - GOAL_DEPTH) return 'red';     // fully in the right net
      }
      // Solid side walls / back of the net (bounce).
      if (b.x - b.r < 0) { b.x = b.r; if (b.vx < 0) b.vx = -b.vx * WALL_REST; }
      if (b.x + b.r > this.W) { b.x = this.W - b.r; if (b.vx > 0) b.vx = -b.vx * WALL_REST; }
      return null;
    }
  }

  window.SoccerHead = { World, W, H, GROUND_Y, GOAL_H, GOAL_DEPTH, TOP_Y };
})();
