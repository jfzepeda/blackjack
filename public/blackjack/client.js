const socket = io("/blackjack");
const $ = (id) => document.getElementById(id);
const phaseEl = $("phase");
const timerEl = $("timer");
const dealerHandEl = $("dealerHand");
const dealerTotalEl = $("dealerTotal");
const tableEl = $("table");
const controlsEl = $("controls");
const logEl = $("log");
const feltSlotsEl = $("feltSlots");
const leaderboardListEl = $("leaderboardList");
const joinModal = $("joinModal");
const joinBtn = $("joinBtn");
const nameInput = $("nameInput");
const hostBadge = $("hostBadge");

let myId = null;
let isHost = false;
let lastState = null;
const MIN_BET = 10;

// ====== Cookies / session ======
const SESSION_COOKIE = "bj_session";
const NAME_COOKIE = "bj_name";
function setCookie(name, value, days = 30) {
  const exp = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(
    value
  )}; expires=${exp}; path=/; SameSite=Lax`;
}
function getCookie(name) {
  const m = document.cookie.match(
    new RegExp("(?:^|; )" + name + "=([^;]*)")
  );
  return m ? decodeURIComponent(m[1]) : null;
}
function deleteCookie(name) {
  document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
}
function isValidName(n) {
  return (
    typeof n === "string" &&
    n.length > 0 &&
    n !== "[object Object]" &&
    !/^\[object\s/.test(n)
  );
}
let sessionId = getCookie(SESSION_COOKIE);
let storedName = getCookie(NAME_COOKIE);
// Self-heal a corrupted cookie from a prior buggy state ([object Object] etc.)
if (storedName && !isValidName(storedName)) {
  deleteCookie(NAME_COOKIE);
  deleteCookie(SESSION_COOKIE);
  storedName = null;
  sessionId = null;
}

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
            // Only render full-size cards in YOUR own panel; remote players'
            // cards live on the felt mat above.
            const cardsHtml = isMe
              ? `<div class="hand-cards">${renderHand(h.cards)}</div>`
              : "";
            return `<div class="${hcls.join(" ")}">
          ${cardsHtml}
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

  return `<div class="${cls.join(" ")}">
    <div class="player-header">
      <span class="player-name">${escapeHtml(p.name)}${isMe ? " (tú)" : ""}${
    p.isHost ? " ★" : ""
  }</span>
      <span class="player-chips">${p.chips}🪙</span>
    </div>
    <div class="hands">${handsHtml}</div>
    ${renderSideBets(p)}
  </div>`;
}

function renderLeaderboard(state) {
  if (!leaderboardListEl) return;
  const sorted = [...state.players].sort((a, b) => {
    if (b.chips !== a.chips) return b.chips - a.chips;
    return a.name.localeCompare(b.name);
  });
  leaderboardListEl.innerHTML = sorted
    .map((p, i) => {
      const rank = i + 1;
      const rankCls =
        rank === 1 ? "gold" : rank === 2 ? "silver" : rank === 3 ? "bronze" : "";
      const cls = ["lb-row"];
      if (p.id === myId) cls.push("me");
      if (p.id === state.currentTurn) cls.push("turn");
      if (!p.connected) cls.push("disconnected");
      if (p.chips < MIN_BET) cls.push("broke");
      const sb = p.sideBets || {};
      const totalBet =
        (p.bet || 0) + (sb.under || 0) + (sb.exact || 0) + (sb.over || 0);
      const metaParts = [];
      if (p.isHost) metaParts.push("HOST ★");
      if (!p.connected) metaParts.push("desconectado");
      if (totalBet > 0) metaParts.push(`apuesta ${totalBet}🪙`);
      if (p.rebuyRequested) metaParts.push("✋ pidió fichas");
      const hostBtn =
        isHost && p.id !== myId
          ? `<button class="lb-rebuy${
              p.rebuyRequested ? " urgent" : ""
            }" data-id="${p.id}">${
              p.rebuyRequested ? "✋ +1000" : "+1000"
            }</button>`
          : "";
      return `<li class="${cls.join(" ")}">
        <div class="lb-line">
          <span class="lb-rank ${rankCls}">${rank}</span>
          <span class="lb-name">${escapeHtml(p.name)}${
        p.id === myId ? " (tú)" : ""
      }</span>
          <span class="lb-chips">${p.chips}🪙</span>
        </div>
        <div class="lb-sub">
          <span class="lb-meta">${metaParts.join(" · ") || "&nbsp;"}</span>
          ${hostBtn}
        </div>
      </li>`;
    })
    .join("");
  leaderboardListEl.querySelectorAll(".lb-rebuy").forEach((btn) => {
    btn.onclick = () => socket.emit("host_rebuy", btn.dataset.id);
  });
}

