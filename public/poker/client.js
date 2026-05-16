const socket = io('/poker');
const $ = (id) => document.getElementById(id);
const phaseLabelEl = document.querySelector('#phase .phase-label');
const timerEl   = $('timer');
const potEl     = $('pot');
const potStackEl = $('potStack');
const potAreaEl = $('potArea');
const betInfoEl = $('bet-info');
const communityEl = $('community');
const tableEl   = $('table');
const controlsEl = $('controls');
const logEl     = $('log');
const joinModal = $('joinModal');
const joinBtn   = $('joinBtn');
const nameInput = $('nameInput');
const hostBadge = $('hostBadge');

let myId = null;
let isHost = false;
let lastState = null;
let raiseValue = 0;
let lastBets = new Map();         // pid -> last bet for diff
let lastCommunityCount = 0;       // for sequential reveal
let lastPlayerIds = new Set();    // to detect adds/removes

const CHIP_ICO = `<svg class="chip-ico" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="#fbbf24" stroke="#7a4622" stroke-width="2" stroke-dasharray="2.5 2"/><circle cx="12" cy="12" r="4" fill="#fff5c2" stroke="#7a4622" stroke-width="0.5"/></svg>`;

const ICONS = {
  fold:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>`,
  check:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>`,
  call:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12l7 7 7-7"/></svg>`,
  raise:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>`,
  allin:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.5 14.5c0-3 3.5-4 3.5-7.5 0 2.5 3.5 4.5 3.5 8 0 2-1.5 3.5-3.5 3.5s-3.5-1.5-3.5-4z"/><path d="M12 7c.5 1.5 0 3-1 4"/></svg>`,
};

const PIP_LAYOUTS = {
  '2':  [[50, 22], [50, 78]],
  '3':  [[50, 22], [50, 50], [50, 78]],
  '4':  [[30, 22], [70, 22], [30, 78], [70, 78]],
  '5':  [[30, 22], [70, 22], [50, 50], [30, 78], [70, 78]],
  '6':  [[30, 22], [70, 22], [30, 50], [70, 50], [30, 78], [70, 78]],
  '7':  [[30, 22], [70, 22], [50, 35], [30, 50], [70, 50], [30, 78], [70, 78]],
  '8':  [[30, 22], [70, 22], [50, 35], [30, 50], [70, 50], [50, 65], [30, 78], [70, 78]],
  '9':  [[30, 22], [70, 22], [30, 40], [70, 40], [50, 50], [30, 60], [70, 60], [30, 78], [70, 78]],
  '10': [[30, 20], [70, 20], [50, 30], [30, 42], [70, 42], [30, 58], [70, 58], [50, 70], [30, 80], [70, 80]],
};

function phaseLabel(phase) {
  return {
    waiting:   'Esperando jugadores',
    'pre-flop': 'Pre-flop',
    flop:      'Flop',
    turn:      'Turn',
    river:     'River',
    showdown:  'Showdown',
    settle:    'Pagando',
  }[phase] || phase;
}

function suitColor(s) { return (s === '♥' || s === '♦') ? 'red' : 'black'; }

function renderCard(card, small = false) {
  const sz = small ? ' small' : '';
  if (!card || card.r === '?') return `<div class="card back${sz}"></div>`;
  const color = suitColor(card.s);
  const corners = `
    <div class="corner tl"><div>${card.r}</div><div>${card.s}</div></div>
    <div class="corner br"><div>${card.r}</div><div>${card.s}</div></div>`;
  if (['J', 'Q', 'K'].includes(card.r)) {
    return `<div class="card ${color}${sz}">${corners}
      <div class="face-art">${card.s}</div>
      <div class="face-letter">${card.r}</div>
    </div>`;
  }
  if (card.r === 'A') {
    return `<div class="card ${color}${sz}">${corners}
      <div class="ace-center">${card.s}</div>
    </div>`;
  }
  const pips = (PIP_LAYOUTS[card.r] || []).map(([x, y]) => {
    const flip = y > 50 ? ' rotate(180deg)' : '';
    return `<span class="pip" style="left:${x}%;top:${y}%;transform:translate(-50%,-50%)${flip}">${card.s}</span>`;
  }).join('');
  return `<div class="card ${color}${sz}">${corners}
    <div class="pips">${pips}</div>
  </div>`;
}

