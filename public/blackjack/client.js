const socket = io("/blackjack");
const $ = (id) => document.getElementById(id);
const phaseEl = $("phase");
const timerEl = $("timer");
const dealerHandEl = $("dealerHand");
const dealerTotalEl = $("dealerTotal");
const tableEl = $("table");
const controlsEl = $("controls");
const logEl = $("log");
const joinModal = $("joinModal");
const joinBtn = $("joinBtn");
const nameInput = $("nameInput");
const hostBadge = $("hostBadge");

let myId = null;
let isHost = false;
let lastState = null;
const MIN_BET = 10;

// Pending bet state (local until "Confirm")
let pending = { main: 0, under: 0, exact: 0, over: 0 };
let activeSlot = "main";

// Pip placement (x%, y%) inside the card body
const PIP_LAYOUTS = {
  2: [
    [50, 22],
    [50, 78],
  ],
  3: [
    [50, 22],
    [50, 50],
    [50, 78],
  ],
  4: [
    [30, 22],
    [70, 22],
    [30, 78],
    [70, 78],
  ],
  5: [
    [30, 22],
    [70, 22],
    [50, 50],
    [30, 78],
    [70, 78],
  ],
  6: [
    [30, 22],
    [70, 22],
    [30, 50],
    [70, 50],
    [30, 78],
    [70, 78],
  ],
  7: [
    [30, 22],
    [70, 22],
    [50, 35],
    [30, 50],
    [70, 50],
    [30, 78],
    [70, 78],
  ],
  8: [
    [30, 22],
    [70, 22],
    [50, 35],
    [30, 50],
    [70, 50],
    [50, 65],
    [30, 78],
    [70, 78],
  ],
  9: [
    [30, 22],
    [70, 22],
    [30, 40],
    [70, 40],
    [50, 50],
    [30, 60],
    [70, 60],
    [30, 78],
    [70, 78],
  ],
  10: [
    [30, 20],
    [70, 20],
    [50, 30],
    [30, 42],
    [70, 42],
    [30, 58],
    [70, 58],
    [50, 70],
    [30, 80],
    [70, 80],
  ],
};

function phaseLabel(phase) {
  return (
    {
      waiting: "Esperando jugadores…",
      betting: "Hagan sus apuestas",
      dealing: "Repartiendo…",
      playing: "Jugando",
      dealer: "Juega el crupier",
      settle: "Pagando",
    }[phase] || phase
  );
}

function suitColor(s) {
  return s === "♥" || s === "♦" ? "red" : "black";
}

function renderCard(card) {
  if (!card || card.r === "?") return `<div class="card back"></div>`;
  const color = suitColor(card.s);
  const corners = `
    <div class="corner tl"><div>${card.r}</div><div>${card.s}</div></div>
    <div class="corner br"><div>${card.r}</div><div>${card.s}</div></div>`;
  if (["J", "Q", "K"].includes(card.r)) {
    return `<div class="card ${color}">${corners}
      <div class="face-art">${card.s}</div>
      <div class="face-letter">${card.r}</div>
    </div>`;
  }
  if (card.r === "A") {
    return `<div class="card ${color}">${corners}
      <div class="ace-center">${card.s}</div>
    </div>`;
  }
  const pips = (PIP_LAYOUTS[card.r] || [])
    .map(([x, y]) => {
      const flip = y > 50 ? " rotate(180deg)" : "";
      return `<span class="pip" style="left:${x}%;top:${y}%;transform:translate(-50%,-50%)${flip}">${card.s}</span>`;
    })
    .join("");
  return `<div class="card ${color}">${corners}
    <div class="pips">${pips}</div>
  </div>`;
}

function renderHand(cards) {
  return cards.map(renderCard).join("");
}