function render(state) {
  lastState = state;
  phaseEl.textContent = phaseLabel(state.phase);
  dealerHandEl.innerHTML = renderHand(state.dealer.hand);
  dealerTotalEl.textContent = state.dealer.hand.length
    ? `(${state.dealer.total}${state.dealer.hideHole ? "+" : ""})`
    : "";
  const me = state.players.find((p) => p.id === myId);
  tableEl.innerHTML = me ? renderPlayer(me, state) : "";
  syncFelt(state);
  renderLeaderboard(state);
  renderControls(state);
}

function renderFeltHands(p) {
  if (!p.hands || p.hands.length === 0) return "";
  return p.hands
    .map((h) => {
      if (!h.cards || h.cards.length === 0) return "";
      const cls = ["felt-hand-row"];
      if (h.isCurrent) cls.push("current");
      if (h.status === "busted" || h.result === "bust") cls.push("busted");
      return `<div class="${cls.join(" ")}">${renderHand(h.cards)}</div>`;
    })
    .join("");
}

// ====== Felt / falling chips ======
const lastBets = new Map(); // playerId -> last known total bet
let feltInitialized = false;

function totalBet(p) {
  const sb = p.sideBets || {};
  return (p.bet || 0) + (sb.under || 0) + (sb.exact || 0) + (sb.over || 0);
}

// Greedy chip denomination breakdown, capped to maxChips so giant bets
// don't spam hundreds of chips on the felt.
function chipBreakdown(amount, maxChips = 10) {
  const denoms = [500, 100, 25, 10];
  const out = [];
  let r = amount;
  for (const d of denoms) {
    while (r >= d && out.length < maxChips) {
      out.push(d);
      r -= d;
    }
  }
  if (r > 0 && out.length < maxChips) out.push(10);
  return out;
}

function createChip(denom, stackIdx, animate) {
  const chip = document.createElement("div");
  chip.className = `felt-chip c${denom}` + (animate ? " dropping" : "");
  // Small lateral wobble for stack variation
  const dx = (Math.random() - 0.5) * 10;
  // Random initial spin while falling
  const ri = (Math.random() - 0.5) * 80;
  // Tiny final rotation so the stack isn't perfectly aligned
  const rf = (Math.random() - 0.5) * 14;
  chip.style.setProperty("--dx", dx.toFixed(1) + "px");
  chip.style.setProperty("--ri", ri.toFixed(1) + "deg");
  chip.style.setProperty("--rf", rf.toFixed(1) + "deg");
  chip.style.bottom = stackIdx * 4 + "px";
  chip.style.zIndex = String(stackIdx + 1);
  if (animate) {
    chip.style.animationDelay = stackIdx * 70 + "ms";
  } else {
    chip.style.transform = `translate(calc(-50% + ${dx.toFixed(
      1
    )}px), 0) rotate(${rf.toFixed(1)}deg)`;
  }
  chip.textContent = denom;
  return chip;
}

function buildStack(stackEl, amount, animate) {
  // Remove old chips (keep the shadow element if present)
  stackEl
    .querySelectorAll(".felt-chip")
    .forEach((c) => c.remove());
  if (amount <= 0) {
    stackEl.classList.remove("has-chips");
    return;
  }
  stackEl.classList.add("has-chips");
  const chips = chipBreakdown(amount);
  chips.forEach((d, i) => stackEl.appendChild(createChip(d, i, animate)));
}

