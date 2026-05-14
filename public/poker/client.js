const socket = io('/poker');
const $ = (id) => document.getElementById(id);
const phaseEl   = $('phase');
const timerEl   = $('timer');
const potEl     = $('pot');
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
    waiting:   'Esperando jugadores…',
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

function renderCommunity(cards) {
  const slots = [];
  for (let i = 0; i < 5; i++) {
    slots.push(cards[i] ? renderCard(cards[i]) : `<div class="card-slot"></div>`);
  }
  return slots.join('');
}

function positionBadges(p, state) {
  const bits = [];
  if (p.isDealer)    bits.push(`<span class="pos-badge D">D</span>`);
  if (p.isSmallBlind)bits.push(`<span class="pos-badge SB">SB</span>`);
  if (p.isBigBlind)  bits.push(`<span class="pos-badge BB">BB</span>`);
  if (p.status === 'folded')  bits.push(`<span class="pos-badge FOLD">FOLD</span>`);
  if (p.status === 'all-in')  bits.push(`<span class="pos-badge ALLIN">ALL-IN</span>`);
  if (p.id === state.currentTurn) bits.push(`<span class="pos-badge TURN">TURNO</span>`);
  if (p.winnings && p.winnings > 0) bits.push(`<span class="pos-badge WIN">+${p.winnings}</span>`);
  return `<div class="position-badges">${bits.join('')}</div>`;
}

function renderPlayer(p, state) {
  const isMe = p.id === myId;
  const isTurn = p.id === state.currentTurn;
  const cls = ['player'];
  if (isMe) cls.push('me');
  if (isTurn) cls.push('turn');
  if (p.status === 'folded') cls.push('folded');
  if (!p.connected) cls.push('disconnected');

  const showHole = isMe || state.phase === 'showdown';
  let holeHtml = '';
  if (p.hole && p.hole.length) {
    if (showHole && p.holeRevealed !== false) {
      holeHtml = p.hole.map((c) => renderCard(c, true)).join('');
    } else {
      holeHtml = p.hole.map(() => renderCard({ r: '?', s: '?' }, true)).join('');
    }
  } else {
    holeHtml = `<div class="card small back" style="opacity:0.2"></div><div class="card small back" style="opacity:0.2"></div>`;
  }

  const handLabel = p.handLabel ? `<div class="show-hand">${p.handLabel}</div>` : '';
  const lastAction = p.lastAction ? `<span class="last-action">${p.lastAction}</span>` : '';
  const betStack = p.bet > 0 ? `<span class="bet-stack">${p.bet}🪙</span>` : '';

  const hostBtn = (isHost && !isMe) ? `<button class="host-rebuy" data-id="${p.id}">+1000 (host)</button>` : '';

  return `<div class="${cls.join(' ')}">
    <div class="player-header">
      <span class="player-name">${escapeHtml(p.name)}${isMe ? ' (tú)' : ''}${p.isHost ? ' ★' : ''}</span>
      <span class="player-chips">${p.chips}🪙</span>
    </div>
    ${positionBadges(p, state)}
    <div class="hole-cards">${holeHtml}</div>
    ${handLabel}
    <div class="player-foot">
      ${lastAction}
      ${betStack}
    </div>
    ${hostBtn}
  </div>`;
}

function render(state) {
  lastState = state;
  phaseEl.textContent = phaseLabel(state.phase);
  potEl.textContent = state.pot;
  if (state.phase === 'pre-flop' || state.phase === 'flop' || state.phase === 'turn' || state.phase === 'river') {
    betInfoEl.innerHTML = `Apuesta actual: <strong>${state.currentBet}</strong>${state.minRaise > 0 ? ` · Min raise: <strong>${state.minRaise}</strong>` : ''}`;
  } else if (state.phase === 'waiting') {
    betInfoEl.innerHTML = `<em>Esperando 2+ jugadores con fichas…</em>`;
  } else {
    betInfoEl.innerHTML = '';
  }
  communityEl.innerHTML = renderCommunity(state.community);
  tableEl.innerHTML = state.players.map((p) => renderPlayer(p, state)).join('');
  tableEl.querySelectorAll('.host-rebuy').forEach((btn) => {
    btn.onclick = () => socket.emit('host_rebuy', btn.dataset.id);
  });
  renderControls(state);
}

