import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const STARTING_CHIPS = 1000;
const MIN_BET = 10;
const REBUY_AMOUNT = 1000;
const NUM_DECKS = 6;
const BETTING_TIME_MS = 25000;
const TURN_TIME_MS = 30000;
const MAX_SEATS = 6;
const MAX_SPLIT_HANDS = 4;
const SIDE_PAY_EXACT = 10; // 10:1 jackpot on exact 13
const SIDE_PAY_ANY = 1;    // 1:1 on under/over

function buildShoe() {
  const cards = [];
  for (let d = 0; d < NUM_DECKS; d++) {
    for (const s of SUITS) for (const r of RANKS) cards.push({ r, s });
  }
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

function rankValue(r) {
  if (r === 'A') return 11;
  if (['K', 'Q', 'J'].includes(r)) return 10;
  return parseInt(r, 10);
}

function sideBetCardValue(r) {
  if (r === 'A') return 1;
  if (['K', 'Q', 'J'].includes(r)) return 10;
  return parseInt(r, 10);
}

function handTotal(cards) {
  let total = cards.reduce((a, c) => a + rankValue(c.r), 0);
  let aces = cards.filter((c) => c.r === 'A').length;
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return total;
}

function isBlackjack(cards) {
  return cards.length === 2 && handTotal(cards) === 21;
}

const game = {
  phase: 'waiting',
  players: new Map(),
  order: [],
  shoe: buildShoe(),
  dealer: { hand: [], hideHole: true },
  currentTurnIdx: -1,
  phaseEndsAt: 0,
  timer: null,
};

function draw() {
  if (game.shoe.length < 26) game.shoe = buildShoe();
  return game.shoe.pop();
}

function newHand(bet) {
  return { cards: [], bet, status: 'playing', result: null, doubled: false, fromSplit: false };
}

function isLocalhostAddr(addr) {
  if (!addr) return false;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function currentPlayerId() {
  return game.currentTurnIdx >= 0 ? game.order[game.currentTurnIdx] : null;
}

function publicState() {
  const curId = currentPlayerId();
  const players = game.order.map((id) => {
    const p = game.players.get(id);
    return {
      id,
      name: p.name,
      chips: p.chips,
      bet: p.bet,
      sideBets: p.sideBets,
      sideResults: p.sideResults,
      sideTotal: p.sideTotal,
      hands: p.hands.map((h, i) => ({
        cards: h.cards,
        total: h.cards.length ? handTotal(h.cards) : 0,
        bet: h.bet,
        status: h.status,
        result: h.result,
        doubled: h.doubled,
        fromSplit: h.fromSplit,
        isCurrent: id === curId && i === p.currentHandIdx,
      })),
      status: p.status,
      connected: p.connected,
      isHost: p.isHost,
    };
  });
  const dealerHand = game.dealer.hideHole && game.dealer.hand.length > 1
    ? [game.dealer.hand[0], { r: '?', s: '?' }]
    : game.dealer.hand;
  const dealerTotal = game.dealer.hideHole && game.dealer.hand.length > 1
    ? rankValue(game.dealer.hand[0].r)
    : handTotal(game.dealer.hand);
  return {
    phase: game.phase,
    players,
    dealer: { hand: dealerHand, total: dealerTotal, hideHole: game.dealer.hideHole },
    currentTurn: curId,
    phaseEndsAt: game.phaseEndsAt,
    minBet: MIN_BET,
  };
}

function broadcast() { io.emit('state', publicState()); }
function log(msg) { io.emit('log', { t: Date.now(), msg }); }
function clearTimer() { if (game.timer) { clearTimeout(game.timer); game.timer = null; } }
function setPhaseTimer(ms, fn) {
  clearTimer();
  game.phaseEndsAt = Date.now() + ms;
  game.timer = setTimeout(fn, ms);
}

function startBetting() {
  if (game.order.length === 0) {
    game.phase = 'waiting';
    game.phaseEndsAt = 0;
    clearTimer();
    broadcast();
    return;
  }
  game.phase = 'betting';
  game.dealer = { hand: [], hideHole: true };
  game.currentTurnIdx = -1;
  for (const id of game.order) {
    const p = game.players.get(id);
    p.hands = [];
    p.currentHandIdx = 0;
    p.bet = 0;
    p.sideBets = { under: 0, exact: 0, over: 0 };
    p.sideResults = null;
    p.sideTotal = null;
    p.status = p.chips >= MIN_BET ? 'betting' : 'idle';
  }
  log('Apuesten — 25 segundos.');
  setPhaseTimer(BETTING_TIME_MS, dealCards);
  broadcast();
}

function dealCards() {
  const active = game.order.filter((id) => game.players.get(id).bet > 0);
  if (active.length === 0) {
    log('Nadie apostó.');
    game.phase = 'waiting';
    clearTimer();
    broadcast();
    setTimeout(() => { if (game.order.length > 0) startBetting(); }, 2000);
    return;
  }
  game.phase = 'dealing';
  for (const id of game.order) {
    const p = game.players.get(id);
    if (p.bet > 0) {
      const hand = newHand(p.bet);
      hand.cards = [draw(), draw()];
      if (isBlackjack(hand.cards)) hand.status = 'blackjack';
      p.hands = [hand];
      p.currentHandIdx = 0;
      p.status = 'playing';
      resolveSideBets(p, hand.cards);
    } else {
      p.hands = [];
      p.status = 'idle';
    }
  }
  game.dealer.hand = [draw(), draw()];
  game.dealer.hideHole = true;
  broadcast();
  setTimeout(beginPlay, 900);
}

function resolveSideBets(p, cards) {
  const sb = p.sideBets;
  if (!sb.under && !sb.exact && !sb.over) return;
  const total = sideBetCardValue(cards[0].r) + sideBetCardValue(cards[1].r);
  p.sideTotal = total;
  const res = { under: null, exact: null, over: null };
  if (sb.under > 0) {
    if (total < 13) { p.chips += sb.under * (1 + SIDE_PAY_ANY); res.under = 'win'; }
    else res.under = 'lose';
  }
  if (sb.exact > 0) {
    if (total === 13) { p.chips += sb.exact * (1 + SIDE_PAY_EXACT); res.exact = 'win'; }
    else res.exact = 'lose';
  }
  if (sb.over > 0) {
    if (total > 13) { p.chips += sb.over * (1 + SIDE_PAY_ANY); res.over = 'win'; }
    else res.over = 'lose';
  }
  p.sideResults = res;
  const wins = [];
  if (res.under === 'win') wins.push(`Menor13 ✓ +${sb.under * SIDE_PAY_ANY}`);
  if (res.exact === 'win') wins.push(`¡JACKPOT 13! +${sb.exact * SIDE_PAY_EXACT}`);
  if (res.over === 'win') wins.push(`Mayor13 ✓ +${sb.over * SIDE_PAY_ANY}`);
  log(`${p.name} side bet (suma ${total}): ${wins.length ? wins.join(', ') : 'sin premio'}`);
}

function beginPlay() {
  game.phase = 'playing';
  game.currentTurnIdx = -1;
  advanceTurn();
}

function advanceTurn() {
  // Try next hand in current player
  if (game.currentTurnIdx >= 0) {
    const p = game.players.get(game.order[game.currentTurnIdx]);
    if (p) {
      for (let h = p.currentHandIdx + 1; h < p.hands.length; h++) {
        if (p.hands[h].status === 'playing') {
          p.currentHandIdx = h;
          setTurnTimer();
          log(`${p.name} mano ${h + 1}.`);
          broadcast();
          return;
        }
      }
    }
  }
  // Find next player with a 'playing' hand
  for (let i = game.currentTurnIdx + 1; i < game.order.length; i++) {
    const p = game.players.get(game.order[i]);
    const idx = p.hands.findIndex((h) => h.status === 'playing');
    if (idx >= 0) {
      game.currentTurnIdx = i;
      p.currentHandIdx = idx;
      log(`Turno de ${p.name}.`);
      setTurnTimer();
      broadcast();
      return;
    }
  }
  // No more
  game.currentTurnIdx = -1;
  clearTimer();
  dealerPlay();
}

function setTurnTimer() {
  setPhaseTimer(TURN_TIME_MS, () => {
    const id = currentPlayerId();
    if (!id) return;
    const p = game.players.get(id);
    if (!p) return;
    const h = p.hands[p.currentHandIdx];
    if (h && h.status === 'playing') {
      h.status = 'stood';
      log(`${p.name} se queda (tiempo).`);
      advanceTurn();
    }
  });
}

function dealerPlay() {
  game.phase = 'dealer';
  game.dealer.hideHole = false;
  broadcast();
  const anyActive = game.order.some((id) => {
    const p = game.players.get(id);
    return p.hands.some((h) => h.status === 'stood' || h.status === 'blackjack');
  });
  if (!anyActive) {
    setTimeout(settle, 700);
    return;
  }
  function step() {
    const total = handTotal(game.dealer.hand);
    if (total < 17) {
      game.dealer.hand.push(draw());
      broadcast();
      setTimeout(step, 700);
    } else {
      setTimeout(settle, 500);
    }
  }
  setTimeout(step, 700);
}

function settle() {
  game.phase = 'settle';
  const dt = handTotal(game.dealer.hand);
  const dealerBust = dt > 21;
  const dealerBJ = isBlackjack(game.dealer.hand);
  for (const id of game.order) {
    const p = game.players.get(id);
    for (const h of p.hands) {
      if (h.status === 'surrendered') {
        h.result = 'surrender';
        p.chips += Math.floor(h.bet / 2);
        continue;
      }
      if (h.status === 'busted') { h.result = 'bust'; continue; }
      if (h.status === 'blackjack') {
        if (dealerBJ) { h.result = 'push'; p.chips += h.bet; }
        else { h.result = 'bj'; p.chips += Math.floor(h.bet * 2.5); }
        continue;
      }
      const pt = handTotal(h.cards);
      if (dealerBJ) { h.result = 'lose'; continue; }
      if (dealerBust || pt > dt) { h.result = 'win'; p.chips += h.bet * 2; }
      else if (pt === dt) { h.result = 'push'; p.chips += h.bet; }
      else { h.result = 'lose'; }
    }
    p.status = 'done';
  }
  log('Ronda terminada.');
  broadcast();
  setTimeout(startBetting, 6000);
}

io.on('connection', (socket) => {
  const addr = socket.handshake.address;
  const isHost = isLocalhostAddr(addr);
  socket.data.isHost = isHost;
  socket.emit('hello', { isHost });
  socket.emit('state', publicState());

  socket.on('join', (rawName) => {
    if (game.players.has(socket.id)) return;
    const name = String(rawName || '').trim().slice(0, 16) || `Jugador ${game.order.length + 1}`;
    if (game.order.length >= MAX_SEATS) {
      socket.emit('error_msg', `Mesa llena (máx ${MAX_SEATS}).`);
      return;
    }
    game.players.set(socket.id, {
      name,
      chips: STARTING_CHIPS,
      bet: 0,
      sideBets: { under: 0, exact: 0, over: 0 },
      sideResults: null,
      sideTotal: null,
      hands: [],
      currentHandIdx: 0,
      status: 'idle',
      connected: true,
      isHost,
    });
    game.order.push(socket.id);
    log(`${name} se sentó${isHost ? ' (HOST ★)' : ''}.`);
    socket.emit('joined', { id: socket.id, name, isHost });
    if (game.phase === 'waiting') startBetting();
    else broadcast();
  });

  socket.on('bet', (data) => {
    if (game.phase !== 'betting') return;
    const p = game.players.get(socket.id);
    if (!p) return;
    const main  = Math.max(0, Math.floor(Number(data?.main)  || 0));
    const under = Math.max(0, Math.floor(Number(data?.under) || 0));
    const exact = Math.max(0, Math.floor(Number(data?.exact) || 0));
    const over  = Math.max(0, Math.floor(Number(data?.over)  || 0));
    if (main < MIN_BET) {
      socket.emit('error_msg', `Apuesta principal mínima ${MIN_BET}.`);
      return;
    }
    const requested = main + under + exact + over;
    const available = p.chips + p.bet + p.sideBets.under + p.sideBets.exact + p.sideBets.over;
    if (requested > available) {
      socket.emit('error_msg', 'No tienes suficientes fichas.');
      return;
    }
    p.chips = available - requested;
    p.bet = main;
    p.sideBets = { under, exact, over };
    p.status = 'betting';
    broadcast();
  });

  socket.on('hit',       () => doAction(socket, 'hit'));
  socket.on('stand',     () => doAction(socket, 'stand'));
  socket.on('double',    () => doAction(socket, 'double'));
  socket.on('split',     () => doAction(socket, 'split'));
  socket.on('surrender', () => doAction(socket, 'surrender'));

  socket.on('host_rebuy', (targetId) => {
    if (!socket.data.isHost) {
      socket.emit('error_msg', 'Solo el HOST puede dar fichas.');
      return;
    }
    const p = game.players.get(targetId);
    if (!p) return;
    p.chips += REBUY_AMOUNT;
    log(`HOST le dio ${REBUY_AMOUNT} a ${p.name}.`);
    broadcast();
  });

  socket.on('disconnect', () => {
    const p = game.players.get(socket.id);
    if (!p) return;
    log(`${p.name} se fue.`);
    const wasTurn = currentPlayerId() === socket.id;
    const idx = game.order.indexOf(socket.id);
    game.order = game.order.filter((id) => id !== socket.id);
    game.players.delete(socket.id);
    if (game.order.length === 0) {
      game.phase = 'waiting';
      game.currentTurnIdx = -1;
      clearTimer();
      broadcast();
      return;
    }
    if (game.currentTurnIdx > idx) game.currentTurnIdx--;
    if (wasTurn) {
      game.currentTurnIdx = idx - 1;
      advanceTurn();
    } else {
      broadcast();
    }
  });
});

function doAction(socket, action) {
  if (game.phase !== 'playing') return;
  if (currentPlayerId() !== socket.id) return;
  const p = game.players.get(socket.id);
  if (!p) return;
  const hand = p.hands[p.currentHandIdx];
  if (!hand || hand.status !== 'playing') return;

  if (action === 'hit') {
    hand.cards.push(draw());
    const t = handTotal(hand.cards);
    if (t > 21) {
      hand.status = 'busted';
      log(`${p.name} se pasó con ${t}.`);
      broadcast();
      setTimeout(advanceTurn, 600);
    } else if (t === 21) {
      hand.status = 'stood';
      broadcast();
      setTimeout(advanceTurn, 500);
    } else {
      broadcast();
    }
    return;
  }

  if (action === 'stand') {
    hand.status = 'stood';
    log(`${p.name} se planta con ${handTotal(hand.cards)}.`);
    advanceTurn();
    return;
  }

  if (action === 'double') {
    if (hand.cards.length !== 2) {
      socket.emit('error_msg', 'Solo puedes doblar al inicio.');
      return;
    }
    if (p.chips < hand.bet) {
      socket.emit('error_msg', 'No tienes fichas para doblar.');
      return;
    }
    p.chips -= hand.bet;
    hand.bet *= 2;
    hand.doubled = true;
    hand.cards.push(draw());
    const t = handTotal(hand.cards);
    hand.status = t > 21 ? 'busted' : 'stood';
    log(`${p.name} dobló a ${hand.bet}${t > 21 ? ' y se pasó' : ''}.`);
    broadcast();
    setTimeout(advanceTurn, 700);
    return;
  }

  if (action === 'split') {
    if (hand.cards.length !== 2) {
      socket.emit('error_msg', 'Solo puedes dividir con 2 cartas.');
      return;
    }
    const [c1, c2] = hand.cards;
    if (rankValue(c1.r) !== rankValue(c2.r)) {
      socket.emit('error_msg', 'Solo se dividen cartas iguales.');
      return;
    }
    if (p.chips < hand.bet) {
      socket.emit('error_msg', 'No tienes fichas para dividir.');
      return;
    }
    if (p.hands.length >= MAX_SPLIT_HANDS) {
      socket.emit('error_msg', `Máximo ${MAX_SPLIT_HANDS} manos.`);
      return;
    }
    p.chips -= hand.bet;
    const newH = newHand(hand.bet);
    newH.fromSplit = true;
    newH.cards = [c2, draw()];
    hand.cards = [c1, draw()];
    hand.fromSplit = true;
    p.hands.splice(p.currentHandIdx + 1, 0, newH);
    if (c1.r === 'A') {
      // Tradición: una sola carta sobre ases divididos
      hand.status = 'stood';
      newH.status = 'stood';
      log(`${p.name} dividió ases (una carta cada uno).`);
      broadcast();
      setTimeout(advanceTurn, 700);
      return;
    }
    // Si la nueva carta hace 21, no es blackjack natural — sigue siendo 'playing' hasta plantarse
    if (handTotal(hand.cards) === 21) hand.status = 'stood';
    if (handTotal(newH.cards) === 21) newH.status = 'stood';
    log(`${p.name} dividió ${c1.r}.`);
    broadcast();
    if (hand.status !== 'playing') setTimeout(advanceTurn, 600);
    return;
  }

  if (action === 'surrender') {
    if (hand.cards.length !== 2 || hand.fromSplit) {
      socket.emit('error_msg', 'Solo te puedes rendir al inicio (no tras dividir).');
      return;
    }
    hand.status = 'surrendered';
    log(`${p.name} se rindió.`);
    broadcast();
    setTimeout(advanceTurn, 500);
    return;
  }
}

function getLanIps() {
  const ifs = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(ifs)) {
    for (const iface of ifs[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
    }
  }
  return ips;
}

const PORT = process.env.PORT || 3838;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n♠ Blackjack LAN listo en puerto ${PORT}`);
  console.log(`HOST:  http://localhost:${PORT}  (este navegador puede dar rebuys)`);
  for (const ip of getLanIps()) console.log(`LAN:   http://${ip}:${PORT}`);
  console.log('');
});
