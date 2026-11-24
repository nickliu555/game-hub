'use strict';

// Rules tests for Egyptian Ratscrew's engine (server/ratscrew/game.js).
// Timers are stepped by hand (manualTimers + tick()), and the play lock is
// lifted explicitly, so every rule is checked deterministically.
//
//   node scripts/test-ratscrew-engine.js   (or: npm run test:ratscrew)

const { Game, PHASES, slapPattern, PLAY_LOCK_MS } = require('../server/ratscrew/game');

let failed = false;
function check(cond, msg) {
  if (cond) console.log('  ✓ ' + msg);
  else { failed = true; console.log('  ✗ ' + msg); }
}
function section(t) { console.log('\n— ' + t); }

/** A started game with `n` players whose decks are then replaced by `decks`. */
function setup(decks, opts) {
  const g = new Game(42);
  g.manualTimers = true;
  if (opts && opts.flush === false) g.setFlush(false);
  decks.forEach((_, i) => g.addPlayer({ playerId: 'p' + i, name: 'P' + i, socketId: 's' + i }));
  g.start();
  decks.forEach((d, i) => { g.players.get('p' + i).deck = d.slice(); });
  g.turnId = 'p' + ((opts && opts.turn) || 0);
  g.nextPlayAt = 0;
  return g;
}
function play(g, id) { g.nextPlayAt = 0; return g.play(id); }
function count(g, id) { return g.players.get(id).deck.length; }
function lastEvent(g, type) { return g.events.filter((e) => e.type === type).pop(); }

section('Slap patterns');
check(slapPattern(['5H', '5S'], { flush: true }) === 'double', 'two of a rank in a row is a Double');
check(slapPattern(['9C', '5H', '9D'], { flush: true }) === 'sandwich', 'same rank with one between is a Sandwich');
check(slapPattern(['2H', '7H', 'KH'], { flush: true }) === 'flush', 'three of a suit in a row is a Flush');
check(slapPattern(['2H', '7H', 'KH'], { flush: false }) === null, 'no Flush when the rule is off');
check(slapPattern(['7H', 'KH'], { flush: true }) === null, 'two of a suit is not a Flush');
check(slapPattern(['3C', '7H', 'KH'], { flush: true }) === null, 'a broken run of suits is not a Flush');
check(slapPattern(['10H', '10S', '10C'], { flush: true }) === 'double', 'three of a kind reads as a Double');
check(slapPattern(['QH'], { flush: true }) === null, 'one card is never a slap');
check(slapPattern(['4H', '6H', '10D'], { flush: true }) === null, 'no Tens rule');

section('Deal');
{
  const g = new Game(7);
  g.manualTimers = true;
  ['a', 'b', 'c'].forEach((id) => g.addPlayer({ playerId: id, name: id, socketId: id }));
  check(g.start().ok, 'starts with 3 players');
  const counts = g.seatOrder().map((p) => p.deck.length);
  check(counts.join(',') === '18,17,17', 'the whole deck is dealt, odd cards from the opener (' + counts + ')');
  const all = new Set(g.seatOrder().flatMap((p) => p.deck));
  check(all.size === 52, 'every card dealt exactly once');
  check(g.turnId === 'a', 'the first seat opens');
  const r = g.play('a');
  check(!r.ok && r.reason === 'too-soon', 'nobody plays while the deal is on the table');
}

section('Play lock and turns');
{
  const g = setup([['2H', '3H'], ['4C', '5C'], ['6D', '7D']]);
  check(play(g, 'p0').ok, 'p0 plays');
  check(g.pile.join() === '2H' && g.turnId === 'p1', 'card on the pile, turn passes clockwise');
  const early = g.play('p1');
  check(!early.ok && early.reason === 'too-soon' && early.retryInMs > PLAY_LOCK_MS - 200, 'the next card waits ' + PLAY_LOCK_MS + 'ms');
  check(!g.play('p2').ok, 'out of turn is refused');
}