function handResultBadge(h) {
  if (h.result === "bj") return `<span class="badge bj">BLACKJACK 3:2</span>`;
  if (h.result === "win") return `<span class="badge win">+${h.bet}</span>`;
  if (h.result === "lose") return `<span class="badge lose">-${h.bet}</span>`;
  if (h.result === "push") return `<span class="badge push">EMPATE</span>`;
  if (h.result === "bust")
    return `<span class="badge bust">BUST -${h.bet}</span>`;
  if (h.result === "surrender")
    return `<span class="badge push">RENDIDO -${Math.ceil(h.bet / 2)}</span>`;
  if (h.status === "busted") return `<span class="badge bust">BUST</span>`;
  if (h.status === "blackjack") return `<span class="badge bj">BJ!</span>`;
  if (h.status === "surrendered")
    return `<span class="badge push">RENDIDO</span>`;
  if (h.status === "stood" && h.doubled)
    return `<span class="badge stood">DOBLADO</span>`;
  if (h.status === "stood") return `<span class="badge stood">PLANTADO</span>`;
  if (h.isCurrent) return `<span class="badge bet">TU MANO</span>`;
  if (h.status === "playing") return `<span class="badge bet">JUGANDO</span>`;
  return "";
}

function renderSideBets(p) {
  const sb = p.sideBets;
  const sr = p.sideResults || {};
  if (!sb || (!sb.under && !sb.exact && !sb.over)) return "";
  const cell = (key, label, amt) => {
    if (!amt) return "";
    const r = sr[key];
    const cls = r === "win" ? "sb-win" : r === "lose" ? "sb-lose" : "";
    return `<span class="sb ${cls}">${label}:${amt}</span>`;
  };
  const totalStr =
    p.sideTotal != null
      ? ` <span class="sb-total">Σ=${p.sideTotal}</span>`
      : "";
  return `<div class="side-bets">${cell("under", "Menor13", sb.under)}${cell(
    "exact",
    "★13 jackpot",
    sb.exact
  )}${cell("over", "Mayor13", sb.over)}${totalStr}</div>`;
}

function renderPlayer(p, state) {
  const isMe = p.id === myId;
  const isTurn = p.id === state.currentTurn;
  const cls = ["player"];
  if (isMe) cls.push("me");
  if (isTurn) cls.push("turn");
  if (!p.connected) cls.push("disconnected");

  const handsHtml =
    p.hands.length === 0
      ? `<div class="hand empty"><span class="muted">—</span></div>`
      : p.hands
          .map((h) => {
            const hcls = ["hand"];
            if (h.isCurrent) hcls.push("current");
            return `<div class="${hcls.join(" ")}">
          <div class="hand-cards">${renderHand(h.cards)}</div>
          <div class="hand-meta">
            <span class="total">${h.cards.length ? h.total : ""}</span>
            <span class="hand-bet">${
              h.bet ? `${h.bet}🪙${h.doubled ? " (x2)" : ""}` : ""
            }</span>
            ${handResultBadge(h)}
          </div>
        </div>`;
          })
          .join("");

  const hostBtn =
    isHost && !isMe
      ? `<button class="host-rebuy" data-id="${p.id}">+1000 (host)</button>`
      : "";

  return `<div class="${cls.join(" ")}">
    <div class="player-header">
      <span class="player-name">${escapeHtml(p.name)}${isMe ? " (tú)" : ""}${
    p.isHost ? " ★" : ""
  }</span>
      <span class="player-chips">${p.chips}🪙</span>
    </div>
    <div class="hands">${handsHtml}</div>
    ${renderSideBets(p)}
    ${hostBtn}
  </div>`;
}

function render(state) {
  lastState = state;
  phaseEl.textContent = phaseLabel(state.phase);
  dealerHandEl.innerHTML = renderHand(state.dealer.hand);
  dealerTotalEl.textContent = state.dealer.hand.length
    ? `(${state.dealer.total}${state.dealer.hideHole ? "+" : ""})`
    : "";
  tableEl.innerHTML = state.players.map((p) => renderPlayer(p, state)).join("");
  tableEl.querySelectorAll(".host-rebuy").forEach((btn) => {
    btn.onclick = () => socket.emit("host_rebuy", btn.dataset.id);
  });
  renderControls(state);
}

function getMe(state) {
  return state.players.find((p) => p.id === myId);
}