function getMe(state) { return state.players.find((p) => p.id === myId); }

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
      btn.className = 'btn-primary';
      btn.textContent = '+1000 (host, tú)';
      btn.onclick = () => socket.emit('host_rebuy', myId);
      controlsEl.appendChild(btn);
    }
    return;
  }
  if (state.currentTurn !== myId) {
    let info;
    if (state.phase === 'waiting')      info = 'Esperando inicio de mano…';
    else if (state.phase === 'showdown') info = 'Mostrando cartas…';
    else if (state.phase === 'settle')   info = 'Próxima mano en breve…';
    else                                 info = 'Esperando turno…';
    controlsEl.innerHTML = `<span class="info-line">${info} · Fichas: <strong>${me.chips}🪙</strong></span>`;
    return;
  }

  // It's my turn — render action buttons
  const toCall = Math.max(0, state.currentBet - (me.bet || 0));
  const canCheck = toCall === 0;
  const canCall  = toCall > 0 && me.chips > 0;
  const minRaiseTotal = state.currentBet + state.minRaise; // total bet for a raise
  const maxRaiseTotal = (me.bet || 0) + me.chips; // total possible bet (all-in)
  const canRaise = me.chips > toCall;
  // Initialize raiseValue sensibly
  if (!raiseValue || raiseValue < minRaiseTotal || raiseValue > maxRaiseTotal) {
    raiseValue = Math.min(maxRaiseTotal, Math.max(minRaiseTotal, state.currentBet ? minRaiseTotal : state.bigBlind || 10));
  }

  const raiseBtnLabel = state.currentBet > 0 ? `Subir a ${raiseValue}` : `Apostar ${raiseValue}`;

  controlsEl.innerHTML = `
    <button class="btn-danger"  id="foldBtn">Pasarse (fold)</button>
    ${canCheck
      ? `<button class="btn-ghost"   id="checkBtn">Pasar (check)</button>`
      : `<button class="btn-success" id="callBtn"${canCall ? '' : ' disabled'}>Pagar ${toCall}</button>`}
    <button class="btn-primary" id="raiseBtn"${canRaise ? '' : ' disabled'}>${raiseBtnLabel}</button>
    <button class="btn-danger"  id="allinBtn">All-in (${maxRaiseTotal})</button>
    <div class="raise-controls">
      <input type="range" id="raiseSlider" min="${minRaiseTotal}" max="${maxRaiseTotal}" step="1" value="${raiseValue}" ${canRaise ? '' : 'disabled'}/>
      <input type="number" id="raiseInput" min="${minRaiseTotal}" max="${maxRaiseTotal}" value="${raiseValue}" ${canRaise ? '' : 'disabled'}/>
      <div class="raise-presets">
        <button data-preset="min">Min</button>
        <button data-preset="pot50">½ Bote</button>
        <button data-preset="pot">Bote</button>
        <button data-preset="max">Max</button>
      </div>
    </div>
    <span class="info-line">Tus fichas <strong>${me.chips}🪙</strong> · Tu bet <strong>${me.bet || 0}🪙</strong> · Por pagar <strong>${toCall}🪙</strong></span>
  `;

  $('foldBtn').onclick  = () => socket.emit('fold');
  if (canCheck) $('checkBtn').onclick = () => socket.emit('check');
  else if (canCall) $('callBtn').onclick = () => socket.emit('call');
  $('raiseBtn').onclick = () => canRaise && socket.emit('raise', raiseValue);
  $('allinBtn').onclick = () => socket.emit('allin');

  const slider = $('raiseSlider');
  const input  = $('raiseInput');
  if (slider) slider.oninput = () => {
    raiseValue = parseInt(slider.value, 10);
    input.value = raiseValue;
    $('raiseBtn').textContent = (state.currentBet > 0 ? 'Subir a ' : 'Apostar ') + raiseValue;
  };
  if (input) input.onchange = () => {
    let v = parseInt(input.value, 10);
    if (isNaN(v)) v = minRaiseTotal;
    v = Math.max(minRaiseTotal, Math.min(maxRaiseTotal, v));
    raiseValue = v;
    slider.value = v;
    input.value = v;
    $('raiseBtn').textContent = (state.currentBet > 0 ? 'Subir a ' : 'Apostar ') + v;
  };
  controlsEl.querySelectorAll('.raise-presets button').forEach((btn) => {
    btn.onclick = () => {
      const preset = btn.dataset.preset;
      let target;
      if (preset === 'min')   target = minRaiseTotal;
      else if (preset === 'pot50') target = (me.bet || 0) + toCall + Math.floor(state.pot / 2);
      else if (preset === 'pot')   target = (me.bet || 0) + toCall + state.pot;
      else                          target = maxRaiseTotal;
      target = Math.max(minRaiseTotal, Math.min(maxRaiseTotal, target));
      raiseValue = target;
      slider.value = target;
      input.value = target;
      $('raiseBtn').textContent = (state.currentBet > 0 ? 'Subir a ' : 'Apostar ') + target;
    };
  });
}

function updateTimer() {
  if (!lastState || !lastState.phaseEndsAt) { timerEl.textContent = ''; return; }
  const remaining = Math.max(0, Math.ceil((lastState.phaseEndsAt - Date.now()) / 1000));
  const show = remaining > 0 && lastState.currentTurn === myId;
  timerEl.textContent = show ? `${remaining}s` : '';
}
setInterval(updateTimer, 250);

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
  setTimeout(() => t.remove(), 2200);
}

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
  while (logEl.children.length > 50) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
});

joinBtn.onclick = () => socket.emit('join', nameInput.value.trim());
nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinBtn.click(); });