/* ============================================================
   Community cards — sequential flip reveal
   ============================================================ */
function renderCommunity(cards) {
  const dealtCount = (cards || []).filter(Boolean).length;
  // Reset on new hand (count went down to 0)
  if (dealtCount < lastCommunityCount) lastCommunityCount = 0;

  const slots = [];
  for (let i = 0; i < 5; i++) {
    const c = cards[i];
    if (c) {
      const isNew = i >= lastCommunityCount;
      const delay = isNew ? (i - lastCommunityCount) * 150 : 0;
      slots.push(
        `<div class="card-flip${isNew ? ' dealt' : ''}" style="animation-delay:${delay}ms">${renderCard(c)}</div>`
      );
    } else {
      slots.push(`<div class="card-slot"></div>`);
    }
  }
  lastCommunityCount = dealtCount;
  return slots.join('');
}

/* ============================================================
   Pot chip stack
   ============================================================ */
function renderPotStack(pot) {
  if (!potStackEl) return;
  const maxChips = window.matchMedia('(max-width: 560px)').matches ? 12 : 18;
  const size = pot > 0 ? Math.min(maxChips, Math.max(1, Math.ceil(pot / 25))) : 0;
  const chips = [];
  for (let i = 0; i < size; i++) {
    chips.push(`<span class="pot-chip" style="--i:${i}">${CHIP_ICO}</span>`);
  }
  potStackEl.innerHTML = chips.join('');
}

/* ============================================================
   Chip flight animation (player slot → pot)
   ============================================================ */
function flyChip(fromEl, toEl) {
  if (!fromEl || !toEl) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const fromRect = fromEl.getBoundingClientRect();
  const toRect = toEl.getBoundingClientRect();
  const startX = fromRect.left + fromRect.width / 2 - 11;
  const startY = fromRect.top + fromRect.height / 2 - 11;
  const endX = toRect.left + toRect.width / 2 - 11;
  const endY = toRect.top + toRect.height / 2 - 11;

  const ghost = document.createElement('span');
  ghost.className = 'chip-ghost';
  ghost.innerHTML = CHIP_ICO;
  ghost.style.left = '0';
  ghost.style.top = '0';
  ghost.style.transform = `translate(${startX}px, ${startY}px)`;
  document.body.appendChild(ghost);

  const midX = (startX + endX) / 2;
  const midY = Math.min(startY, endY) - 60;

  const anim = ghost.animate(
    [
      { transform: `translate(${startX}px, ${startY}px) scale(1)`, offset: 0 },
      { transform: `translate(${midX}px, ${midY}px) scale(1.2)`,    offset: 0.5 },
      { transform: `translate(${endX}px, ${endY}px) scale(0.85)`,   offset: 1 },
    ],
    { duration: 520, easing: 'cubic-bezier(0.5, -0.2, 0.3, 1.2)' }
  );
  anim.onfinish = () => {
    ghost.remove();
    potEl.classList.add('bump');
    setTimeout(() => potEl.classList.remove('bump'), 320);
  };
}

/* ============================================================
   Player slot rendering — diff-update by data-pid
   ============================================================ */
function positionBadgesHtml(p, state) {
  const bits = [];
  if (p.isDealer)     bits.push(`<span class="pos-badge D" title="Dealer">D</span>`);
  if (p.isSmallBlind) bits.push(`<span class="pos-badge SB" title="Small Blind">SB</span>`);
  if (p.isBigBlind)   bits.push(`<span class="pos-badge BB" title="Big Blind">BB</span>`);
  if (p.status === 'folded')  bits.push(`<span class="pos-badge FOLD">FOLD</span>`);
  if (p.status === 'all-in')  bits.push(`<span class="pos-badge ALLIN">ALL-IN</span>`);
  if (p.id === state.currentTurn) bits.push(`<span class="pos-badge TURN">TURNO</span>`);
  if (p.winnings && p.winnings > 0) bits.push(`<span class="pos-badge WIN">+${p.winnings}</span>`);
  return bits.join('');
}