function renderControls(state) {
  const me = getMe(state);
  if (!me) {
    controlsEl.innerHTML = `<span class="bet-info">Esperando próxima ronda…</span>`;
    return;
  }

  // Player ran out of chips — no self-rebuy. Host must give them.
  if (me.chips < MIN_BET && state.phase === "betting") {
    controlsEl.innerHTML = `<span class="bet-info danger">Sin fichas suficientes. ${
      isHost
        ? "Tú eres el HOST — usa el botón de tu propio panel."
        : "Pide al HOST que te dé fichas."
    }</span>`;
    if (isHost) {
      const wrap = document.createElement("button");
      wrap.className = "btn-primary";
      wrap.textContent = "+1000 (host, tú)";
      wrap.onclick = () => socket.emit("host_rebuy", myId);
      controlsEl.appendChild(wrap);
    }
    return;
  }

  if (state.phase === "betting") {
    renderBettingControls(me);
    return;
  }

  if (state.phase === "playing" && state.currentTurn === myId) {
    const hand =
      me.hands[me.hands.findIndex((h) => h.isCurrent)] ||
      me.hands.find((h) => h.status === "playing");
    if (!hand) {
      controlsEl.innerHTML = `<span class="bet-info">…</span>`;
      return;
    }
    const isFirstAction = hand.cards.length === 2 && !hand.doubled;
    const canDouble = isFirstAction && me.chips >= hand.bet;
    const sameRank =
      isFirstAction &&
      hand.cards[0].r &&
      hand.cards[1].r &&
      cardRankValue(hand.cards[0].r) === cardRankValue(hand.cards[1].r);
    const canSplit = sameRank && me.chips >= hand.bet && me.hands.length < 4;
    const canSurr = isFirstAction && !hand.fromSplit;
    controlsEl.innerHTML = `
      <button class="btn-success" id="hitBtn">Pedir</button>
      <button class="btn-danger"  id="standBtn">Plantarse</button>
      <button class="btn-primary" id="doubleBtn" ${
        canDouble ? "" : "disabled"
      }>Doblar</button>
      <button class="btn-primary" id="splitBtn"  ${
        canSplit ? "" : "disabled"
      }>Dividir</button>
      <button class="btn-ghost"   id="surrBtn"   ${
        canSurr ? "" : "disabled"
      }>Rendirse</button>
      <span class="bet-info">Mano ${me.currentHandIdx ?? 0}: <strong>${
      hand.total
    }</strong> · Apuesta <strong>${hand.bet}🪙</strong> · Fichas <strong>${
      me.chips
    }🪙</strong></span>
    `;
    $("hitBtn").onclick = () => socket.emit("hit");
    $("standBtn").onclick = () => socket.emit("stand");
    $("doubleBtn").onclick = () => canDouble && socket.emit("double");
    $("splitBtn").onclick = () => canSplit && socket.emit("split");
    $("surrBtn").onclick = () => canSurr && socket.emit("surrender");
    return;
  }

  let info;
  if (state.phase === "playing") info = "Esperando turno…";
  else if (state.phase === "dealer") info = "El crupier juega…";
  else if (state.phase === "settle") info = "Próxima ronda en breve…";
  else if (state.phase === "dealing") info = "Cartas en camino…";
  else info = "Esperando jugadores…";
  controlsEl.innerHTML = `<span class="bet-info">${info} · Fichas: <strong>${me.chips}🪙</strong></span>`;
}

function cardRankValue(r) {
  if (r === "A") return 11;
  if (["K", "Q", "J"].includes(r)) return 10;
  return parseInt(r, 10);
}

