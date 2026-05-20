const socket = io('/uno');
const $ = (id) => document.getElementById(id);

const joinModal = $('joinModal');
const joinBtn = $('joinBtn');
const nameInput = $('nameInput');
const hostBadge = $('hostBadge');
const phaseLabelEl = document.querySelector('#phase .phase-label');
const timerEl = $('timer');
const opponentsEl = $('opponents');
const drawPileEl = $('drawPile');
const discardCardEl = $('discardCard');
const colorRingEl = $('colorRing');
const pendingDrawEl = $('pendingDraw');
const directionArrowEl = $('directionArrow');
const myHandEl = $('myHand');
const myNameEl = $('myName');
const myCountEl = $('myCount');
const unoBtn = $('unoBtn');
const passBtn = $('passBtn');
const startBtn = $('startBtn');
const logEl = $('log');
const colorPicker = $('colorPicker');
const colorCancel = $('colorCancel');
const swapPicker = $('swapPicker');
const swapOptionsEl = $('swapOptions');
const swapCancel = $('swapCancel');
const winnerBanner = $('winnerBanner');
const winnerNameEl = $('winnerName');

// ====== Session / cookies ======
const SESSION_COOKIE = 'uno_session';
const NAME_COOKIE = 'uno_name';
function setCookie(name, value, days = 30) {
  const exp = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${exp}; path=/; SameSite=Lax`;
}
function getCookie(name) {
  const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}
function deleteCookie(name) {
  document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
}
function isValidName(n) {
  return typeof n === 'string' && n.length > 0 && n !== '[object Object]' && !/^\[object\s/.test(n);
}
let sessionId = getCookie(SESSION_COOKIE);
let storedName = getCookie(NAME_COOKIE);
if (storedName && !isValidName(storedName)) {
  deleteCookie(NAME_COOKIE);
  deleteCookie(SESSION_COOKIE);
  storedName = null;
  sessionId = null;
}

// ====== Local state ======
let myId = null;
let isHost = false;
let lastState = null;
let myHand = [];
let pendingPlay = null; // { cardIdx, card } awaiting color/swap choice

// ====== Render helpers ======
const COLOR_CLASS = { R: 'c-R', Y: 'c-Y', G: 'c-G', B: 'c-B', W: 'c-W' };

function valueGlyph(value) {
  if (value === 'skip') return 'Ø';
  if (value === 'reverse') return '⇄';
  if (value === '+2') return '+2';
  if (value === 'wild') return 'WILD';
  if (value === 'wild+4') return '+4';
  return String(value);
}
function isAction(value) {
  return value === 'skip' || value === 'reverse' || value === '+2' || value === 'wild' || value === 'wild+4';
}

function renderCard(card, opts = {}) {
  if (!card) return '';
  const colorClass = COLOR_CLASS[card.color] || 'c-W';
  const glyphTxt = valueGlyph(card.value);
  let glyphClass = '';
  if (card.value === 'wild') glyphClass = 'wild';
  else if (isAction(card.value)) glyphClass = 'action';
  const extraClass = [
    opts.inHand ? 'in-hand' : '',
    opts.discardTop ? 'discard-top' : '',
    opts.playable ? 'playable' : '',
    opts.unplayable ? 'unplayable' : '',
  ].filter(Boolean).join(' ');
  return `
    <div class="uno-card ${colorClass} ${extraClass}" data-idx="${opts.idx ?? ''}">
      ${card.color === 'W' ? '' : '<div class="ellipse"></div>'}
      <div class="corner tl">${glyphTxt}</div>
      <div class="glyph ${glyphClass}">${glyphTxt}</div>
      <div class="corner br">${glyphTxt}</div>
    </div>
  `;
}

function isPlayableLocal(card, state) {
  if (!state || !state.discardTop) return true;
  if (state.pendingDraw > 0) {
    return card.value === '+2' || card.value === 'wild+4';
  }
  if (card.color === 'W') return true;
  if (card.color === state.activeColor) return true;
  if (card.value === state.discardTop.value) return true;
  return false;
}

function renderMyHand(state) {
  if (!myHand.length) {
    myHandEl.innerHTML = '<div style="color:var(--text-dim);font-size:13px;padding:30px">Sin cartas</div>';
    return;
  }
  const myTurn = state && state.currentTurn === myId;
  const cards = myHand.map((c, idx) => {
    const playable = isPlayableLocal(c, state);
    return renderCard(c, {
      inHand: true,
      idx,
      playable: myTurn && playable,
      unplayable: myTurn && !playable,
    });
  }).join('');
  myHandEl.innerHTML = cards;
  myHandEl.querySelectorAll('.uno-card.in-hand').forEach((el) => {
    const idx = Number(el.dataset.idx);
    el.addEventListener('click', () => onHandCardClick(idx));
  });
}

function renderDiscard(state) {
  if (!state || !state.discardTop) {
    discardCardEl.innerHTML = '';
    colorRingEl.className = 'color-ring';
    return;
  }
  discardCardEl.innerHTML = renderCard(state.discardTop, { discardTop: true });
  const c = state.activeColor || (state.discardTop.color !== 'W' ? state.discardTop.color : 'R');
  colorRingEl.className = `color-ring c-${c}`;
}

function renderOpponents(state) {
  if (!state) { opponentsEl.innerHTML = ''; return; }
  const others = state.players.filter((p) => p.id !== myId);
  opponentsEl.innerHTML = others.map((p) => {
    const cur = state.currentTurn === p.id ? ' current' : '';
    const off = p.connected ? '' : ' disconnected';
    const unoFlag = p.cardCount === 1 ? '<span class="uno-flag">UNO</span>' : '';
    const catchVisible = p.cardCount === 1 && !p.saidUno;
    return `
      <div class="opponent${cur}${off}" data-id="${p.id}">
        <div class="card-back-mini"></div>
        <div class="op-name">${escapeHtml(p.name)}${p.isHost ? ' ★' : ''}</div>
        <div class="op-cards">${p.cardCount} carta${p.cardCount === 1 ? '' : 's'}${unoFlag}</div>
        <button class="catch-btn${catchVisible ? ' visible' : ''}" data-catch="${p.id}">CATCH!</button>
      </div>
    `;
  }).join('');
  opponentsEl.querySelectorAll('.catch-btn').forEach((b) => {
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const targetId = b.dataset.catch;
      socket.emit('catchUno', { playerId: targetId });
    });
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function renderTimer(state) {
  if (!state || !state.turnEndsAt || state.phase !== 'playing') {
    timerEl.textContent = '—';
    return;
  }
  const remaining = Math.max(0, Math.floor((state.turnEndsAt - Date.now()) / 1000));
  timerEl.textContent = `${remaining}s`;
}

function phaseLabel(phase) {
  return ({
    waiting: 'Esperando jugadores',
    playing: 'En juego',
    roundOver: 'Ronda terminada',
  })[phase] || phase;
}

function render() {
  const state = lastState;
  if (!state) return;
  phaseLabelEl.textContent = phaseLabel(state.phase);

  // Direction arrow
  if (state.direction === -1) directionArrowEl.classList.add('reverse');
  else directionArrowEl.classList.remove('reverse');

  renderOpponents(state);
  renderDiscard(state);
  renderMyHand(state);

  // Pending draw badge
  if (state.pendingDraw > 0) {
    pendingDrawEl.classList.remove('hidden');
    pendingDrawEl.textContent = `+${state.pendingDraw}`;
  } else {
    pendingDrawEl.classList.add('hidden');
  }

  // My info
  const me = state.players.find((p) => p.id === myId);
  if (me) {
    myNameEl.textContent = me.name;
    myCountEl.textContent = `${me.cardCount} carta${me.cardCount === 1 ? '' : 's'}`;
  }

  // UNO button — urgent when I have 2 cards (about to be 1) or 1 card (already at one)
  const myTurn = state.currentTurn === myId;
  const myCount = me ? me.cardCount : 0;
  if (myCount === 2 && myTurn) {
    unoBtn.classList.add('urgent');
    unoBtn.disabled = false;
  } else if (myCount === 1 && me && !me.saidUno) {
    unoBtn.classList.add('urgent');
    unoBtn.disabled = false;
  } else {
    unoBtn.classList.remove('urgent');
    unoBtn.disabled = !(myCount <= 2);
  }

  // Pass button (visible only when it's my turn AND there's no pending draw stack)
  // We don't track "just drew" perfectly client-side; expose pass when it's my turn always — server validates.
  if (myTurn && state.phase === 'playing') passBtn.classList.remove('hidden');
  else passBtn.classList.add('hidden');

  // Start button (lobby host only, during waiting phase)
  if (state.phase === 'waiting' && state.lobbyHostId === myId) startBtn.classList.remove('hidden');
  else startBtn.classList.add('hidden');

  // Winner banner
  if (state.phase === 'roundOver' && state.winnerId) {
    const w = state.players.find((p) => p.id === state.winnerId);
    winnerNameEl.textContent = w ? w.name : '—';
    winnerBanner.classList.remove('hidden');
  } else {
    winnerBanner.classList.add('hidden');
  }
}

// ====== Card click ======
function onHandCardClick(idx) {
  const card = myHand[idx];
  if (!card) return;
  const myTurn = lastState && lastState.currentTurn === myId;

  // Jump-in path: not my turn, same color+value as discard top, not a Wild
  if (!myTurn) {
    if (!lastState || !lastState.discardTop) return;
    if (card.color === 'W') return;
    if (lastState.pendingDraw > 0) return;
    if (card.color === lastState.discardTop.color && card.value === lastState.discardTop.value) {
      socket.emit('jumpIn', { cardIdx: idx });
    }
    return;
  }

  // Normal play: must be playable
  if (!isPlayableLocal(card, lastState)) return;

  // Need a color picker for Wild / Wild+4
  if (card.color === 'W') {
    pendingPlay = { cardIdx: idx, card, needsColor: true, needsSwap: false };
    openColorPicker();
    return;
  }
  // Need a swap target for 7
  if (card.value === 7) {
    pendingPlay = { cardIdx: idx, card, needsColor: false, needsSwap: true };
    openSwapPicker();
    return;
  }
  socket.emit('playCard', { cardIdx: idx });
}

function openColorPicker() {
  colorPicker.classList.remove('hidden');
}
function closeColorPicker() {
  colorPicker.classList.add('hidden');
  pendingPlay = null;
}
function openSwapPicker() {
  const others = (lastState?.players || []).filter((p) => p.id !== myId);
  swapOptionsEl.innerHTML = others.map((p) =>
    `<button data-target="${p.id}">${escapeHtml(p.name)} <span style="color:var(--text-dim);font-size:12px">(${p.cardCount} cartas)</span></button>`
  ).join('');
  swapOptionsEl.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => {
      const tid = b.dataset.target;
      if (pendingPlay) {
        socket.emit('playCard', { cardIdx: pendingPlay.cardIdx, swapTargetId: tid });
        pendingPlay = null;
      }
      swapPicker.classList.add('hidden');
    });
  });
  swapPicker.classList.remove('hidden');
}
function closeSwapPicker() {
  swapPicker.classList.add('hidden');
  pendingPlay = null;
}

colorPicker.querySelectorAll('.color-opt').forEach((b) => {
  b.addEventListener('click', () => {
    const color = b.dataset.color;
    if (pendingPlay) {
      socket.emit('playCard', { cardIdx: pendingPlay.cardIdx, chosenColor: color });
      pendingPlay = null;
    }
    colorPicker.classList.add('hidden');
  });
});
colorCancel.addEventListener('click', closeColorPicker);
swapCancel.addEventListener('click', closeSwapPicker);

// ====== Buttons ======
drawPileEl.addEventListener('click', () => {
  if (!lastState || lastState.phase !== 'playing') return;
  if (lastState.currentTurn !== myId) return;
  socket.emit('drawCard');
});
unoBtn.addEventListener('click', () => { socket.emit('sayUno'); });
passBtn.addEventListener('click', () => { socket.emit('pass'); });
startBtn.addEventListener('click', () => { socket.emit('startGame'); });

// ====== Join flow ======
joinBtn.addEventListener('click', tryJoin);
nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryJoin(); });

function tryJoin() {
  const name = (nameInput.value || '').trim().slice(0, 16);
  if (!name) { nameInput.focus(); return; }
  setCookie(NAME_COOKIE, name);
  socket.emit('join', { name, sessionId });
}

// Auto-rejoin if we have a stored session
if (sessionId && storedName) {
  nameInput.value = storedName;
  socket.emit('join', { name: storedName, sessionId });
}

// ====== Socket events ======
socket.on('hello', ({ isHost: h }) => {
  isHost = h;
  if (h) hostBadge.classList.remove('hidden');
});

socket.on('joined', ({ id, sessionId: sid, name, isHost: h }) => {
  myId = id;
  if (sid) { sessionId = sid; setCookie(SESSION_COOKIE, sid); }
  if (name) setCookie(NAME_COOKIE, name);
  isHost = h;
  if (h) hostBadge.classList.remove('hidden');
  joinModal.classList.add('hidden');
});

socket.on('state', (state) => {
  lastState = state;
  render();
});

socket.on('private:hand', ({ hand }) => {
  myHand = hand || [];
  render();
});

socket.on('log', ({ msg }) => {
  const entry = document.createElement('div');
  entry.className = 'entry';
  entry.textContent = msg;
  logEl.appendChild(entry);
  while (logEl.children.length > 30) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
});

socket.on('error_msg', (msg) => {
  // Toast-ish: flash in log
  const entry = document.createElement('div');
  entry.className = 'entry';
  entry.style.color = 'var(--uno-red)';
  entry.textContent = '⚠ ' + msg;
  logEl.appendChild(entry);
  while (logEl.children.length > 30) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
});

// Tick the timer
setInterval(() => renderTimer(lastState), 1000);
