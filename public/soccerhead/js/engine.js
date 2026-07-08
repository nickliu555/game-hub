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
  // A touch wider than tall-square so there's a bit more midfield room without
  // letterboxing into a thin strip on a 16:9 screen.
  const W = 1600, H = 600;
  const GROUND_Y = 540;
  const CEIL_Y = 0;
  // A shorter, properly DEFENDABLE goal: a keeper covers the bottom standing and
  // the rest with a jump, so goals are earned by beating them out of position —
  // not by lobbing into a giant open net. Crossbar y=300; standing head-top ≈ y390.
  const GOAL_H = 240;
  const GOAL_DEPTH = 84;
  const TOP_Y = GROUND_Y - GOAL_H; // crossbar y = 270
  const BAR_THICK = 9;
  const GOAL_LINE_L = GOAL_DEPTH * 0.55;
  const GOAL_LINE_R = W - GOAL_DEPTH * 0.55;

  // ---- Ball ----
  const BALL_R = 22;
  const BALL_G = 2100;
  const BALL_DRAG = 0.11;      // more air drag → shots bleed speed, keepers get time
  const GROUND_REST = 0.56;
  const WALL_REST = 0.72;
  const BAR_REST = 0.68;
  const ROLL_FRIC = 1.4;       // horizontal decay while rolling on ground
  // Kicks land ~730 so they stay saveable; the higher cap only lets a committed
  // DASH body-check (below) fire off a genuinely fast, cooldown-gated cannon.
  const BALL_MAX = 1850;
  const REST_HEAD = 0.72;
  const REST_BODY = 0.74;

  // ---- Player ----
  // Slightly shorter character so there is clear air to lob the ball over a
  // standing defender and drop it under the tall crossbar.
  const HEAD_R = 40, HEAD_CY = 110;
  const BODY_R = 34, BODY_CY = 58;
  const HALF_W = 34;           // wall clamp half-width
  const GRAVITY = 2650, FALL_MULT = 1.35, MAX_FALL = 1750;
  // A big defensive leap tuned to the (lowered) goal height: a full jump carries
  // the feet up to about the crossbar (TOP_Y = 300). apex rise =
  // JUMP_V^2/(2*GRAVITY) = 1120^2/5300 ≈ 237px ≈ GOAL_H, so you can just spring up
  // to the top of the goal to defend or head high balls. (Near your own goal the
  // bar clamp still caps your head at the crossbar so you can't fly out the top.)
  const JUMP_V = 1120;
  const MOVE_ACCEL = 6200, MAX_SPEED = 440;
  const AIR_ACCEL = 3500, AIR_DAMP = 0.5, GROUND_DAMP = 16;
  const JUMP_BUFFER = 0.12, COYOTE = 0.09;
  // A real dash: a big, snappy lunge (~2.6x run speed) so it clearly reads as a
  // burst. Dashing INTO the ball is a POWER body-check (see DASH_HIT_*) — a hard
  // cannon in the dash direction, far faster than any kick, not the soft "carry"
  // of a walk-in.
  const DASH_SPEED = 1150, DASH_DUR = 0.18, DASH_CD = 2.2;
  const DASH_HIT_VX = 1750, DASH_HIT_LIFT = 300;
  // A loftier boot: a big upward component so you can chip the ball up and over
  // a defender. Softer forward drive + a longer cooldown so it's a deliberate
  // shot, not a rapid-fire cannon that keepers can't react to.
  const KICK_DUR = 0.30, KICK_CD = 0.52, FOOT_R = 30, KICK_VX = 830, KICK_VY = 1040, KICK_LIFT = 190;

  // ---- Goal keep-out ----
  // An attacker can't crowd the mouth of the goal they're attacking, so you
  // can't shove a defender back into their own net. Only limits the approach to
  // the OPPONENT'S goal — you can still retreat fully into your own end.
  const GOAL_KEEPOUT = 140;

  // ---- Stuck-ball (jam) detection ----
  // When two opposing players trap the ball between them and neither will back
  // off to clear it, we lift a fresh ball high above the standoff. Keyed on
  // HORIZONTAL confinement (the ball makes no lateral progress) while a player
  // from each team contests it — vertical pops from stubborn kicking are ignored,
  // so a booted-back-and-forth ball still counts. Conservative time window so it
  // never fires during normal play, where the ball travels out of the band fast.
  const JAM_TIME = 0.9;        // sustained seconds confined + contested (quicker to fire)
  const JAM_BALL_RANGE = 140;  // ball must stay within this horizontal band
  const JAM_PINCH_X = 140;     // a contesting player this close (horizontally) to the ball
  const JAM_STANDOFF = 180;    // the two opponents are within this of each other
  const JAM_DROP_HANG = 0.9;   // seconds the fresh ball hovers in the air before it falls

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
    };
  }

  class World {
    constructor(opts) {
      opts = opts || {};
      this.mode = opts.mode || '1v1';
      this.field = { W, H, GROUND_Y, CEIL_Y, GOAL_H, GOAL_DEPTH, TOP_Y, BAR_THICK, BALL_R, HEAD_R, HEAD_CY, BODY_R, BODY_CY };
      this.players = [];
      this.byId = new Map();
      this.ball = { x: W / 2, y: 210, vx: 0, vy: 0, r: BALL_R, spin: 0, hold: 0 };
      this.frozen = true;
      // Stuck-ball detection scratch + a one-shot signal for the host to cue.
      this._jamTime = 0; this._jamAnchorX = 0;
      this.pendingBallDrop = null;
    }

    setRoster(roster) {
      this.players = [];
      this.byId = new Map();
      const spawnX = {
        red: [W * 0.30, W * 0.15],
        blue: [W * 0.70, W * 0.85],
      };
      for (const r of roster) {
        const x = spawnX[r.team][r.seat] || (r.team === 'red' ? W * 0.28 : W * 0.72);
        const p = makePlayer({ id: r.id, name: r.name, team: r.team, seat: r.seat, x });
        this.players.push(p);
        this.byId.set(r.id, p);
      }
    }

    kickoff(towardTeam) {
      // Reset every character to its spawn and drop the ball at centre. If a
      // team is given the ball nudges slightly toward the conceding side.
      const spawnX = { red: [W * 0.30, W * 0.15], blue: [W * 0.70, W * 0.85] };
      for (const p of this.players) {
        p.x = spawnX[p.team][p.seat] || (p.team === 'red' ? W * 0.28 : W * 0.72);
        p.y = GROUND_Y; p.vx = 0; p.vy = 0; p.grounded = true;
        p.left = p.right = p.jumpHeld = false;
        p.jumpBuffer = 0; p.kick = 0; p.kicked = false; p.kickQueued = false;
        p.dash = 0;
      }
      this.ball.x = W / 2;
      this.ball.y = 210;
      // Give the conceding team a fair restart: nudge the ball toward the goal
      // they attack (red attacks +x, blue -x), rather than the scorer's favour.
      this.ball.vx = towardTeam === 'red' ? 60 : towardTeam === 'blue' ? -60 : 0;
      this.ball.vy = 0;
      this.ball.spin = 0;
      this.ball.hold = 0;
      this._jamTime = 0; this.pendingBallDrop = null;
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
      for (const p of this.players) this._stepPlayer(p, dt);
      // Player-vs-player soft separation (keeps bodies from overlapping).
      this._separatePlayers();
      const scored = this._stepBall(dt);
      if (scored) return scored;
      // Break up a genuine ball jam between two opposing players (but not while a
      // freshly dropped-in ball is still hovering).
      if (!(this.ball.hold > 0)) this._detectJam(dt);
      return null;
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
      if (p.y >= GROUND_Y) {
        p.y = GROUND_Y;
        if (p.vy > 0) p.vy = 0;
        if (!p.grounded) { p.grounded = true; }
        p.coyote = COYOTE;
      } else {
        p.grounded = false;
      }

      // Side walls.
      if (p.x < HALF_W) { p.x = HALF_W; if (p.vx < 0) p.vx = 0; }
      if (p.x > W - HALF_W) { p.x = W - HALF_W; if (p.vx > 0) p.vx = 0; }

      // Goal keep-out: don't let an attacker crowd the mouth of the goal they
      // attack (red attacks the right goal, blue the left), so nobody can be
      // shoved back into their own net. The defender's own approach is free.
      if (p.team === 'red') {
        const limit = (W - GOAL_DEPTH) - GOAL_KEEPOUT - HALF_W;
        if (p.x > limit) { p.x = limit; if (p.vx > 0) p.vx = 0; }
      } else {
        const limit = GOAL_DEPTH + GOAL_KEEPOUT + HALF_W;
        if (p.x < limit) { p.x = limit; if (p.vx < 0) p.vx = 0; }
      }

      // Own crossbar bonk (goalie jumping under the bar).
      this._playerBarClamp(p);
    }

    _playerBarClamp(p) {
      // Left bar spans x in [0, GOAL_DEPTH]; right bar mirrored.
      const headCY = p.y - HEAD_CY;
      const nearLeft = p.x <= GOAL_DEPTH + HEAD_R;
      const nearRight = p.x >= W - GOAL_DEPTH - HEAD_R;
      if (!nearLeft && !nearRight) return;
      const headTop = headCY - HEAD_R;
      // Only clamp when head is rising into the underside of the bar.
      if (headTop < TOP_Y && headCY > TOP_Y - HEAD_R) {
        p.y = TOP_Y + HEAD_R + HEAD_CY;
        if (p.vy < 0) p.vy = 0;
      }
    }

    _separatePlayers() {
      const ps = this.players;
      for (let i = 0; i < ps.length; i++) {
        for (let j = i + 1; j < ps.length; j++) {
          const a = ps[i], b = ps[j];
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

    _detectJam(dt) {
      const b = this.ball;
      // Closest contesting player from EACH team near the ball (horizontally).
      let redX = null, blueX = null;
      for (const p of this.players) {
        const adx = Math.abs(p.x - b.x);
        if (adx > JAM_PINCH_X) continue;
        if (p.team === 'red') { if (redX === null || adx < Math.abs(redX - b.x)) redX = p.x; }
        else { if (blueX === null || adx < Math.abs(blueX - b.x)) blueX = p.x; }
      }
      const contested = redX !== null && blueX !== null && Math.abs(redX - blueX) <= JAM_STANDOFF;
      // Confinement: the ball has made no real lateral progress from the anchor.
      if (this._jamTime <= 0) this._jamAnchorX = b.x;
      const drifted = Math.abs(b.x - this._jamAnchorX) > JAM_BALL_RANGE;
      if (!contested || drifted) {
        // Not (or no longer) a jam — follow the ball and reset the clock.
        this._jamAnchorX = b.x;
        this._jamTime = 0;
        return;
      }
      this._jamTime += dt;
      if (this._jamTime < JAM_TIME) return;
      // Jam confirmed — lift a fresh ball high above the standoff so it drops back
      // in neutrally and both players have time to reposition.
      const mx = (redX + blueX) / 2;
      b.x = mx; b.y = 120; b.vx = 0; b.vy = 0; b.spin = 0;
      b.hold = JAM_DROP_HANG;
      this.pendingBallDrop = { x: mx, y: 120 };
      this._jamTime = 0;
    }

    _stepBall(dt) {
      const b = this.ball;
      // A freshly dropped-in ball hangs in the air briefly so both players can
      // see it and get set before it falls.
      if (b.hold > 0) { b.hold -= dt; b.vx = 0; b.vy = 0; return null; }
      // Kicks (do this before integration so a well-timed boot is crisp).
      for (const p of this.players) {
        if (p.kick > 0 && !p.kicked) {
          const foot = this._footTip(p);
          const dx = b.x - foot.x, dy = b.y - foot.y;
          const d = Math.hypot(dx, dy);
          if (d < b.r + FOOT_R) {
            p.kicked = true;
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

      // Ball vs player head + body (headers / bumps / dash body-checks).
      for (const p of this.players) {
        this._ballVsCircle(b, p, p.x, p.y - HEAD_CY, HEAD_R, REST_HEAD, true);
        this._ballVsCircle(b, p, p.x, p.y - BODY_CY, BODY_R, REST_BODY, false);
      }

      // Ceiling.
      if (b.y - b.r < CEIL_Y) { b.y = CEIL_Y + b.r; if (b.vy < 0) b.vy = -b.vy * WALL_REST; }

      // Ground + rolling friction.
      if (b.y + b.r > GROUND_Y) {
        b.y = GROUND_Y - b.r;
        if (b.vy > 0) b.vy = -b.vy * GROUND_REST;
        if (Math.abs(b.vy) < 40) b.vy = 0;
        b.vx *= Math.exp(-ROLL_FRIC * dt);
      }

      // Crossbars (both goals) — segment collision.
      this._ballVsBar(b, 0, GOAL_DEPTH);
      this._ballVsBar(b, W - GOAL_DEPTH, W);

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

    _ballVsCircle(b, p, cx, cy, cr, rest, isHead) {
      const pvx = p.vx, pvy = p.vy;
      const dx = b.x - cx, dy = b.y - cy;
      let d = Math.hypot(dx, dy);
      const min = cr + b.r;
      if (d >= min || d === 0) return;
      const nx = dx / d, ny = dy / d;
      // Separate.
      b.x = cx + nx * min;
      b.y = cy + ny * min;
      // Dash body-check: a genuine power shot in the dash direction (with lift),
      // not the soft carry of a walk-in. Only when the contact is roughly along
      // the dash so you can't hit a ball that's behind you.
      if (p.dash > 0 && (nx * p.dashDir) > -0.35) {
        // The strike connects ONCE and is spent — the player recoils so the ball
        // can't glue to their leading edge for the rest of the dash.
        b.vx = p.dashDir * DASH_HIT_VX + pvx * 0.2;
        b.vy = -DASH_HIT_LIFT + Math.min(0, b.vy) * 0.3;
        p.dash = 0;
        p.vx *= 0.4;
        return;
      }
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
      const ny = TOP_Y;
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
      if (b.y > TOP_Y) {
        if (b.x + b.r <= GOAL_DEPTH) return 'blue';        // fully in the left net
        if (b.x - b.r >= W - GOAL_DEPTH) return 'red';     // fully in the right net
      }
      // Solid side walls / back of the net (bounce).
      if (b.x - b.r < 0) { b.x = b.r; if (b.vx < 0) b.vx = -b.vx * WALL_REST; }
      if (b.x + b.r > W) { b.x = W - b.r; if (b.vx > 0) b.vx = -b.vx * WALL_REST; }
      return null;
    }
  }

  window.SoccerHead = { World, W, H, GROUND_Y, GOAL_H, GOAL_DEPTH, TOP_Y };
})();