section('Face-card challenges');
{
  const g = setup([['KH', '2C'], ['3D', '4D', '5D', '6D'], ['7S', '8S']]);
  play(g, 'p0');
  check(g.challenge && g.challenge.byId === 'p0' && g.challenge.left === 3, 'a King gives the next player 3 tries');
  check(g.turnId === 'p1', 'the next player answers');
  play(g, 'p1'); play(g, 'p1');
  check(g.turnId === 'p1' && g.challenge.left === 1, 'the answering player keeps playing while tries remain');
  play(g, 'p1');
  check(g.claim && g.claim.byId === 'p0' && g.claim.reason === 'challenge' && g.turnId === null, 'tries used up: the challenger has the pile on hold');
  check(!g.play('p1').ok && !g.play('p0').ok, 'nobody plays while the pile is on hold');
  g.tick();
  check(count(g, 'p0') === 5 && g.pile.length === 0, 'the challenger collects all 4 cards');
  check(g.turnId === 'p0', 'the challenger leads next');
  check(g.players.get('p0').deck.slice(1).join() === 'KH,3D,4D,5D', 'the pile goes under their deck in order');
}
{
  const g = setup([['QH', '2C'], ['3D', 'JD', '5D'], ['7S', '8S']]);
  play(g, 'p0'); play(g, 'p1'); play(g, 'p1');
  check(g.challenge && g.challenge.byId === 'p1' && g.challenge.left === 1 && g.turnId === 'p2', 'answering with a face card passes the challenge on');
}
{
  const g = setup([['AH', '2C'], ['3D', '4D', '5D', '6D', '7D'], ['7S', '8S']]);
  play(g, 'p0');
  play(g, 'p1'); play(g, 'p1'); play(g, 'p1'); play(g, 'p1');
  check(g.claim && g.claim.byId === 'p0', 'an Ace gives 4 tries');
}

section('Slaps');
{
  const g = setup([['5H', '2C', '9C'], ['5S', '4D', '8D'], ['7S', '8S', '9S']]);
  play(g, 'p0'); play(g, 'p1');
  const r = g.slap('p2');
  check(r.ok && r.result === 'good' && r.pattern === 'double', 'a Double slap is good');
  check(g.claim && g.claim.byId === 'p2' && g.claim.reason === 'slap', 'the pile is held for the slapper');
  const late = g.slap('p0');
  check(late.ok && late.result === 'late' && late.byId === 'p2', 'a second slap is just late — no penalty');
  check(count(g, 'p0') === 2, 'the late slapper keeps their cards');
  g.tick();
  check(count(g, 'p2') === 5 && g.turnId === 'p2', 'the slapper takes the pile and leads');
}
{
  const g = setup([['5H', '2C', '9C'], ['6S', '4D', '8D', 'KC'], ['7S', '8S', '9S']]);
  play(g, 'p0');
  const r = g.slap('p1');
  check(r.ok && r.result === 'bad' && r.burned === 2 && r.toId === 'p0', 'a wrong slap pays 2 to the player whose card it was');
  check(count(g, 'p1') === 2 && count(g, 'p0') === 4 && g.players.get('p0').deck.slice(-2).join() === '6S,4D' && g.pile.join() === '5H', 'onto the bottom of their deck; the pile is untouched');
  check(g.turnId === 'p1', 'the turn does not change');
  const again = g.slap('p1');
  check(again.ok && again.result === 'late' && count(g, 'p1') === 2, 'a second slap on the same card is ignored — nothing more burned');
  const other = g.slap('p2');
  check(other.ok && other.result === 'late' && other.byId === 'p1' && other.good === false && count(g, 'p2') === 3, "so is anyone else's, until the next card");
  check(g.getTablePublic().slapped.byId === 'p1', 'the table shows who slapped this card');
  play(g, 'p1');
  g.players.get('p1').lastSlapAt = 0;
  g.players.get('p2').deck.unshift('8D');
  play(g, 'p2');
  check(g.currentPattern() === 'double', 'slaps reopen on the next card');
  g.slap('p2'); g.tick();
  check(count(g, 'p2') === 3 + 3, 'the slapper wins the 3 cards on the pile');
}
{
  const g = setup([['5H', '2C', '9C'], ['6S', '4D', '8D'], ['7S', '8S', '9S']]);
  play(g, 'p0');
  const r = g.slap('p0');
  check(r.result === 'bad' && r.toId === 'p1' && count(g, 'p1') === 5 && count(g, 'p0') === 0, 'slapping your own card pays the next player');
}
{
  const g = setup([['2H'], ['3D', '4D', '5D'], ['6S', '7S', '8S']], { turn: 0 });
  play(g, 'p0');
  check(g.players.get('p0').out, 'the card\'s owner went out');
  const r = g.slap('p2');
  check(r.toId === 'p1' && count(g, 'p1') === 5, 'a bad slap never pays a player who is out — it goes to the next one along');
}
{
  const g = setup([['2H', '9C'], ['7H', '9D'], ['KH', '9S']], { flush: false });
  play(g, 'p0'); play(g, 'p1'); play(g, 'p2');
  check(g.challenge && g.slap('p1').result === 'bad', 'with Flush off, three Hearts is a bad slap');
}
{
  const g = setup([['2H', '9C'], ['7H', '9D'], ['KH', '9S']]);
  play(g, 'p0'); play(g, 'p1'); play(g, 'p2');
  check(g.slap('p0').result === 'good', 'with Flush on, three Hearts is good');
}
{
  const g = setup([['KH', '2C'], ['3D', '4D', '5D'], ['3S', '8S']]);
  play(g, 'p0'); play(g, 'p1'); play(g, 'p1'); play(g, 'p1');
  check(g.claim && g.claim.reason === 'challenge', 'challenge lost');
  check(g.slap('p2').result === 'good' && g.claim.byId === 'p2', 'a good slap in the hold window steals the pile');
}
{
  const g = setup([['2H', '9C'], ['3D', '4D']]);
  check(!g.slap('p0').ok && g.slap('p0').reason === 'empty', 'slapping an empty pile is ignored');
}

