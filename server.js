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

app.get('/blackjack', (req, res) => res.sendFile(path.join(__dirname, 'public/blackjack/index.html')));
app.get('/poker',     (req, res) => res.sendFile(path.join(__dirname, 'public/poker/index.html')));
app.use(express.static(path.join(__dirname, 'public'), { redirect: false }));

// ============================================================
// Shared helpers
// ============================================================
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function buildShoe(numDecks = 1) {
  const cards = [];
  for (let d = 0; d < numDecks; d++) {
    for (const s of SUITS) for (const r of RANKS) cards.push({ r, s });
  }
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

function isLocalhostAddr(addr) {
  if (!addr) return false;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

// ============================================================
// BLACKJACK (namespace /blackjack)
// ============================================================
setupBlackjack(io.of('/blackjack'));

function setupBlackjack(nsp) {
  const STARTING_CHIPS = 1000;
  const MIN_BET = 10;
  const REBUY_AMOUNT = 1000;
  const NUM_DECKS = 6;
  const BETTING_TIME_MS = 25000;
  const TURN_TIME_MS = 30000;
  const MAX_SEATS = 6;
  const MAX_SPLIT_HANDS = 4;
  const SIDE_PAY_EXACT = 10;
  const SIDE_PAY_ANY = 1;

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
    while (total > 21 && aces > 0) { total -= 10; aces--; }
    return total;
  }
  function isBlackjack(cards) {
    return cards.length === 2 && handTotal(cards) === 21;
  }

  const game = {
    phase: 'waiting',
    players: new Map(),
    order: [],
    shoe: buildShoe(NUM_DECKS),
    dealer: { hand: [], hideHole: true },
    currentTurnIdx: -1,
    phaseEndsAt: 0,
    timer: null,
  };

  function draw() {
    if (game.shoe.length < 26) game.shoe = buildShoe(NUM_DECKS);
    return game.shoe.pop();
  }
  function newHand(bet) {
    return { cards: [], bet, status: 'playing', result: null, doubled: false, fromSplit: false };
  }
  function currentPlayerId() {
    return game.currentTurnIdx >= 0 ? game.order[game.currentTurnIdx] : null;
  }
  function publicState() {
    const curId = currentPlayerId();
    const players = game.order.map((id) => {
      const p = game.players.get(id);
      return {
        id, name: p.name, chips: p.chips, bet: p.bet,
        sideBets: p.sideBets, sideResults: p.sideResults, sideTotal: p.sideTotal,
        hands: p.hands.map((h, i) => ({
          cards: h.cards,
          total: h.cards.length ? handTotal(h.cards) : 0,
          bet: h.bet, status: h.status, result: h.result,
          doubled: h.doubled, fromSplit: h.fromSplit,
          isCurrent: id === curId && i === p.currentHandIdx,
        })),
        status: p.status, connected: p.connected, isHost: p.isHost,
      };
    });
    const dealerHand = game.dealer.hideHole && game.dealer.hand.length > 1
      ? [game.dealer.hand[0], { r: '?', s: '?' }]
      : game.dealer.hand;
    const dealerTotal = game.dealer.hideHole && game.dealer.hand.length > 1
      ? rankValue(game.dealer.hand[0].r)
      : handTotal(game.dealer.hand);
    return {
      phase: game.phase, players,
      dealer: { hand: dealerHand, total: dealerTotal, hideHole: game.dealer.hideHole },
      currentTurn: curId, phaseEndsAt: game.phaseEndsAt, minBet: MIN_BET,
    };
  }
  function broadcast() { nsp.emit('state', publicState()); }
  function log(msg) { nsp.emit('log', { t: Date.now(), msg }); }
  function clearTimer() { if (game.timer) { clearTimeout(game.timer); game.timer = null; } }
  function setPhaseTimer(ms, fn) {
    clearTimer();
    game.phaseEndsAt = Date.now() + ms;
    game.timer = setTimeout(fn, ms);
  }

  function startBetting() {
    if (game.order.length === 0) {
      game.phase = 'waiting'; game.phaseEndsAt = 0; clearTimer(); broadcast(); return;
    }
    game.phase = 'betting';
    game.dealer = { hand: [], hideHole: true };
    game.currentTurnIdx = -1;
    for (const id of game.order) {
      const p = game.players.get(id);
      p.hands = []; p.currentHandIdx = 0; p.bet = 0;
      p.sideBets = { under: 0, exact: 0, over: 0 };
      p.sideResults = null; p.sideTotal = null;
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
      game.phase = 'waiting'; clearTimer(); broadcast();
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
        p.hands = [hand]; p.currentHandIdx = 0; p.status = 'playing';
        resolveSideBets(p, hand.cards);
      } else { p.hands = []; p.status = 'idle'; }
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
    if (sb.under > 0) { if (total < 13)  { p.chips += sb.under * (1 + SIDE_PAY_ANY);   res.under = 'win'; } else res.under = 'lose'; }
    if (sb.exact > 0) { if (total === 13){ p.chips += sb.exact * (1 + SIDE_PAY_EXACT); res.exact = 'win'; } else res.exact = 'lose'; }
    if (sb.over  > 0) { if (total > 13)  { p.chips += sb.over  * (1 + SIDE_PAY_ANY);   res.over  = 'win'; } else res.over  = 'lose'; }
    p.sideResults = res;
    const wins = [];
    if (res.under === 'win') wins.push(`Menor13 +${sb.under * SIDE_PAY_ANY}`);
    if (res.exact === 'win') wins.push(`★JACKPOT 13 +${sb.exact * SIDE_PAY_EXACT}`);
    if (res.over  === 'win') wins.push(`Mayor13 +${sb.over * SIDE_PAY_ANY}`);
    log(`${p.name} side bet (suma ${total}): ${wins.length ? wins.join(', ') : 'sin premio'}`);
  }

  function beginPlay() { game.phase = 'playing'; game.currentTurnIdx = -1; advanceTurn(); }

  function advanceTurn() {
    if (game.currentTurnIdx >= 0) {
      const p = game.players.get(game.order[game.currentTurnIdx]);
      if (p) {
        for (let h = p.currentHandIdx + 1; h < p.hands.length; h++) {
          if (p.hands[h].status === 'playing') {
            p.currentHandIdx = h; setTurnTimer();
            log(`${p.name} mano ${h + 1}.`); broadcast(); return;
          }
        }
      }
    }
    for (let i = game.currentTurnIdx + 1; i < game.order.length; i++) {
      const p = game.players.get(game.order[i]);
      const idx = p.hands.findIndex((h) => h.status === 'playing');
      if (idx >= 0) {
        game.currentTurnIdx = i; p.currentHandIdx = idx;
        log(`Turno de ${p.name}.`); setTurnTimer(); broadcast(); return;
      }
    }
    game.currentTurnIdx = -1; clearTimer(); dealerPlay();
  }

  function setTurnTimer() {
    setPhaseTimer(TURN_TIME_MS, () => {
      const id = currentPlayerId();
      if (!id) return;
      const p = game.players.get(id);
      if (!p) return;
      const h = p.hands[p.currentHandIdx];
      if (h && h.status === 'playing') {
        h.status = 'stood'; log(`${p.name} se queda (tiempo).`); advanceTurn();
      }
    });
  }

  function dealerPlay() {
    game.phase = 'dealer'; game.dealer.hideHole = false; broadcast();
    const anyActive = game.order.some((id) => {
      const p = game.players.get(id);
      return p.hands.some((h) => h.status === 'stood' || h.status === 'blackjack');
    });
    if (!anyActive) { setTimeout(settle, 700); return; }
    function step() {
      const total = handTotal(game.dealer.hand);
      if (total < 17) { game.dealer.hand.push(draw()); broadcast(); setTimeout(step, 700); }
      else { setTimeout(settle, 500); }
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
        if (h.status === 'surrendered') { h.result = 'surrender'; p.chips += Math.floor(h.bet / 2); continue; }
        if (h.status === 'busted')      { h.result = 'bust'; continue; }
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

  nsp.on('connection', (socket) => {
    const isHost = isLocalhostAddr(socket.handshake.address);
    socket.data.isHost = isHost;
    socket.emit('hello', { isHost });
    socket.emit('state', publicState());

    socket.on('join', (rawName) => {
      if (game.players.has(socket.id)) return;
      const name = String(rawName || '').trim().slice(0, 16) || `Jugador ${game.order.length + 1}`;
      if (game.order.length >= MAX_SEATS) { socket.emit('error_msg', `Mesa llena (máx ${MAX_SEATS}).`); return; }
      game.players.set(socket.id, {
        name, chips: STARTING_CHIPS, bet: 0,
        sideBets: { under: 0, exact: 0, over: 0 }, sideResults: null, sideTotal: null,
        hands: [], currentHandIdx: 0, status: 'idle', connected: true, isHost,
      });
      game.order.push(socket.id);
      log(`${name} se sentó${isHost ? ' (HOST ★)' : ''}.`);
      socket.emit('joined', { id: socket.id, name, isHost });
      if (game.phase === 'waiting') startBetting(); else broadcast();
    });

    socket.on('bet', (data) => {
      if (game.phase !== 'betting') return;
      const p = game.players.get(socket.id); if (!p) return;
      const main  = Math.max(0, Math.floor(Number(data?.main)  || 0));
      const under = Math.max(0, Math.floor(Number(data?.under) || 0));
      const exact = Math.max(0, Math.floor(Number(data?.exact) || 0));
      const over  = Math.max(0, Math.floor(Number(data?.over)  || 0));
      if (main < MIN_BET) { socket.emit('error_msg', `Apuesta principal mínima ${MIN_BET}.`); return; }
      const requested = main + under + exact + over;
      const available = p.chips + p.bet + p.sideBets.under + p.sideBets.exact + p.sideBets.over;
      if (requested > available) { socket.emit('error_msg', 'No tienes suficientes fichas.'); return; }
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
      if (!socket.data.isHost) { socket.emit('error_msg', 'Solo el HOST puede dar fichas.'); return; }
      const p = game.players.get(targetId); if (!p) return;
      p.chips += REBUY_AMOUNT;
      log(`HOST le dio ${REBUY_AMOUNT} a ${p.name}.`);
      broadcast();
    });

    socket.on('disconnect', () => {
      const p = game.players.get(socket.id); if (!p) return;
      log(`${p.name} se fue.`);
      const wasTurn = currentPlayerId() === socket.id;
      const idx = game.order.indexOf(socket.id);
      game.order = game.order.filter((id) => id !== socket.id);
      game.players.delete(socket.id);
      if (game.order.length === 0) {
        game.phase = 'waiting'; game.currentTurnIdx = -1; clearTimer(); broadcast(); return;
      }
      if (game.currentTurnIdx > idx) game.currentTurnIdx--;
      if (wasTurn) { game.currentTurnIdx = idx - 1; advanceTurn(); }
      else { broadcast(); }
    });
  });

  function doAction(socket, action) {
    if (game.phase !== 'playing') return;
    if (currentPlayerId() !== socket.id) return;
    const p = game.players.get(socket.id); if (!p) return;
    const hand = p.hands[p.currentHandIdx];
    if (!hand || hand.status !== 'playing') return;

    if (action === 'hit') {
      hand.cards.push(draw());
      const t = handTotal(hand.cards);
      if (t > 21) { hand.status = 'busted'; log(`${p.name} se pasó con ${t}.`); broadcast(); setTimeout(advanceTurn, 600); }
      else if (t === 21) { hand.status = 'stood'; broadcast(); setTimeout(advanceTurn, 500); }
      else broadcast();
      return;
    }
    if (action === 'stand') {
      hand.status = 'stood'; log(`${p.name} se planta con ${handTotal(hand.cards)}.`); advanceTurn(); return;
    }
    if (action === 'double') {
      if (hand.cards.length !== 2) { socket.emit('error_msg', 'Solo puedes doblar al inicio.'); return; }
      if (p.chips < hand.bet) { socket.emit('error_msg', 'No tienes fichas para doblar.'); return; }
      p.chips -= hand.bet; hand.bet *= 2; hand.doubled = true;
      hand.cards.push(draw());
      const t = handTotal(hand.cards);
      hand.status = t > 21 ? 'busted' : 'stood';
      log(`${p.name} dobló a ${hand.bet}${t > 21 ? ' y se pasó' : ''}.`);
      broadcast(); setTimeout(advanceTurn, 700); return;
    }
    if (action === 'split') {
      if (hand.cards.length !== 2) { socket.emit('error_msg', 'Solo puedes dividir con 2 cartas.'); return; }
      const [c1, c2] = hand.cards;
      if (rankValue(c1.r) !== rankValue(c2.r)) { socket.emit('error_msg', 'Solo se dividen cartas iguales.'); return; }
      if (p.chips < hand.bet) { socket.emit('error_msg', 'No tienes fichas para dividir.'); return; }
      if (p.hands.length >= MAX_SPLIT_HANDS) { socket.emit('error_msg', `Máximo ${MAX_SPLIT_HANDS} manos.`); return; }
      p.chips -= hand.bet;
      const newH = newHand(hand.bet); newH.fromSplit = true; newH.cards = [c2, draw()];
      hand.cards = [c1, draw()]; hand.fromSplit = true;
      p.hands.splice(p.currentHandIdx + 1, 0, newH);
      if (c1.r === 'A') {
        hand.status = 'stood'; newH.status = 'stood';
        log(`${p.name} dividió ases (una carta cada uno).`);
        broadcast(); setTimeout(advanceTurn, 700); return;
      }
      if (handTotal(hand.cards) === 21) hand.status = 'stood';
      if (handTotal(newH.cards) === 21) newH.status = 'stood';
      log(`${p.name} dividió ${c1.r}.`);
      broadcast();
      if (hand.status !== 'playing') setTimeout(advanceTurn, 600);
      return;
    }
    if (action === 'surrender') {
      if (hand.cards.length !== 2 || hand.fromSplit) { socket.emit('error_msg', 'Solo te puedes rendir al inicio.'); return; }
      hand.status = 'surrendered'; log(`${p.name} se rindió.`);
      broadcast(); setTimeout(advanceTurn, 500); return;
    }
  }
}

// ============================================================
// POKER — Texas Hold'em No-Limit (namespace /poker)
// ============================================================
setupPoker(io.of('/poker'));

function setupPoker(nsp) {
  const STARTING_CHIPS = 1000;
  const REBUY_AMOUNT = 1000;
  const SMALL_BLIND = 5;
  const BIG_BLIND = 10;
  const TURN_TIME_MS = 30000;
  const MAX_SEATS = 6;
  const HAND_NAMES = {
    9: 'Escalera de Color', 8: 'Póker', 7: 'Full',
    6: 'Color', 5: 'Escalera', 4: 'Tercia',
    3: 'Doble Par', 2: 'Par', 1: 'Carta Alta',
  };

  function rankVal(r) {
    return { '2':2, '3':3, '4':4, '5':5, '6':6, '7':7, '8':8, '9':9, '10':10, 'J':11, 'Q':12, 'K':13, 'A':14 }[r];
  }

  function evaluate7(cards) {
    // Returns [category, ...tiebreakers]
    const vals = cards.map((c) => rankVal(c.r)).sort((a, b) => b - a);
    const bySuit = {};
    for (const c of cards) (bySuit[c.s] = bySuit[c.s] || []).push(rankVal(c.r));
    const counts = {};
    for (const v of vals) counts[v] = (counts[v] || 0) + 1;

    let flushVals = null;
    for (const s in bySuit) {
      if (bySuit[s].length >= 5) flushVals = bySuit[s].slice().sort((a, b) => b - a);
    }

    function findStraight(arr) {
      const u = [...new Set(arr)].sort((a, b) => b - a);
      if (u.includes(14)) u.push(1); // wheel
      for (let i = 0; i <= u.length - 5; i++) {
        if (u[i] - u[i + 4] === 4) return u[i];
      }
      return null;
    }

    if (flushVals) {
      const sf = findStraight(flushVals);
      if (sf !== null) return [9, sf];
    }
    const groupsBy = (n) => Object.entries(counts).filter(([, c]) => c === n).map(([v]) => +v).sort((a, b) => b - a);
    const fours  = groupsBy(4);
    const threes = groupsBy(3);
    const pairs  = groupsBy(2);
    if (fours.length) {
      const q = fours[0];
      const kicker = vals.find((v) => v !== q);
      return [8, q, kicker];
    }
    if (threes.length && (threes.length >= 2 || pairs.length)) {
      const t = threes[0];
      const p = threes.length >= 2 ? threes[1] : pairs[0];
      return [7, t, p];
    }
    if (flushVals) return [6, ...flushVals.slice(0, 5)];
    const st = findStraight(vals);
    if (st !== null) return [5, st];
    if (threes.length) {
      const t = threes[0];
      const k = vals.filter((v) => v !== t).slice(0, 2);
      return [4, t, ...k];
    }
    if (pairs.length >= 2) {
      const [a, b] = pairs.slice(0, 2);
      const k = vals.find((v) => v !== a && v !== b);
      return [3, a, b, k];
    }
    if (pairs.length === 1) {
      const p = pairs[0];
      const k = vals.filter((v) => v !== p).slice(0, 3);
      return [2, p, ...k];
    }
    return [1, ...vals.slice(0, 5)];
  }

  function compareHands(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const x = a[i] || 0, y = b[i] || 0;
      if (x !== y) return x - y;
    }
    return 0;
  }

  const game = {
    phase: 'waiting',
    players: new Map(),
    order: [],
    handOrder: [],
    dealerSeat: 0, // index into 'order' (persists)
    sbId: null,
    bbId: null,
    currentTurnIdx: -1, // index into handOrder
    community: [],
    pot: 0,
    currentBet: 0,
    minRaise: BIG_BLIND,
    deck: [],
    phaseEndsAt: 0,
    timer: null,
    startCountdown: null,
  };

  function clearTimer() { if (game.timer) { clearTimeout(game.timer); game.timer = null; } }
  function setPhaseTimer(ms, fn) {
    clearTimer();
    game.phaseEndsAt = Date.now() + ms;
    game.timer = setTimeout(fn, ms);
  }
  function log(msg) { nsp.emit('log', { t: Date.now(), msg }); }
  function broadcast() { nsp.emit('state', publicState()); }

  function publicState() {
    const curId = game.currentTurnIdx >= 0 ? game.handOrder[game.currentTurnIdx] : null;
    const players = game.order.map((id) => {
      const p = game.players.get(id);
      return {
        id, name: p.name, chips: p.chips,
        bet: p.bet, totalBet: p.totalBet,
        hole: p.hole,
        holeRevealed: p.holeRevealed,
        status: p.status,
        connected: p.connected,
        isHost: p.isHost,
        isDealer: id === game.order[game.dealerSeat],
        isSmallBlind: id === game.sbId,
        isBigBlind: id === game.bbId,
        lastAction: p.lastAction,
        handLabel: p.handLabel,
        winnings: p.winnings,
      };
    });
    return {
      phase: game.phase, players,
      community: game.community,
      pot: game.pot,
      currentBet: game.currentBet,
      minRaise: game.minRaise,
      bigBlind: BIG_BLIND,
      currentTurn: curId,
      phaseEndsAt: game.phaseEndsAt,
    };
  }

  function tryStartHand() {
    const eligible = game.order.filter((id) => game.players.get(id).chips > 0 && game.players.get(id).connected);
    if (eligible.length < 2) {
      game.phase = 'waiting'; clearTimer(); game.phaseEndsAt = 0; broadcast(); return;
    }
    startHand();
  }

  function startHand() {
    game.deck = buildShoe(1);
    game.community = [];
    game.pot = 0;
    game.currentBet = 0;
    game.minRaise = BIG_BLIND;

    // Build handOrder starting from dealer
    const eligible = game.order.filter((id) => game.players.get(id).chips > 0);
    if (eligible.length < 2) { game.phase = 'waiting'; broadcast(); return; }

    // Move dealer to next eligible seat
    if (game.dealerSeat >= game.order.length) game.dealerSeat = 0;
    // Advance dealer button (skip if dealer not eligible)
    for (let i = 0; i < game.order.length; i++) {
      game.dealerSeat = (game.dealerSeat + 1) % game.order.length;
      if (eligible.includes(game.order[game.dealerSeat])) break;
    }
    // handOrder = rotation of order starting from dealer, filtered to eligible
    const rotated = [...game.order.slice(game.dealerSeat), ...game.order.slice(0, game.dealerSeat)];
    game.handOrder = rotated.filter((id) => eligible.includes(id));

    for (const id of game.order) {
      const p = game.players.get(id);
      p.bet = 0; p.totalBet = 0; p.lastAction = null; p.handLabel = null; p.winnings = 0;
      p.holeRevealed = false;
      if (game.handOrder.includes(id)) {
        p.hole = [game.deck.pop(), game.deck.pop()];
        p.status = 'in';
        p.acted = false;
      } else {
        p.hole = []; p.status = 'idle'; p.acted = false;
      }
    }

    // Post blinds: dealer is handOrder[0]; SB is [1], BB is [2] (heads-up: dealer is SB, other is BB)
    const sbIdx = game.handOrder.length === 2 ? 0 : 1;
    const bbIdx = game.handOrder.length === 2 ? 1 : 2;
    const sbId = game.handOrder[sbIdx];
    const bbId = game.handOrder[bbIdx];
    game.sbId = sbId; game.bbId = bbId;
    postBlind(sbId, SMALL_BLIND, 'SB');
    postBlind(bbId, BIG_BLIND, 'BB');
    game.currentBet = BIG_BLIND;

    // First to act: pre-flop is left of BB (heads-up = dealer/SB)
    game.currentTurnIdx = game.handOrder.length === 2 ? 0 : (bbIdx + 1) % game.handOrder.length;
    game.phase = 'pre-flop';
    log(`— Nueva mano. Dealer: ${game.players.get(game.handOrder[0]).name}. SB ${SMALL_BLIND} / BB ${BIG_BLIND}. —`);
    setTurnTimer();
    broadcast();
  }

  function postBlind(id, amount, label) {
    const p = game.players.get(id);
    const post = Math.min(amount, p.chips);
    p.chips -= post;
    p.bet += post;
    p.totalBet += post;
    game.pot += post;
    if (p.chips === 0) p.status = 'all-in';
    p.lastAction = `${label} ${post}`;
  }

  function setTurnTimer() {
    setPhaseTimer(TURN_TIME_MS, () => {
      const id = game.handOrder[game.currentTurnIdx];
      const p = game.players.get(id);
      if (!p || p.status !== 'in') return;
      // Auto-action: check if possible, else fold
      const toCall = game.currentBet - p.bet;
      if (toCall === 0) { p.acted = true; p.lastAction = 'check (auto)'; log(`${p.name} pasa (tiempo).`); afterAction(); }
      else { p.status = 'folded'; p.acted = true; p.lastAction = 'fold (auto)'; log(`${p.name} se retira (tiempo).`); afterAction(); }
    });
  }

  function afterAction() {
    // Check for last-standing
    const notFolded = game.handOrder.filter((id) => game.players.get(id).status !== 'folded');
    if (notFolded.length === 1) {
      awardByFold(notFolded[0]); return;
    }
    // Find next to act
    const n = game.handOrder.length;
    for (let step = 1; step <= n; step++) {
      const idx = (game.currentTurnIdx + step) % n;
      const id = game.handOrder[idx];
      const p = game.players.get(id);
      if (p.status === 'folded' || p.status === 'all-in') continue;
      if (p.chips === 0) continue;
      if (p.acted && p.bet === game.currentBet) { endBettingRound(); return; }
      game.currentTurnIdx = idx;
      setTurnTimer();
      broadcast();
      return;
    }
    // Nobody can act
    endBettingRound();
  }

  function awardByFold(winnerId) {
    clearTimer();
    const winner = game.players.get(winnerId);
    winner.winnings = game.pot;
    winner.chips += game.pot;
    log(`${winner.name} gana ${game.pot} (todos se retiraron).`);
    game.pot = 0;
    game.phase = 'settle';
    broadcast();
    setTimeout(tryStartHand, 4000);
  }

  function endBettingRound() {
    clearTimer();
    // Reset round bets
    for (const id of game.handOrder) {
      const p = game.players.get(id);
      p.bet = 0;
      if (p.status === 'in') p.acted = false;
    }
    game.currentBet = 0;
    game.minRaise = BIG_BLIND;

    // Advance street
    if (game.phase === 'pre-flop') dealFlop();
    else if (game.phase === 'flop') dealTurn();
    else if (game.phase === 'turn') dealRiver();
    else if (game.phase === 'river') showdown();
  }

  function canStillAct() {
    return game.handOrder.filter((id) => {
      const p = game.players.get(id);
      return p.status === 'in' && p.chips > 0;
    });
  }

  function startStreetBetting() {
    // First to act post-flop: first 'in' player after dealer (handOrder[0])
    const can = canStillAct();
    if (can.length < 2) {
      // Run out remaining streets to showdown
      broadcast();
      setTimeout(() => {
        if (game.phase === 'flop')      { dealTurn();  }
        else if (game.phase === 'turn') { dealRiver(); }
        else if (game.phase === 'river'){ showdown();  }
      }, 1200);
      return;
    }
    for (let step = 1; step <= game.handOrder.length; step++) {
      const idx = step % game.handOrder.length;
      const p = game.players.get(game.handOrder[idx]);
      if (p.status === 'in' && p.chips > 0) {
        game.currentTurnIdx = idx;
        setTurnTimer();
        broadcast();
        return;
      }
    }
    broadcast();
  }

  function dealFlop() {
    game.phase = 'flop';
    game.deck.pop(); // burn
    game.community.push(game.deck.pop(), game.deck.pop(), game.deck.pop());
    log(`Flop: ${cardsStr(game.community)}`);
    startStreetBetting();
  }
  function dealTurn() {
    game.phase = 'turn';
    game.deck.pop();
    game.community.push(game.deck.pop());
    log(`Turn: ${cardsStr(game.community.slice(3))}`);
    startStreetBetting();
  }
  function dealRiver() {
    game.phase = 'river';
    game.deck.pop();
    game.community.push(game.deck.pop());
    log(`River: ${cardsStr(game.community.slice(4))}`);
    startStreetBetting();
  }

  function cardsStr(arr) { return arr.map((c) => `${c.r}${c.s}`).join(' '); }

  function showdown() {
    clearTimer();
    game.phase = 'showdown';
    game.currentTurnIdx = -1;
    const contenders = game.handOrder
      .map((id) => game.players.get(id))
      .filter((p) => p.status !== 'folded');
    for (const p of contenders) {
      p.holeRevealed = true;
      p.handResult = evaluate7([...p.hole, ...game.community]);
      p.handLabel = HAND_NAMES[p.handResult[0]];
    }

    // Side pots
    const allInHand = game.handOrder.map((id) => game.players.get(id));
    const levels = [...new Set(contenders.map((p) => p.totalBet))].sort((a, b) => a - b);
    let prev = 0;
    const pots = [];
    for (const lvl of levels) {
      const amount = allInHand.reduce((s, p) => s + Math.max(0, Math.min(p.totalBet, lvl) - prev), 0);
      if (amount > 0) {
        const eligible = contenders.filter((p) => p.totalBet >= lvl);
        pots.push({ amount, eligible });
      }
      prev = lvl;
    }

    const messages = [];
    for (const pot of pots) {
      if (pot.eligible.length === 0) continue;
      let best = pot.eligible[0];
      const winners = [best];
      for (let i = 1; i < pot.eligible.length; i++) {
        const c = compareHands(pot.eligible[i].handResult, best.handResult);
        if (c > 0) { winners.length = 0; winners.push(pot.eligible[i]); best = pot.eligible[i]; }
        else if (c === 0) winners.push(pot.eligible[i]);
      }
      const share = Math.floor(pot.amount / winners.length);
      const rem = pot.amount - share * winners.length;
      for (const w of winners) { w.chips += share; w.winnings = (w.winnings || 0) + share; }
      if (rem) { winners[0].chips += rem; winners[0].winnings += rem; }
      messages.push(`${winners.map((w) => w.name).join(' / ')} gana ${pot.amount} con ${HAND_NAMES[best.handResult[0]]}`);
    }
    for (const m of messages) log(m);

    game.pot = 0;
    broadcast();
    setTimeout(tryStartHand, 7000);
  }

  function doAction(socket, action, payload) {
    const id = socket.id;
    if (!game.handOrder.includes(id)) return;
    if (game.handOrder[game.currentTurnIdx] !== id) return;
    const p = game.players.get(id);
    if (!p || p.status !== 'in') return;
    const toCall = game.currentBet - p.bet;

    if (action === 'fold') {
      p.status = 'folded'; p.acted = true; p.lastAction = 'fold';
      log(`${p.name} se retira.`);
      afterAction(); return;
    }
    if (action === 'check') {
      if (toCall > 0) { socket.emit('error_msg', `Tienes que pagar ${toCall} o retirarte.`); return; }
      p.acted = true; p.lastAction = 'check';
      log(`${p.name} pasa.`);
      afterAction(); return;
    }
    if (action === 'call') {
      if (toCall <= 0) { socket.emit('error_msg', 'Nada que pagar.'); return; }
      const pay = Math.min(toCall, p.chips);
      p.chips -= pay; p.bet += pay; p.totalBet += pay; game.pot += pay;
      p.acted = true; p.lastAction = `call ${pay}`;
      if (p.chips === 0) p.status = 'all-in';
      log(`${p.name} paga ${pay}${p.chips === 0 ? ' (all-in)' : ''}.`);
      afterAction(); return;
    }
    if (action === 'raise') {
      let target = Math.floor(Number(payload) || 0);
      const maxTotal = p.bet + p.chips;
      const minTotal = game.currentBet + game.minRaise;
      if (target > maxTotal) target = maxTotal;
      const isAllIn = target === maxTotal;
      // Allow under-min only if all-in
      if (target < minTotal && !isAllIn) {
        socket.emit('error_msg', `Min raise: ${minTotal}`); return;
      }
      if (target <= game.currentBet && !isAllIn) {
        socket.emit('error_msg', `Tienes que subir por encima de ${game.currentBet}.`); return;
      }
      const add = target - p.bet;
      if (add > p.chips) { socket.emit('error_msg', 'Fichas insuficientes.'); return; }
      const raiseAmount = target - game.currentBet;
      p.chips -= add; p.bet = target; p.totalBet += add; game.pot += add;
      if (raiseAmount >= game.minRaise) game.minRaise = raiseAmount;
      game.currentBet = target;
      // Reset 'acted' for everyone else in
      for (const otherId of game.handOrder) {
        if (otherId === id) continue;
        const op = game.players.get(otherId);
        if (op.status === 'in') op.acted = false;
      }
      p.acted = true;
      if (p.chips === 0) p.status = 'all-in';
      p.lastAction = `${game.currentBet > toCall + p.bet - add ? 'raise' : 'bet'} ${target}`;
      log(`${p.name} sube a ${target}${p.chips === 0 ? ' (all-in)' : ''}.`);
      afterAction(); return;
    }
    if (action === 'allin') {
      const add = p.chips;
      const target = p.bet + add;
      p.chips = 0; p.bet = target; p.totalBet += add; game.pot += add;
      p.status = 'all-in'; p.acted = true; p.lastAction = `all-in ${target}`;
      if (target > game.currentBet) {
        const raiseAmount = target - game.currentBet;
        if (raiseAmount >= game.minRaise) game.minRaise = raiseAmount;
        game.currentBet = target;
        for (const otherId of game.handOrder) {
          if (otherId === id) continue;
          const op = game.players.get(otherId);
          if (op.status === 'in') op.acted = false;
        }
      }
      log(`${p.name} all-in con ${target}.`);
      afterAction(); return;
    }
  }

  nsp.on('connection', (socket) => {
    const isHost = isLocalhostAddr(socket.handshake.address);
    socket.data.isHost = isHost;
    socket.emit('hello', { isHost });
    socket.emit('state', publicState());

    socket.on('join', (rawName) => {
      if (game.players.has(socket.id)) return;
      const name = String(rawName || '').trim().slice(0, 16) || `Jugador ${game.order.length + 1}`;
      if (game.order.length >= MAX_SEATS) { socket.emit('error_msg', `Mesa llena (máx ${MAX_SEATS}).`); return; }
      game.players.set(socket.id, {
        name, chips: STARTING_CHIPS, bet: 0, totalBet: 0,
        hole: [], holeRevealed: false, status: 'idle', acted: false,
        lastAction: null, handLabel: null, winnings: 0,
        connected: true, isHost,
      });
      game.order.push(socket.id);
      log(`${name} se sentó${isHost ? ' (HOST ★)' : ''}.`);
      socket.emit('joined', { id: socket.id, name, isHost });
      if (game.phase === 'waiting') {
        if (game.order.filter((id) => game.players.get(id).chips > 0).length >= 2) {
          if (!game.startCountdown) {
            log('Empezando en 4s…');
            game.startCountdown = setTimeout(() => {
              game.startCountdown = null;
              tryStartHand();
            }, 4000);
          }
        }
      }
      broadcast();
    });

    socket.on('fold',  () => doAction(socket, 'fold'));
    socket.on('check', () => doAction(socket, 'check'));
    socket.on('call',  () => doAction(socket, 'call'));
    socket.on('raise', (amt) => doAction(socket, 'raise', amt));
    socket.on('allin', () => doAction(socket, 'allin'));

    socket.on('host_rebuy', (targetId) => {
      if (!socket.data.isHost) { socket.emit('error_msg', 'Solo el HOST puede dar fichas.'); return; }
      const p = game.players.get(targetId); if (!p) return;
      p.chips += REBUY_AMOUNT;
      log(`HOST le dio ${REBUY_AMOUNT} a ${p.name}.`);
      broadcast();
      // Maybe trigger a hand start if we now have 2 with chips
      if (game.phase === 'waiting' && !game.startCountdown) {
        if (game.order.filter((id) => game.players.get(id).chips > 0).length >= 2) {
          game.startCountdown = setTimeout(() => { game.startCountdown = null; tryStartHand(); }, 2000);
        }
      }
    });

    socket.on('disconnect', () => {
      const p = game.players.get(socket.id); if (!p) return;
      log(`${p.name} se fue.`);
      const wasInHand = game.handOrder.includes(socket.id);
      const wasTurn = wasInHand && game.handOrder[game.currentTurnIdx] === socket.id;
      // Mark folded if mid-hand
      if (wasInHand && p.status !== 'folded') {
        p.status = 'folded';
        p.acted = true;
      }
      const seatIdx = game.order.indexOf(socket.id);
      game.order = game.order.filter((id) => id !== socket.id);
      // Adjust dealerSeat
      if (seatIdx >= 0 && seatIdx < game.dealerSeat) game.dealerSeat--;
      if (game.dealerSeat >= game.order.length) game.dealerSeat = 0;
      // We keep player data until end of hand for pot calculation
      // Actually simplest: delete and remove from handOrder
      game.handOrder = game.handOrder.filter((id) => id !== socket.id);
      game.players.delete(socket.id);

      if (game.order.length === 0) {
        game.phase = 'waiting'; game.currentTurnIdx = -1; clearTimer(); broadcast(); return;
      }

      if (wasInHand) {
        const stillIn = game.handOrder.filter((id) => game.players.get(id).status !== 'folded');
        if (stillIn.length === 1 && game.phase !== 'showdown' && game.phase !== 'settle') {
          awardByFold(stillIn[0]); return;
        }
        if (wasTurn) {
          // Re-find next
          game.currentTurnIdx = Math.max(-1, game.currentTurnIdx - 1);
          if (game.handOrder.length > 0) afterAction();
        } else {
          // Reindex currentTurnIdx if needed
          if (game.currentTurnIdx >= game.handOrder.length) game.currentTurnIdx = 0;
        }
      }
      broadcast();
    });
  });
}

// ============================================================
// Boot
// ============================================================
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
  console.log(`\n♠♥♦♣ Casino LAN en puerto ${PORT}`);
  console.log(`HOST:  http://localhost:${PORT}  (rebuys)`);
  for (const ip of getLanIps()) console.log(`LAN:   http://${ip}:${PORT}`);
  console.log('Rutas: /  /blackjack  /poker\n');
});
