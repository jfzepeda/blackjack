import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.get('/blackjack', (req, res) => res.sendFile(path.join(__dirname, 'public/blackjack/index.html')));
app.get('/poker',     (req, res) => res.sendFile(path.join(__dirname, 'public/poker/index.html')));
app.get('/uno',       (req, res) => res.sendFile(path.join(__dirname, 'public/uno/index.html')));
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

const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,16}$/;
const DEFAULT_ROOM = 'lobby';
const MAX_ROOMS_PER_NAMESPACE = 100;
function sanitizeRoomId(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  return ROOM_ID_RE.test(s) ? s : DEFAULT_ROOM;
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
  const MAX_SEATS = 5;
  const MAX_SPLIT_HANDS = 4;
  const SIDE_PAY_EXACT = 10;
  const SIDE_PAY_ANY = 1;
  const SESSION_GRACE_MS = 5 * 60 * 1000;

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

  function cleanName(raw) {
    if (typeof raw !== 'string') return '';
    let s = raw.trim().slice(0, 16);
    if (!s || s === '[object Object]' || /^\[object\s/i.test(s)) return '';
    return s;
  }

  const rooms = new Map();

  function getOrCreateRoom(roomId) {
    let r = rooms.get(roomId);
    if (!r) {
      if (rooms.size >= MAX_ROOMS_PER_NAMESPACE) return null;
      r = createRoom(roomId);
      rooms.set(roomId, r);
    }
    return r;
  }

  function destroyIfEmpty(roomId) {
    const r = rooms.get(roomId);
    if (!r) return;
    if (r.game.players.size === 0) {
      r.clearTimer();
      rooms.delete(roomId);
    }
  }

  function createRoom(roomId) {
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
        rebuyRequested: !!p.rebuyRequested,
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
  function broadcast() { nsp.to(roomId).emit('state', publicState()); }
  function log(msg) { nsp.to(roomId).emit('log', { t: Date.now(), msg }); }
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

  function findBySession(sessionId) {
    if (!sessionId || typeof sessionId !== 'string') return null;
    for (const [key, p] of game.players) {
      if (p.sessionId === sessionId) return { key, player: p };
    }
    return null;
  }

  function reattachSession(sessionId, socket, isHost, freshName) {
    const found = findBySession(sessionId);
    if (!found) return null;
    const { key: oldKey, player } = found;
    if (oldKey !== socket.id) {
      game.players.delete(oldKey);
      game.players.set(socket.id, player);
      const idx = game.order.indexOf(oldKey);
      if (idx >= 0) game.order[idx] = socket.id;
    }
    if (player.gracePurgeTimer) { clearTimeout(player.gracePurgeTimer); player.gracePurgeTimer = null; }
    player.connected = true;
    player.isHost = isHost;
    // Self-heal corrupted stored names from a prior buggy state.
    const cleanedFresh = cleanName(freshName);
    if (!cleanName(player.name) && cleanedFresh) player.name = cleanedFresh;
    return player;
  }

  function purgePlayer(socketId) {
    const p = game.players.get(socketId);
    if (!p || p.connected) return;
    log(`${p.name} dejó la mesa.`);
    const idx = game.order.indexOf(socketId);
    game.order = game.order.filter((id) => id !== socketId);
    game.players.delete(socketId);
    if (game.order.length === 0) {
      game.phase = 'waiting'; game.currentTurnIdx = -1; clearTimer(); broadcast();
      destroyIfEmpty(roomId);
      return;
    }
    if (idx >= 0 && game.currentTurnIdx > idx) game.currentTurnIdx--;
    broadcast();
  }

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

  return {
    game, broadcast, log, publicState, clearTimer, startBetting,
    findBySession, reattachSession, purgePlayer, doAction,
    currentPlayerId, advanceTurn,
  };
  }

  nsp.on('connection', (socket) => {
    const roomId = sanitizeRoomId(socket.handshake.query.room);
    const room = getOrCreateRoom(roomId);
    if (!room) {
      socket.emit('error_msg', 'Servidor lleno (demasiadas salas).');
      socket.disconnect(true);
      return;
    }
    socket.data.roomId = roomId;
    socket.join(roomId);

    const isHost = isLocalhostAddr(socket.handshake.address);
    socket.data.isHost = isHost;
    socket.emit('hello', { isHost, roomId });
    socket.emit('state', room.publicState());

    socket.on('join', (payload) => {
      const rawName = typeof payload === 'string' ? payload : payload?.name;
      const sessionId = typeof payload === 'object' && payload ? payload.sessionId : null;

      if (sessionId) {
        const player = room.reattachSession(sessionId, socket, isHost, rawName);
        if (player) {
          socket.data.isHost = isHost;
          socket.emit('joined', { id: socket.id, sessionId: player.sessionId, name: player.name, isHost, roomId });
          room.log(`${player.name} se reconectó.`);
          room.broadcast();
          return;
        }
      }

      if (room.game.players.has(socket.id)) return;
      const name = cleanName(rawName) || `Jugador ${room.game.order.length + 1}`;
      if (room.game.order.length >= MAX_SEATS) { socket.emit('error_msg', `Mesa llena (máx ${MAX_SEATS}).`); return; }
      const newSessionId = crypto.randomUUID();
      room.game.players.set(socket.id, {
        sessionId: newSessionId,
        name, chips: STARTING_CHIPS, bet: 0,
        sideBets: { under: 0, exact: 0, over: 0 }, sideResults: null, sideTotal: null,
        hands: [], currentHandIdx: 0, status: 'idle', connected: true, isHost,
        rebuyRequested: false, gracePurgeTimer: null,
      });
      room.game.order.push(socket.id);
      room.log(`${name} se sentó${isHost ? ' (HOST ★)' : ''}.`);
      socket.emit('joined', { id: socket.id, sessionId: newSessionId, name, isHost, roomId });
      if (room.game.phase === 'waiting') room.startBetting(); else room.broadcast();
    });

    socket.on('request_rebuy', () => {
      const p = room.game.players.get(socket.id); if (!p) return;
      if (p.chips >= MIN_BET) { socket.emit('error_msg', 'Aún tienes fichas suficientes.'); return; }
      if (p.rebuyRequested) return;
      p.rebuyRequested = true;
      room.log(`✋ ${p.name} pidió fichas al HOST.`);
      room.broadcast();
    });

    socket.on('bet', (data) => {
      if (room.game.phase !== 'betting') return;
      const p = room.game.players.get(socket.id); if (!p) return;
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
      room.broadcast();
    });

    socket.on('hit',       () => room.doAction(socket, 'hit'));
    socket.on('stand',     () => room.doAction(socket, 'stand'));
    socket.on('double',    () => room.doAction(socket, 'double'));
    socket.on('split',     () => room.doAction(socket, 'split'));
    socket.on('surrender', () => room.doAction(socket, 'surrender'));

    socket.on('host_rebuy', (targetId) => {
      if (!socket.data.isHost) { socket.emit('error_msg', 'Solo el HOST puede dar fichas.'); return; }
      const p = room.game.players.get(targetId); if (!p) return;
      p.chips += REBUY_AMOUNT;
      p.rebuyRequested = false;
      room.log(`HOST le dio ${REBUY_AMOUNT} a ${p.name}.`);
      room.broadcast();
    });

    socket.on('disconnect', () => {
      const p = room.game.players.get(socket.id); if (!p) return;
      p.connected = false;
      room.log(`${p.name} se desconectó (sesión guardada).`);
      let mustAdvance = false;
      if (room.game.phase === 'playing') {
        for (const h of p.hands) if (h.status === 'playing') h.status = 'stood';
        if (room.currentPlayerId() === socket.id) mustAdvance = true;
      }
      if (p.gracePurgeTimer) clearTimeout(p.gracePurgeTimer);
      p.gracePurgeTimer = setTimeout(() => room.purgePlayer(socket.id), SESSION_GRACE_MS);
      if (mustAdvance) room.advanceTurn(); else room.broadcast();
    });
  });
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

  const rooms = new Map();

  function getOrCreateRoom(roomId) {
    let r = rooms.get(roomId);
    if (!r) {
      if (rooms.size >= MAX_ROOMS_PER_NAMESPACE) return null;
      r = createRoom(roomId);
      rooms.set(roomId, r);
    }
    return r;
  }

  function destroyIfEmpty(roomId) {
    const r = rooms.get(roomId);
    if (!r) return;
    if (r.game.players.size === 0) {
      r.clearTimer();
      if (r.game.startCountdown) clearTimeout(r.game.startCountdown);
      rooms.delete(roomId);
    }
  }

  function createRoom(roomId) {
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
  function log(msg) { nsp.to(roomId).emit('log', { t: Date.now(), msg }); }
  function broadcast() {
    // Per-socket emit with redacted hole cards for opponents.
    // Prevents the server from leaking everyone's hole cards on the wire.
    const sids = nsp.adapter.rooms.get(roomId);
    if (!sids) return;
    for (const sid of sids) {
      const sock = nsp.sockets.get(sid);
      if (sock) sock.emit('state', publicStateFor(sid));
    }
  }

  function publicStateFor(forSocketId) {
    const curId = game.currentTurnIdx >= 0 ? game.handOrder[game.currentTurnIdx] : null;
    const players = game.order.map((id) => {
      const p = game.players.get(id);
      const reveal = id === forSocketId || game.phase === 'showdown' || p.holeRevealed === true;
      const hole = reveal
        ? p.hole
        : (p.hole || []).map(() => ({ r: '?', s: '?' }));
      return {
        id, name: p.name, chips: p.chips,
        bet: p.bet, totalBet: p.totalBet,
        hole,
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

  return {
    game, broadcast, log, publicStateFor, clearTimer,
    tryStartHand, doAction, afterAction, awardByFold,
  };
  }

  nsp.on('connection', (socket) => {
    const roomId = sanitizeRoomId(socket.handshake.query.room);
    const room = getOrCreateRoom(roomId);
    if (!room) {
      socket.emit('error_msg', 'Servidor lleno (demasiadas salas).');
      socket.disconnect(true);
      return;
    }
    socket.data.roomId = roomId;
    socket.join(roomId);

    const isHost = isLocalhostAddr(socket.handshake.address);
    socket.data.isHost = isHost;
    socket.emit('hello', { isHost, roomId });
    socket.emit('state', room.publicStateFor(socket.id));

    socket.on('join', (rawName) => {
      if (room.game.players.has(socket.id)) return;
      const name = String(rawName || '').trim().slice(0, 16) || `Jugador ${room.game.order.length + 1}`;
      if (room.game.order.length >= MAX_SEATS) { socket.emit('error_msg', `Mesa llena (máx ${MAX_SEATS}).`); return; }
      room.game.players.set(socket.id, {
        name, chips: STARTING_CHIPS, bet: 0, totalBet: 0,
        hole: [], holeRevealed: false, status: 'idle', acted: false,
        lastAction: null, handLabel: null, winnings: 0,
        connected: true, isHost,
      });
      room.game.order.push(socket.id);
      room.log(`${name} se sentó${isHost ? ' (HOST ★)' : ''}.`);
      socket.emit('joined', { id: socket.id, name, isHost, roomId });
      if (room.game.phase === 'waiting') {
        if (room.game.order.filter((id) => room.game.players.get(id).chips > 0).length >= 2) {
          if (!room.game.startCountdown) {
            room.log('Empezando en 4s…');
            room.game.startCountdown = setTimeout(() => {
              room.game.startCountdown = null;
              room.tryStartHand();
            }, 4000);
          }
        }
      }
      room.broadcast();
    });

    socket.on('fold',  () => room.doAction(socket, 'fold'));
    socket.on('check', () => room.doAction(socket, 'check'));
    socket.on('call',  () => room.doAction(socket, 'call'));
    socket.on('raise', (amt) => room.doAction(socket, 'raise', amt));
    socket.on('allin', () => room.doAction(socket, 'allin'));

    socket.on('host_rebuy', (targetId) => {
      if (!socket.data.isHost) { socket.emit('error_msg', 'Solo el HOST puede dar fichas.'); return; }
      const p = room.game.players.get(targetId); if (!p) return;
      p.chips += REBUY_AMOUNT;
      room.log(`HOST le dio ${REBUY_AMOUNT} a ${p.name}.`);
      room.broadcast();
      if (room.game.phase === 'waiting' && !room.game.startCountdown) {
        if (room.game.order.filter((id) => room.game.players.get(id).chips > 0).length >= 2) {
          room.game.startCountdown = setTimeout(() => { room.game.startCountdown = null; room.tryStartHand(); }, 2000);
        }
      }
    });

    socket.on('disconnect', () => {
      const g = room.game;
      const p = g.players.get(socket.id); if (!p) return;
      room.log(`${p.name} se fue.`);
      const wasInHand = g.handOrder.includes(socket.id);
      const wasTurn = wasInHand && g.handOrder[g.currentTurnIdx] === socket.id;
      if (wasInHand && p.status !== 'folded') {
        p.status = 'folded';
        p.acted = true;
      }
      const seatIdx = g.order.indexOf(socket.id);
      g.order = g.order.filter((id) => id !== socket.id);
      if (seatIdx >= 0 && seatIdx < g.dealerSeat) g.dealerSeat--;
      if (g.dealerSeat >= g.order.length) g.dealerSeat = 0;
      g.handOrder = g.handOrder.filter((id) => id !== socket.id);
      g.players.delete(socket.id);

      if (g.order.length === 0) {
        g.phase = 'waiting'; g.currentTurnIdx = -1; room.clearTimer(); room.broadcast();
        destroyIfEmpty(roomId);
        return;
      }

      if (wasInHand) {
        const stillIn = g.handOrder.filter((id) => g.players.get(id).status !== 'folded');
        if (stillIn.length === 1 && g.phase !== 'showdown' && g.phase !== 'settle') {
          room.awardByFold(stillIn[0]); return;
        }
        if (wasTurn) {
          g.currentTurnIdx = Math.max(-1, g.currentTurnIdx - 1);
          if (g.handOrder.length > 0) room.afterAction();
        } else {
          if (g.currentTurnIdx >= g.handOrder.length) g.currentTurnIdx = 0;
        }
      }
      room.broadcast();
    });
  });
}

// ============================================================
// UNO (namespace /uno) — Tradicional + house rules
// ============================================================
setupUno(io.of('/uno'));

function setupUno(nsp) {
  const MAX_SEATS = 8;
  const MIN_PLAYERS = 2;
  const TURN_TIME_MS = 30000;
  const SESSION_GRACE_MS = 5 * 60 * 1000;
  const INITIAL_HAND = 7;
  const COLORS = ['R', 'Y', 'G', 'B'];

  function buildUnoDeck() {
    const cards = [];
    for (const c of COLORS) {
      cards.push({ color: c, value: 0 });
      for (let n = 1; n <= 9; n++) { cards.push({ color: c, value: n }); cards.push({ color: c, value: n }); }
      for (const a of ['skip', 'reverse', '+2']) { cards.push({ color: c, value: a }); cards.push({ color: c, value: a }); }
    }
    for (let i = 0; i < 4; i++) { cards.push({ color: 'W', value: 'wild' }); cards.push({ color: 'W', value: 'wild+4' }); }
    for (let i = cards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [cards[i], cards[j]] = [cards[j], cards[i]];
    }
    return cards;
  }

  const game = {
    phase: 'waiting',
    players: new Map(),
    order: [],
    currentTurnIdx: -1,
    direction: 1,
    drawPile: [],
    discardPile: [],
    discardTop: null,
    activeColor: null,
    pendingDraw: 0,
    turnEndsAt: 0,
    timer: null,
    winnerId: null,
    lastPlayerToReduce: null, // id of player who just played their penultimate card, must say UNO
  };

  function clearTimer() { if (game.timer) { clearTimeout(game.timer); game.timer = null; } }
  function setTurnTimer() {
    clearTimer();
    game.turnEndsAt = Date.now() + TURN_TIME_MS;
    game.timer = setTimeout(handleTurnTimeout, TURN_TIME_MS);
  }

  function broadcast() { nsp.emit('state', publicState()); }
  function emitHand(socketId) {
    const p = game.players.get(socketId);
    if (!p) return;
    nsp.to(socketId).emit('private:hand', { hand: p.hand });
  }
  function emitAllHands() { for (const id of game.order) emitHand(id); }
  function log(msg) { nsp.emit('log', { t: Date.now(), msg }); }

  function publicState() {
    const curId = currentPlayerId();
    const players = game.order.map((id) => {
      const p = game.players.get(id);
      return {
        id, name: p.name,
        cardCount: p.hand.length,
        saidUno: p.saidUno,
        connected: p.connected,
        isHost: p.isHost,
      };
    });
    return {
      phase: game.phase,
      players,
      currentTurn: curId,
      direction: game.direction,
      discardTop: game.discardTop,
      activeColor: game.activeColor,
      pendingDraw: game.pendingDraw,
      turnEndsAt: game.turnEndsAt,
      winnerId: game.winnerId,
      minPlayers: MIN_PLAYERS,
      maxSeats: MAX_SEATS,
    };
  }

  function currentPlayerId() {
    return game.currentTurnIdx >= 0 ? game.order[game.currentTurnIdx] : null;
  }

  function drawOne() {
    if (game.drawPile.length === 0) {
      // Reshuffle discard minus top
      if (game.discardPile.length <= 1) {
        game.drawPile = buildUnoDeck();
      } else {
        const top = game.discardPile.pop();
        const reshuffle = game.discardPile;
        game.discardPile = [top];
        for (let i = reshuffle.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [reshuffle[i], reshuffle[j]] = [reshuffle[j], reshuffle[i]];
        }
        game.drawPile = reshuffle;
      }
    }
    return game.drawPile.pop();
  }

  function drawMany(player, count) {
    for (let i = 0; i < count; i++) player.hand.push(drawOne());
  }

  function isPlayable(card) {
    if (game.pendingDraw > 0) {
      // Only +2 or +4 can be played to stack
      return card.value === '+2' || card.value === 'wild+4';
    }
    if (card.color === 'W') return true;
    if (card.color === game.activeColor) return true;
    if (game.discardTop && card.value === game.discardTop.value) return true;
    return false;
  }

  function advanceTurn(steps = 1) {
    if (game.order.length === 0) { game.currentTurnIdx = -1; return; }
    let idx = game.currentTurnIdx;
    for (let s = 0; s < steps; s++) {
      idx = (idx + game.direction + game.order.length) % game.order.length;
    }
    game.currentTurnIdx = idx;
  }

  function startRound() {
    if (game.order.length < MIN_PLAYERS) {
      game.phase = 'waiting';
      clearTimer();
      broadcast();
      return;
    }
    game.phase = 'playing';
    game.drawPile = buildUnoDeck();
    game.discardPile = [];
    game.direction = 1;
    game.pendingDraw = 0;
    game.winnerId = null;
    game.lastPlayerToReduce = null;
    for (const id of game.order) {
      const p = game.players.get(id);
      p.hand = [];
      p.saidUno = false;
      drawMany(p, INITIAL_HAND);
    }
    // Flip first discard; reshuffle if it's wild+4
    let first;
    do {
      first = drawOne();
      if (first.value === 'wild+4') {
        game.drawPile.unshift(first);
        // shuffle to bury it
        for (let i = game.drawPile.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [game.drawPile[i], game.drawPile[j]] = [game.drawPile[j], game.drawPile[i]];
        }
        first = null;
      }
    } while (!first);
    game.discardPile.push(first);
    game.discardTop = first;
    game.activeColor = first.color === 'W' ? COLORS[Math.floor(Math.random() * 4)] : first.color;
    game.currentTurnIdx = 0;
    log(`Nueva ronda. Carta inicial: ${cardLabel(first)}. Color: ${colorName(game.activeColor)}.`);

    // Apply first-card effect
    if (first.value === 'skip') { log(`${game.players.get(game.order[0]).name} pierde el turno.`); advanceTurn(1); }
    else if (first.value === 'reverse') {
      game.direction = -1;
      if (game.order.length === 2) advanceTurn(1); // in 2-player reverse acts like skip
      else { game.currentTurnIdx = game.order.length - 1; }
    } else if (first.value === '+2') {
      const victim = game.players.get(game.order[0]);
      drawMany(victim, 2);
      log(`${victim.name} roba 2 (carta inicial).`);
      advanceTurn(1);
    } else if (first.value === 'wild') {
      // Random color already chosen; just leave
    }
    setTurnTimer();
    emitAllHands();
    broadcast();
  }

  function handleTurnTimeout() {
    const id = currentPlayerId();
    if (!id) return;
    const p = game.players.get(id);
    if (!p) return;
    // Auto-draw 1 (or pendingDraw if any) and pass
    if (game.pendingDraw > 0) {
      drawMany(p, game.pendingDraw);
      log(`${p.name} roba ${game.pendingDraw} (tiempo).`);
      game.pendingDraw = 0;
    } else {
      drawMany(p, 1);
      log(`${p.name} roba 1 y pasa (tiempo).`);
    }
    p.saidUno = false;
    emitHand(id);
    advanceTurn(1);
    setTurnTimer();
    broadcast();
  }

  function cardLabel(card) {
    if (!card) return '?';
    const c = card.color === 'W' ? 'Wild' : colorName(card.color);
    return `${c} ${card.value}`;
  }
  function colorName(c) {
    return ({ R: 'Rojo', Y: 'Amarillo', G: 'Verde', B: 'Azul' })[c] || '?';
  }

  function findBySession(sessionId) {
    if (!sessionId || typeof sessionId !== 'string') return null;
    for (const [key, p] of game.players) if (p.sessionId === sessionId) return { key, player: p };
    return null;
  }

  function cleanName(raw) {
    if (typeof raw !== 'string') return '';
    let s = raw.trim().slice(0, 16);
    if (!s || s === '[object Object]' || /^\[object\s/i.test(s)) return '';
    return s;
  }

  function reattachSession(sessionId, socket, isHost, freshName) {
    const found = findBySession(sessionId);
    if (!found) return null;
    const { key: oldKey, player } = found;
    if (oldKey !== socket.id) {
      game.players.delete(oldKey);
      game.players.set(socket.id, player);
      const idx = game.order.indexOf(oldKey);
      if (idx >= 0) game.order[idx] = socket.id;
    }
    if (player.gracePurgeTimer) { clearTimeout(player.gracePurgeTimer); player.gracePurgeTimer = null; }
    player.connected = true;
    // preserve player.isHost across reconnects
    const cleanedFresh = cleanName(freshName);
    if (!cleanName(player.name) && cleanedFresh) player.name = cleanedFresh;
    return player;
  }

  function promoteHostIfNeeded() {
    if (game.order.length === 0) return;
    const hasHost = game.order.some((id) => game.players.get(id)?.isHost);
    if (!hasHost) {
      const newHostId = game.order[0];
      const newHost = game.players.get(newHostId);
      if (newHost) {
        newHost.isHost = true;
        const s = nsp.sockets.get(newHostId);
        if (s) { s.data.isHost = true; s.emit('hello', { isHost: true }); }
        log(`${newHost.name} es el nuevo HOST ★.`);
      }
    }
  }

  function purgePlayer(socketId) {
    const p = game.players.get(socketId);
    if (!p || p.connected) return;
    log(`${p.name} dejó la mesa.`);
    const wasHost = p.isHost;
    const idx = game.order.indexOf(socketId);
    game.order = game.order.filter((id) => id !== socketId);
    game.players.delete(socketId);
    if (game.order.length === 0) {
      game.phase = 'waiting'; game.currentTurnIdx = -1; clearTimer(); broadcast(); return;
    }
    if (wasHost) promoteHostIfNeeded();
    if (game.order.length < MIN_PLAYERS && game.phase === 'playing') {
      // Last remaining wins
      const winner = game.players.get(game.order[0]);
      game.winnerId = game.order[0];
      game.phase = 'roundOver';
      clearTimer();
      log(`${winner.name} gana por abandono.`);
      broadcast();
      setTimeout(() => {
        game.phase = 'waiting';
        game.currentTurnIdx = -1;
        game.turnEndsAt = 0;
        clearTimer();
        broadcast();
      }, 6000);
      return;
    }
    if (idx >= 0 && game.currentTurnIdx >= game.order.length) game.currentTurnIdx = 0;
    if (idx >= 0 && idx < game.currentTurnIdx) game.currentTurnIdx--;
    broadcast();
  }

  function applyCardEffect(card, playerId, options) {
    // After a card lands, apply its effect and decide who plays next.
    // Returns nothing; mutates game state.
    const playerIdx = game.order.indexOf(playerId);
    if (playerIdx < 0) return;

    if (card.color === 'W') {
      const chosen = options && COLORS.includes(options.chosenColor) ? options.chosenColor : COLORS[0];
      game.activeColor = chosen;
    } else {
      game.activeColor = card.color;
    }

    if (card.value === '+2') {
      game.pendingDraw += 2;
      // Next player must respond
      game.currentTurnIdx = playerIdx;
      advanceTurn(1);
      return;
    }
    if (card.value === 'wild+4') {
      game.pendingDraw += 4;
      game.currentTurnIdx = playerIdx;
      advanceTurn(1);
      return;
    }
    if (card.value === 'skip') {
      game.currentTurnIdx = playerIdx;
      advanceTurn(2);
      return;
    }
    if (card.value === 'reverse') {
      game.direction *= -1;
      if (game.order.length === 2) {
        // Acts like skip
        game.currentTurnIdx = playerIdx;
        advanceTurn(2);
      } else {
        game.currentTurnIdx = playerIdx;
        advanceTurn(1);
      }
      return;
    }
    if (card.value === 7) {
      const targetId = options && options.swapTargetId;
      if (targetId && targetId !== playerId && game.players.has(targetId)) {
        const a = game.players.get(playerId);
        const b = game.players.get(targetId);
        const tmp = a.hand; a.hand = b.hand; b.hand = tmp;
        const tmpUno = a.saidUno; a.saidUno = b.saidUno; b.saidUno = tmpUno;
        log(`${a.name} intercambia mano con ${b.name}.`);
        emitHand(playerId); emitHand(targetId);
      }
      game.currentTurnIdx = playerIdx;
      advanceTurn(1);
      return;
    }
    if (card.value === 0) {
      // Rotate all hands in current direction
      if (game.order.length >= 2) {
        const hands = game.order.map((id) => game.players.get(id).hand);
        const unos = game.order.map((id) => game.players.get(id).saidUno);
        const n = game.order.length;
        for (let i = 0; i < n; i++) {
          const src = (i - game.direction + n) % n;
          const targetId = game.order[i];
          game.players.get(targetId).hand = hands[src];
          game.players.get(targetId).saidUno = unos[src];
        }
        log(`Rotación de manos (0).`);
        emitAllHands();
      }
      game.currentTurnIdx = playerIdx;
      advanceTurn(1);
      return;
    }
    // Plain number card
    game.currentTurnIdx = playerIdx;
    advanceTurn(1);
  }

  nsp.on('connection', (socket) => {
    socket.data.isHost = false;
    socket.emit('hello', { isHost: false });
    socket.emit('state', publicState());

    socket.on('join', (payload) => {
      const rawName = typeof payload === 'string' ? payload : payload?.name;
      const sessionId = typeof payload === 'object' && payload ? payload.sessionId : null;

      if (sessionId) {
        const player = reattachSession(sessionId, socket, false, rawName);
        if (player) {
          socket.data.isHost = !!player.isHost;
          socket.emit('joined', { id: socket.id, sessionId: player.sessionId, name: player.name, isHost: !!player.isHost });
          log(`${player.name} se reconectó.`);
          emitHand(socket.id);
          broadcast();
          return;
        }
      }

      if (game.players.has(socket.id)) return;
      const name = cleanName(rawName) || `Jugador ${game.order.length + 1}`;
      if (game.order.length >= MAX_SEATS) { socket.emit('error_msg', `Mesa llena (máx ${MAX_SEATS}).`); return; }
      if (game.phase === 'playing') { socket.emit('error_msg', 'Hay una ronda en curso; espera al final.'); return; }
      const hasHost = game.order.some((id) => game.players.get(id)?.isHost);
      const isHost = !hasHost; // first player to sit becomes host
      const newSessionId = crypto.randomUUID();
      game.players.set(socket.id, {
        sessionId: newSessionId, name, hand: [], saidUno: false,
        connected: true, isHost, gracePurgeTimer: null,
      });
      game.order.push(socket.id);
      socket.data.isHost = isHost;
      log(`${name} se sentó${isHost ? ' (HOST ★)' : ''}.`);
      socket.emit('joined', { id: socket.id, sessionId: newSessionId, name, isHost });
      broadcast();
    });

    socket.on('playCard', (data) => {
      if (game.phase !== 'playing') return;
      if (currentPlayerId() !== socket.id) { socket.emit('error_msg', 'No es tu turno.'); return; }
      const p = game.players.get(socket.id); if (!p) return;
      const idx = Number(data?.cardIdx);
      if (!Number.isInteger(idx) || idx < 0 || idx >= p.hand.length) { socket.emit('error_msg', 'Carta inválida.'); return; }
      const card = p.hand[idx];
      if (!isPlayable(card)) { socket.emit('error_msg', 'No puedes jugar esa carta ahora.'); return; }
      if ((card.value === 7) && (!data?.swapTargetId || !game.players.has(data.swapTargetId) || data.swapTargetId === socket.id)) {
        socket.emit('error_msg', 'Elige un jugador para intercambiar.'); return;
      }
      if (card.color === 'W' && !COLORS.includes(data?.chosenColor)) {
        socket.emit('error_msg', 'Elige un color.'); return;
      }
      // Penultimate-card UNO check happens BEFORE removing the card (count is about to drop)
      const willHaveOne = p.hand.length === 2;
      // Remove card
      p.hand.splice(idx, 1);
      game.discardPile.push(card);
      game.discardTop = card;
      log(`${p.name} juega ${cardLabel(card)}.`);
      if (willHaveOne) {
        game.lastPlayerToReduce = socket.id;
        // If they didn't already press UNO, they're vulnerable to Catch
        // saidUno can be set in advance OR right after; we leave it false here
      }
      if (p.hand.length === 0) {
        // Winner!
        game.winnerId = socket.id;
        game.phase = 'roundOver';
        clearTimer();
        log(`🏆 ${p.name} GANA la ronda.`);
        emitAllHands();
        broadcast();
        setTimeout(() => {
          game.phase = 'waiting';
          game.currentTurnIdx = -1;
          game.turnEndsAt = 0;
          game.winnerId = null;
          clearTimer();
          broadcast();
        }, 8000);
        return;
      }
      applyCardEffect(card, socket.id, data || {});
      // Reset saidUno for anyone other than the player who just played to 1
      for (const id of game.order) {
        const pp = game.players.get(id);
        if (pp.hand.length !== 1) pp.saidUno = false;
      }
      emitHand(socket.id);
      // Hands may have shuffled (0/7), re-emit
      if (card.value === 0 || card.value === 7) emitAllHands();
      setTurnTimer();
      broadcast();
    });

    socket.on('drawCard', () => {
      if (game.phase !== 'playing') return;
      if (currentPlayerId() !== socket.id) { socket.emit('error_msg', 'No es tu turno.'); return; }
      const p = game.players.get(socket.id); if (!p) return;
      if (game.pendingDraw > 0) {
        drawMany(p, game.pendingDraw);
        log(`${p.name} roba ${game.pendingDraw}.`);
        game.pendingDraw = 0;
        p.saidUno = false;
        emitHand(socket.id);
        advanceTurn(1);
        setTurnTimer();
        broadcast();
        return;
      }
      drawMany(p, 1);
      log(`${p.name} roba 1.`);
      emitHand(socket.id);
      // Player may now play the drawn card if playable, OR pass.
      // We let client decide via 'playCard' (still their turn) or 'pass'.
      broadcast();
    });

    socket.on('pass', () => {
      if (game.phase !== 'playing') return;
      if (currentPlayerId() !== socket.id) return;
      const p = game.players.get(socket.id); if (!p) return;
      p.saidUno = false;
      log(`${p.name} pasa.`);
      advanceTurn(1);
      setTurnTimer();
      broadcast();
    });

    socket.on('sayUno', () => {
      const p = game.players.get(socket.id); if (!p) return;
      // Valid when about to play penultimate (count == 2) OR right after (count == 1)
      if (p.hand.length === 1 || p.hand.length === 2) {
        p.saidUno = true;
        log(`${p.name}: ¡UNO!`);
        broadcast();
      }
    });

    socket.on('catchUno', (data) => {
      if (game.phase !== 'playing') return;
      const targetId = data?.playerId;
      if (!targetId || !game.players.has(targetId)) return;
      if (targetId === socket.id) return;
      const target = game.players.get(targetId);
      if (target.hand.length === 1 && !target.saidUno && game.lastPlayerToReduce === targetId) {
        drawMany(target, 2);
        target.saidUno = false; // they now have 3, no longer at uno
        game.lastPlayerToReduce = null;
        log(`¡Caught! ${target.name} no dijo UNO y roba 2.`);
        emitHand(targetId);
        broadcast();
      }
    });

    socket.on('jumpIn', (data) => {
      if (game.phase !== 'playing') return;
      if (game.pendingDraw > 0) { socket.emit('error_msg', 'No se puede jump-in con cartas pendientes.'); return; }
      const p = game.players.get(socket.id); if (!p) return;
      if (currentPlayerId() === socket.id) { socket.emit('error_msg', 'Ya es tu turno.'); return; }
      const idx = Number(data?.cardIdx);
      if (!Number.isInteger(idx) || idx < 0 || idx >= p.hand.length) return;
      const card = p.hand[idx];
      if (card.color === 'W') { socket.emit('error_msg', 'No puedes hacer jump-in con Wild.'); return; }
      if (!game.discardTop) return;
      if (card.color !== game.discardTop.color || card.value !== game.discardTop.value) {
        socket.emit('error_msg', 'Solo carta idéntica.'); return;
      }
      const willHaveOne = p.hand.length === 2;
      p.hand.splice(idx, 1);
      game.discardPile.push(card);
      game.discardTop = card;
      log(`${p.name} hace JUMP-IN con ${cardLabel(card)}.`);
      if (willHaveOne) game.lastPlayerToReduce = socket.id;
      if (p.hand.length === 0) {
        game.winnerId = socket.id;
        game.phase = 'roundOver';
        clearTimer();
        log(`🏆 ${p.name} GANA la ronda.`);
        emitAllHands();
        broadcast();
        setTimeout(() => {
          game.phase = 'waiting';
          game.currentTurnIdx = -1;
          game.turnEndsAt = 0;
          game.winnerId = null;
          clearTimer();
          broadcast();
        }, 8000);
        return;
      }
      // Move turn to the jumper, then apply effect
      game.currentTurnIdx = game.order.indexOf(socket.id);
      applyCardEffect(card, socket.id, {});
      for (const id of game.order) {
        const pp = game.players.get(id);
        if (pp.hand.length !== 1) pp.saidUno = false;
      }
      emitHand(socket.id);
      setTurnTimer();
      broadcast();
    });

    socket.on('host_force_start', () => {
      if (!socket.data.isHost) return;
      if (game.phase === 'waiting' && game.order.length >= MIN_PLAYERS) startRound();
    });

    socket.on('disconnect', () => {
      const p = game.players.get(socket.id); if (!p) return;
      p.connected = false;
      log(`${p.name} se desconectó (sesión guardada).`);
      if (p.gracePurgeTimer) clearTimeout(p.gracePurgeTimer);
      p.gracePurgeTimer = setTimeout(() => purgePlayer(socket.id), SESSION_GRACE_MS);
      // If it was their turn, auto-pass
      if (game.phase === 'playing' && currentPlayerId() === socket.id) {
        if (game.pendingDraw > 0) {
          drawMany(p, game.pendingDraw);
          game.pendingDraw = 0;
        } else {
          drawMany(p, 1);
        }
        advanceTurn(1);
        setTurnTimer();
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
  console.log('Rutas: /  /blackjack  /poker  /uno\n');
});