section('Running out');
{
  const g = setup([['2H'], ['3D', '4D'], ['5S', '6S']]);
  play(g, 'p0');
  check(g.players.get('p0').out && g.players.get('p0').place === 3, 'playing your last card puts you out (3rd)');
  play(g, 'p1'); play(g, 'p2');
  check(g.turnId === 'p1', 'turns skip the player who is out');
  check(!g.slap('p0').ok, 'a player who is out cannot slap');
}
{
  const g = setup([['QH'], ['3D', '4D', '5D'], ['5S', '6S']]);
  play(g, 'p0');
  check(!g.players.get('p0').out, 'your last card a face card: still in while the challenge runs');
  check(!g.slap('p0').ok, 'but with no cards you cannot slap');
  play(g, 'p1'); play(g, 'p1');
  g.tick();
  check(!g.players.get('p0').out && count(g, 'p0') === 3, 'the challenge won brings them back with the pile');
}
{
  const g = setup([['QH'], ['3D', 'KD'], ['5S', '6S']]);
  play(g, 'p0'); play(g, 'p1'); play(g, 'p1');
  check(g.players.get('p0').out, 'a challenge answered with a face card knocks out a challenger on 0 cards');
}
{
  const g = setup([['KH', '2C'], ['3D'], ['5S', '6S']]);
  play(g, 'p0'); play(g, 'p1');
  check(g.players.get('p1').out && g.claim && g.claim.byId === 'p0' && g.claim.reason === 'runout', 'running out while answering loses the challenge');
}
{
  const g = setup([['5H', '9C'], ['6S', '4D'], ['7S', '8S']], { turn: 1 });
  g.pile = ['2C'];
  g.slap('p1');
  check(g.players.get('p1').out, 'burning your last cards puts you out');
  check(g.turnId === 'p2', 'and the turn moves on');
}

section('Winning');
{
  const g = setup([['2H'], ['3D', '4D']]);
  play(g, 'p0');
  check(g.ending && g.winnerId === 'p1', 'the last player holding cards wins');
  check(count(g, 'p1') === 3 && g.pile.length === 0, 'the winner takes the pile');
  check(lastEvent(g, 'win').playerId === 'p1', 'a win event is logged');
  check(!g.slap('p1').ok && !g.play('p1').ok, 'no more moves once it is over');
  g.tick();
  check(g.phase === PHASES.FINAL, 'then the final standings');
  const f = g.getFinalPublic();
  check(f.standings[0].playerId === 'p1' && f.standings[0].place === 1 && f.standings[1].place === 2, 'standings in finishing order');
  check(g.rematch().ok && g.phase === PHASES.PLAYING && g.seatOrder().every((p) => !p.out && p.deck.length === 26), 'rematch deals a fresh game to the same seats');
  check(g.turnId === 'p1', 'the opener moves one seat on in a rematch');
}

section('Secrecy');
{
  const g = setup([['2H', '3H'], ['4D', '5D']]);
  play(g, 'p0');
  const pub = JSON.stringify(g.getTablePublic());
  check(pub.indexOf('3H') < 0 && pub.indexOf('4D') < 0 && pub.indexOf('5D') < 0, 'no face-down card is ever in the public table');
}

section('Lobby');
{
  const g = new Game(1);
  check(g.flush === true, 'Flush is on by default');
  check(g.setFlush(false).ok && g.flush === false, 'the host can turn Flush off');
  check(!g.setFlush('no').ok, 'only true/false is accepted');
  for (let i = 0; i < 8; i++) g.addBot();
  check(!g.addBot().ok && g.players.size === 8, 'eight seats at most');
  g.start();
  check(!g.setFlush(true).ok, 'settings lock once the game starts');
  check(g.removePlayer('bot-1') === null, 'nobody can be kicked mid-game');
  g.reset();
  check(g.flush === true && g.players.size === 0, 'reset restores the defaults');
}

console.log(failed ? '\nFAILED' : '\nAll engine tests passed.');
process.exit(failed ? 1 : 0);