function renderBettingControls(me) {
  const placed = {
    main: me.bet,
    under: me.sideBets.under,
    exact: me.sideBets.exact,
    over: me.sideBets.over,
  };
  // If everything pending is 0, show whatever is already placed
  const show = {
    main: pending.main || placed.main,
    under: pending.under || placed.under,
    exact: pending.exact || placed.exact,
    over: pending.over || placed.over,
  };
  const isDirty =
    pending.main !== placed.main ||
    pending.under !== placed.under ||
    pending.exact !== placed.exact ||
    pending.over !== placed.over;
  // Available chips after subtracting NEW intended bets
  const totalRequested =
    (pending.main || placed.main) +
    (pending.under || placed.under) +
    (pending.exact || placed.exact) +
    (pending.over || placed.over);
  const totalBank =
    me.chips + placed.main + placed.under + placed.exact + placed.over;
  const remaining = totalBank - totalRequested;

  const slotBtn = (key, title, sub) => {
    const active = activeSlot === key ? " active" : "";
    const placedAmt = placed[key];
    const newAmt = show[key];
    const diff = newAmt - placedAmt;
    const diffStr =
      diff > 0
        ? ` <span class="diff">+${diff}</span>`
        : diff < 0
        ? ` <span class="diff neg">${diff}</span>`
        : "";
    return `<button class="bet-slot ${key}${active}" data-slot="${key}">
      <div class="slot-title">${title}</div>
      <div class="slot-sub">${sub}</div>
      <div class="slot-amt">${newAmt}${diffStr}</div>
    </button>`;
  };

  controlsEl.innerHTML = `
    <div class="bet-slots">
    ${slotBtn("main", "Apuesta principal", `min ${MIN_BET}`)}
    <div class="bet-slots">
      ${slotBtn("under", "Menor a 13", "1:1")}
      ${slotBtn("exact", "★ 13 exacto ★", "JACKPOT 10:1")}
      ${slotBtn("over", "Mayor a 13", "1:1")}
    </div>
    </div>
    <div class="chip-row">
      <button class="chip-btn c10"  data-amt="10">10</button>
      <button class="chip-btn c25"  data-amt="25">25</button>
      <button class="chip-btn c100" data-amt="100">100</button>
      <button class="chip-btn c500" data-amt="500">500</button>
      <button class="btn-ghost" id="clearBet">Limpiar</button>
      <button class="btn-success" id="confirmBet" ${
        show.main < MIN_BET || remaining < 0 ? "disabled" : ""
      }>
        ${isDirty ? "Confirmar" : "OK"} ${show.main}+${
    show.under + show.exact + show.over
  }
      </button>
    </div>
    <div class="bet-info">Banco: <strong>${remaining}🪙</strong> de ${totalBank} · ${
    isDirty ? "<em>sin confirmar</em>" : "apuesta confirmada"
  }</div>
  `;
  controlsEl.querySelectorAll(".bet-slot").forEach((s) => {
    s.onclick = () => {
      activeSlot = s.dataset.slot;
      renderBettingControls(me);
    };
  });
  controlsEl.querySelectorAll(".chip-btn").forEach((b) => {
    b.onclick = () => {
      const amt = parseInt(b.dataset.amt, 10);
      // Initialize pending from placed if not yet touched
      if (
        pending.main === 0 &&
        pending.under === 0 &&
        pending.exact === 0 &&
        pending.over === 0
      ) {
        pending = { ...placed };
      }
      const tentative = { ...pending };
      tentative[activeSlot] = (tentative[activeSlot] || 0) + amt;
      const total =
        tentative.main + tentative.under + tentative.exact + tentative.over;
      if (total > totalBank) {
        showToast("No alcanzan las fichas.");
        return;
      }
      pending = tentative;
      renderBettingControls(me);
    };
  });
  $("clearBet").onclick = () => {
    pending = { main: 0, under: 0, exact: 0, over: 0 };
    renderBettingControls(me);
  };
  $("confirmBet").onclick = () => {
    const finalBet = {
      main: pending.main || placed.main,
      under: pending.under || placed.under,
      exact: pending.exact || placed.exact,
      over: pending.over || placed.over,
    };
    if (finalBet.main < MIN_BET) {
      showToast(`Apuesta mínima ${MIN_BET}.`);
      return;
    }
    socket.emit("bet", finalBet);
    pending = { main: 0, under: 0, exact: 0, over: 0 };
  };
}

function updateTimer() {
  if (!lastState || !lastState.phaseEndsAt) {
    timerEl.textContent = "";
    return;
  }
  const remaining = Math.max(
    0,
    Math.ceil((lastState.phaseEndsAt - Date.now()) / 1000)
  );
  const show =
    remaining > 0 &&
    (lastState.phase === "betting" ||
      (lastState.phase === "playing" && lastState.currentTurn === myId));
  timerEl.textContent = show ? `${remaining}s` : "";
}
setInterval(updateTimer, 250);

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[c])
  );
}

function showToast(msg) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

socket.on("hello", ({ isHost: h }) => {
  isHost = !!h;
  if (hostBadge) hostBadge.classList.toggle("show", isHost);
});
socket.on("state", render);
socket.on("joined", ({ id, isHost: h }) => {
  myId = id;
  isHost = !!h;
  if (hostBadge) hostBadge.classList.toggle("show", isHost);
  joinModal.classList.add("hidden");
});
socket.on("error_msg", showToast);
socket.on("log", ({ msg }) => {
  const div = document.createElement("div");
  div.textContent = msg;
  logEl.appendChild(div);
  while (logEl.children.length > 40) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
});

joinBtn.onclick = () => socket.emit("join", nameInput.value.trim());
nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") joinBtn.click();
});