function createPlayerSlot(p) {
  const el = document.createElement('div');
  el.className = 'player';
  el.dataset.pid = p.id;
  el.innerHTML = `
    <div class="player-header">
      <span class="player-name"></span>
      <span class="player-chips"></span>
    </div>
    <div class="position-badges"></div>
    <div class="hole-cards"></div>
    <div class="show-hand"></div>
    <div class="player-foot">
      <span class="last-action"></span>
      <span class="bet-stack"></span>
    </div>
    <div class="host-actions"></div>
  `;
  return el;
}

function updatePlayerSlot(el, p, state) {
  const isMe = p.id === myId;
  const isTurn = p.id === state.currentTurn;
  const cls = ['player'];
  if (isMe) cls.push('me');
  if (isTurn) cls.push('turn');
  if (p.status === 'folded') cls.push('folded');
  if (!p.connected) cls.push('disconnected');
  // Preserve folding class if currently animating
  if (el.classList.contains('folding')) cls.push('folding');
  el.className = cls.join(' ');

  // Name
  const nameEl = el.querySelector('.player-name');
  nameEl.innerHTML =
    escapeHtml(p.name) +
    (isMe ? `<span class="me-tag">(tú)</span>` : '') +
    (p.isHost ? `<span class="host-star" aria-label="Anfitrión">★</span>` : '');

  // Chips
  el.querySelector('.player-chips').innerHTML = `${p.chips}${CHIP_ICO}`;

  // Badges
  el.querySelector('.position-badges').innerHTML = positionBadgesHtml(p, state);

  // Hole cards — server sends {r:'?',s:'?'} placeholders for opponents pre-showdown
  const holeEl = el.querySelector('.hole-cards');
  let holeHtml = '';
  if (p.hole && p.hole.length) {
    holeHtml = p.hole.map((c) => renderCard(c, true)).join('');
  } else {
    holeHtml = `<div class="card small back" style="opacity:0.2"></div><div class="card small back" style="opacity:0.2"></div>`;
  }
  if (holeEl.innerHTML !== holeHtml) holeEl.innerHTML = holeHtml;

  // Hand label
  const handEl = el.querySelector('.show-hand');
  handEl.textContent = p.handLabel || '';
  handEl.style.display = p.handLabel ? '' : 'none';

  // Last action
  el.querySelector('.last-action').textContent = p.lastAction || '';

  // Bet stack
  const betEl = el.querySelector('.bet-stack');
  if (p.bet > 0) {
    betEl.innerHTML = `${p.bet}${CHIP_ICO}`;
    betEl.style.display = '';
  } else {
    betEl.innerHTML = '';
    betEl.style.display = 'none';
  }

  // Host rebuy button
  const hostActions = el.querySelector('.host-actions');
  if (isHost && !isMe) {
    if (!hostActions.querySelector('button')) {
      hostActions.innerHTML = `<button class="host-rebuy" data-id="${p.id}" type="button">+1000 (host)</button>`;
      hostActions.querySelector('button').onclick = (e) => {
        e.preventDefault();
        socket.emit('host_rebuy', p.id);
      };
    }
  } else {
    hostActions.innerHTML = '';
  }
}

/* ============================================================
   Arc seating math (parabolic half-ellipse around community)
   ============================================================ */
function applyArcLayout(state) {
  const players = state.players;
  const N = players.length;
  const useArc = N >= 3 && !window.matchMedia('(max-width: 860px)').matches;

  if (!useArc) {
    tableEl.classList.remove('arc-mode');
    players.forEach((p) => {
      const el = tableEl.querySelector(`[data-pid="${p.id}"]`);
      if (!el) return;
      el.style.setProperty('--arc-x', '0px');
      el.style.setProperty('--arc-y', '0px');
    });
    return;
  }

  tableEl.classList.add('arc-mode');
  // Place self at bottom-center, others spread in arc above
  const myIdx = players.findIndex((p) => p.id === myId);
  // Build display order: if I'm in the table, put me last (visually bottom-center)
  const ordered = [];
  if (myIdx >= 0) {
    for (let i = 0; i < N; i++) {
      if (i !== myIdx) ordered.push(players[i]);
    }
    ordered.push(players[myIdx]);
  } else {
    ordered.push(...players);
  }

  const containerW = Math.min(tableEl.clientWidth || 800, 1100);
  const SPREAD_X = Math.min(containerW * 0.42, 420);
  const ARC_HEIGHT = 70;
  const Y_BASE = 60;

  ordered.forEach((p, i) => {
    const el = tableEl.querySelector(`[data-pid="${p.id}"]`);
    if (!el) return;
    // Position: -1..+1 where last index (me) is 0
    const M = ordered.length;
    // Spread others across the arc; place "me" at the bottom-center
    let arcX = 0, arcY = 0;
    if (M === 1) {
      arcX = 0; arcY = Y_BASE;
    } else if (p.id === myId) {
      arcX = 0; arcY = Y_BASE + 30;
    } else {
      const others = M - (myIdx >= 0 ? 1 : 0); // # of non-self
      const othersIdx = i; // i goes 0..others-1 for non-self players (since self is last)
      const t = others > 1 ? (othersIdx - (others - 1) / 2) / ((others - 1) / 2) : 0; // -1..+1
      arcX = t * SPREAD_X;
      arcY = -ARC_HEIGHT * (1 - t * t) - 20; // inverted parabola: top center, ends down
    }
    el.style.setProperty('--arc-x', `${arcX}px`);
    el.style.setProperty('--arc-y', `${arcY}px`);
  });
}