function syncFelt(state) {
  const seen = new Set();
  for (const p of state.players) {
    seen.add(p.id);
    const total = totalBet(p);
    const prev = lastBets.has(p.id) ? lastBets.get(p.id) : null;

    let slot = feltSlotsEl.querySelector(`[data-pid="${p.id}"]`);
    if (!slot) {
      slot = document.createElement("div");
      slot.className = "felt-slot";
      slot.dataset.pid = p.id;
      slot.innerHTML = `
        <div class="felt-slot-name"></div>
        <div class="felt-hands"></div>
        <div class="chip-stack"><div class="chip-stack-shadow"></div></div>
        <div class="felt-slot-amt"></div>`;
      feltSlotsEl.appendChild(slot);
    }
    // Migration: ensure existing slots (from older session) have felt-hands.
    let handsEl = slot.querySelector(".felt-hands");
    if (!handsEl) {
      handsEl = document.createElement("div");
      handsEl.className = "felt-hands";
      slot.insertBefore(handsEl, slot.querySelector(".chip-stack"));
    }
    slot.classList.toggle("me", p.id === myId);
    slot.querySelector(".felt-slot-name").textContent =
      p.name + (p.id === myId ? " (tú)" : "");
    slot.querySelector(".felt-slot-amt").textContent = total
      ? `${total}🪙`
      : "";
    // Render this player's hand(s) on the felt
    handsEl.innerHTML = renderFeltHands(p);

    if (prev !== total) {
      const stackEl = slot.querySelector(".chip-stack");
      // Animate only when the bet GREW after the initial state sync.
      const animate = feltInitialized && total > (prev || 0);
      buildStack(stackEl, total, animate);
    }
    lastBets.set(p.id, total);
  }
  // Remove slots for players no longer in state
  [...feltSlotsEl.children].forEach((slot) => {
    if (!seen.has(slot.dataset.pid)) {
      lastBets.delete(slot.dataset.pid);
      slot.remove();
    }
  });
  feltInitialized = true;
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
        ? "Tú eres el HOST — usa el botón."
        : "Pide al HOST que te dé fichas."
    }</span>`;
    if (isHost) {
      const wrap = document.createElement("button");
      wrap.className = "btn-primary";
      wrap.textContent = "+1000 (host, tú)";
      wrap.onclick = () => socket.emit("host_rebuy", myId);
      controlsEl.appendChild(wrap);
    } else {
      const req = document.createElement("button");
      req.className = "btn-primary";
      req.textContent = me.rebuyRequested
        ? "Solicitud enviada ✓"
        : "Solicitar fichas al HOST";
      req.disabled = !!me.rebuyRequested;
      req.onclick = () => socket.emit("request_rebuy");
      controlsEl.appendChild(req);
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
socket.on("joined", ({ id, sessionId: sid, name, isHost: h }) => {
  myId = id;
  isHost = !!h;
  if (sid && typeof sid === "string") {
    sessionId = sid;
    setCookie(SESSION_COOKIE, sid);
  }
  if (isValidName(name)) {
    storedName = name;
    setCookie(NAME_COOKIE, name);
  }
  if (hostBadge) hostBadge.classList.toggle("show", isHost);
  joinModal.classList.add("hidden");
});
socket.on("error_msg", (msg) => {
  showToast(msg);
  // If auto-rejoin failed (table full, etc.), surface the modal again.
  if (!myId) {
    joinModal.classList.remove("hidden");
    if (storedName) nameInput.value = storedName;
  }
});
socket.on("log", ({ msg }) => {
  const div = document.createElement("div");
  div.textContent = msg;
  logEl.appendChild(div);
  while (logEl.children.length > 40) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
});

// Auto-rejoin: if we have a saved session, hide the modal and try to reattach
// on every connect (covers initial load + transient reconnects).
if (sessionId && storedName) {
  joinModal.classList.add("hidden");
  nameInput.value = storedName;
}
socket.on("connect", () => {
  if (sessionId && storedName) {
    socket.emit("join", { name: storedName, sessionId });
  }
});

joinBtn.onclick = () => {
  const name = nameInput.value.trim();
  if (!name) return;
  socket.emit("join", { name, sessionId });
};
nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") joinBtn.click();
});
if (storedName && !nameInput.value) nameInput.value = storedName;