/* ============================================================
   Main render
   ============================================================ */
function render(state) {
  const prevState = lastState;
  lastState = state;

  // Header phase + bet info
  if (phaseLabelEl) phaseLabelEl.textContent = phaseLabel(state.phase);

  // Pot with bump if grew
  const prevPot = prevState?.pot || 0;
  potEl.textContent = state.pot;
  if (state.pot > prevPot) {
    potEl.classList.add('bump');
    setTimeout(() => potEl.classList.remove('bump'), 320);
  }
  renderPotStack(state.pot);

  if (state.phase === 'pre-flop' || state.phase === 'flop' || state.phase === 'turn' || state.phase === 'river') {
    betInfoEl.innerHTML = `Apuesta actual: <strong>${state.currentBet}</strong>${state.minRaise > 0 ? ` · Min raise: <strong>${state.minRaise}</strong>` : ''}`;
  } else if (state.phase === 'waiting') {
    betInfoEl.innerHTML = `<em>Esperando 2+ jugadores con fichas…</em>`;
  } else if (state.phase === 'showdown') {
    betInfoEl.innerHTML = `<em>Mostrando cartas</em>`;
  } else if (state.phase === 'settle') {
    betInfoEl.innerHTML = `<em>Pagando bote</em>`;
  } else {
    betInfoEl.innerHTML = '';
  }

  // Community
  communityEl.innerHTML = renderCommunity(state.community || []);

  // Players — diff-update
  const newIds = new Set(state.players.map((p) => p.id));
  // Remove gone players
  lastPlayerIds.forEach((pid) => {
    if (!newIds.has(pid)) {
      const el = tableEl.querySelector(`[data-pid="${pid}"]`);
      if (el) el.remove();
    }
  });
  // Add/update
  state.players.forEach((p) => {
    let el = tableEl.querySelector(`[data-pid="${p.id}"]`);
    if (!el) {
      el = createPlayerSlot(p);
      tableEl.appendChild(el);
    }
    // Detect fold transition
    const prevP = prevState?.players?.find((q) => q.id === p.id);
    if (prevP && prevP.status !== 'folded' && p.status === 'folded') {
      el.classList.add('folding');
      setTimeout(() => el.classList.remove('folding'), 420);
    }
    updatePlayerSlot(el, p, state);
  });
  lastPlayerIds = newIds;

  // Apply arc positioning
  applyArcLayout(state);

  // Animate chip flights on bet increases
  state.players.forEach((p) => {
    const prevBet = lastBets.get(p.id) || 0;
    if (p.bet > prevBet && potAreaEl) {
      const el = tableEl.querySelector(`[data-pid="${p.id}"]`);
      const betEl = el?.querySelector('.bet-stack');
      flyChip(betEl && betEl.offsetParent ? betEl : el, potAreaEl);
    }
    // Reset tracker when hand ends (bet goes back to 0 or pot resets)
    if (p.bet === 0 && prevBet > 0 && state.pot === 0) {
      lastBets.set(p.id, 0);
    } else {
      lastBets.set(p.id, p.bet);
    }
  });
  // If pot was reset (new hand), clear bet tracker
  if (prevState && state.pot < (prevState.pot || 0) && state.pot === 0) {
    lastBets.clear();
  }

  renderControls(state);
}

function getMe(state) { return state.players.find((p) => p.id === myId); }

/* ============================================================
   Controls
   ============================================================ */
function renderControls(state) {
  const me = getMe(state);
  if (!me) {
    controlsEl.innerHTML = `<span class="info-line">Únete para jugar.</span>`;
    return;
  }
  if (me.chips <= 0 && state.phase !== 'showdown') {
    controlsEl.innerHTML = `<span class="info-line danger">Sin fichas. ${isHost ? 'Eres HOST — usa el botón.' : 'Pide al HOST que te dé fichas.'}</span>`;
    if (isHost) {
      const btn = document.createElement('button');
      btn.className = 'btn-glass btn-primary';
      btn.type = 'button';
      btn.textContent = '+1000 (host, tú)';
      btn.onclick = () => socket.emit('host_rebuy', myId);
      controlsEl.appendChild(btn);
    }
    return;
  }
  if (state.currentTurn !== myId) {
    let info;
    if (state.phase === 'waiting')       info = 'Esperando inicio de mano';
    else if (state.phase === 'showdown') info = 'Mostrando cartas';
    else if (state.phase === 'settle')   info = 'Próxima mano en breve';
    else                                  info = 'Esperando turno';
    controlsEl.innerHTML = `<span class="info-line">${info} · Fichas: <strong>${me.chips}</strong>${CHIP_ICO}</span>`;
    return;
  }

  // My turn — render action buttons
  const toCall = Math.max(0, state.currentBet - (me.bet || 0));
  const canCheck = toCall === 0;
  const canCall  = toCall > 0 && me.chips > 0;
  const minRaiseTotal = state.currentBet + state.minRaise;
  const maxRaiseTotal = (me.bet || 0) + me.chips;
  const canRaise = me.chips > toCall;

  if (!raiseValue || raiseValue < minRaiseTotal || raiseValue > maxRaiseTotal) {
    raiseValue = Math.min(maxRaiseTotal, Math.max(minRaiseTotal, state.currentBet ? minRaiseTotal : state.bigBlind || 10));
  }

  const raiseBtnLabel = state.currentBet > 0 ? `Subir a ${raiseValue}` : `Apostar ${raiseValue}`;
  const pct = maxRaiseTotal > minRaiseTotal
    ? ((raiseValue - minRaiseTotal) / (maxRaiseTotal - minRaiseTotal)) * 100
    : 0;

  controlsEl.innerHTML = `
    <button class="btn-glass btn-danger" id="foldBtn" type="button" aria-label="Pasarse">
      ${ICONS.fold}<span>Pasarse</span>
    </button>
    ${canCheck
      ? `<button class="btn-glass" id="checkBtn" type="button" aria-label="Pasar (check)">${ICONS.check}<span>Pasar</span></button>`
      : `<button class="btn-glass btn-success" id="callBtn" type="button" aria-label="Pagar ${toCall}"${canCall ? '' : ' disabled'}>${ICONS.call}<span>Pagar ${toCall}</span></button>`}
    <button class="btn-glass btn-primary" id="raiseBtn" type="button" aria-label="${raiseBtnLabel}"${canRaise ? '' : ' disabled'}>${ICONS.raise}<span>${raiseBtnLabel}</span></button>
    <button class="btn-glass btn-allin" id="allinBtn" type="button" aria-label="All-in ${maxRaiseTotal}">${ICONS.allin}<span>All-in (${maxRaiseTotal})</span></button>
    <span class="info-line">Fichas <strong>${me.chips}</strong>${CHIP_ICO} · Tu bet <strong>${me.bet || 0}</strong> · Por pagar <strong>${toCall}</strong></span>
    <div class="raise-controls">
      <div class="raise-slider-wrap">
        <input type="range" class="raise-slider" id="raiseSlider" min="${minRaiseTotal}" max="${maxRaiseTotal}" step="1" value="${raiseValue}" aria-label="Cantidad de raise" style="--pct: ${pct}%;" ${canRaise ? '' : 'disabled'}/>
      </div>
      <input type="number" class="raise-input" id="raiseInput" min="${minRaiseTotal}" max="${maxRaiseTotal}" value="${raiseValue}" aria-label="Cantidad numérica" ${canRaise ? '' : 'disabled'}/>
      <div class="raise-presets" role="group" aria-label="Presets de raise">
        <button class="preset-pill" data-preset="min" type="button">Min</button>
        <button class="preset-pill" data-preset="pot50" type="button">½ Bote</button>
        <button class="preset-pill" data-preset="pot" type="button">Bote</button>
        <button class="preset-pill" data-preset="max" type="button">Max</button>
      </div>
    </div>
  `;

  $('foldBtn').onclick  = () => socket.emit('fold');
  if (canCheck) $('checkBtn').onclick = () => socket.emit('check');
  else if (canCall) $('callBtn').onclick = () => socket.emit('call');
  $('raiseBtn').onclick = () => canRaise && socket.emit('raise', raiseValue);
  $('allinBtn').onclick = () => socket.emit('allin');

  const slider = $('raiseSlider');
  const input  = $('raiseInput');
  const updateRaiseUI = (v) => {
    raiseValue = v;
    if (slider) slider.value = v;
    if (input) input.value = v;
    const newPct = maxRaiseTotal > minRaiseTotal ? ((v - minRaiseTotal) / (maxRaiseTotal - minRaiseTotal)) * 100 : 0;
    if (slider) slider.style.setProperty('--pct', `${newPct}%`);
    const btn = $('raiseBtn');
    if (btn) btn.querySelector('span').textContent = (state.currentBet > 0 ? 'Subir a ' : 'Apostar ') + v;
  };
  if (slider) slider.oninput = () => updateRaiseUI(parseInt(slider.value, 10));
  if (input) input.onchange = () => {
    let v = parseInt(input.value, 10);
    if (isNaN(v)) v = minRaiseTotal;
    v = Math.max(minRaiseTotal, Math.min(maxRaiseTotal, v));
    updateRaiseUI(v);
  };
  controlsEl.querySelectorAll('.preset-pill').forEach((btn) => {
    btn.onclick = () => {
      const preset = btn.dataset.preset;
      let target;
      if (preset === 'min')         target = minRaiseTotal;
      else if (preset === 'pot50')  target = (me.bet || 0) + toCall + Math.floor(state.pot / 2);
      else if (preset === 'pot')    target = (me.bet || 0) + toCall + state.pot;
      else                           target = maxRaiseTotal;
      target = Math.max(minRaiseTotal, Math.min(maxRaiseTotal, target));
      updateRaiseUI(target);
    };
  });
}

/* ============================================================
   Timer
   ============================================================ */
function updateTimer() {
  if (!lastState || !lastState.phaseEndsAt) { timerEl.textContent = ''; timerEl.classList.remove('urgent'); return; }
  const remaining = Math.max(0, Math.ceil((lastState.phaseEndsAt - Date.now()) / 1000));
  const show = remaining > 0 && lastState.currentTurn === myId;
  if (show) {
    timerEl.textContent = `${remaining}s`;
    timerEl.classList.toggle('urgent', remaining <= 5);
  } else {
    timerEl.textContent = '';
    timerEl.classList.remove('urgent');
  }
}
setInterval(updateTimer, 250);

/* ============================================================
   Helpers
   ============================================================ */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function showToast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2400);
}

// Re-apply arc on resize
let resizeTimer = null;
window.addEventListener('resize', () => {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (lastState) applyArcLayout(lastState);
  }, 120);
});

/* ============================================================
   Socket
   ============================================================ */
socket.on('hello', ({ isHost: h }) => {
  isHost = !!h;
  if (hostBadge) hostBadge.classList.toggle('show', isHost);
});
socket.on('state', render);
socket.on('joined', ({ id, isHost: h }) => {
  myId = id;
  isHost = !!h;
  if (hostBadge) hostBadge.classList.toggle('show', isHost);
  joinModal.classList.add('hidden');
});
socket.on('error_msg', showToast);
socket.on('log', ({ msg }) => {
  const div = document.createElement('div');
  div.textContent = msg;
  logEl.appendChild(div);
  while (logEl.children.length > 60) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
});

joinBtn.onclick = () => socket.emit('join', nameInput.value.trim());
nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinBtn.click(); });
