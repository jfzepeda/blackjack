# UNO Traditional — Design

**Date:** 2026-05-16
**Status:** Approved
**Scope:** Add traditional UNO (with house rules) as a third game alongside Blackjack and Poker.

## Decisions

- Rules: **Tradicional + house rules** — stacking +2/+4, jump-in, 7-0 swap.
- Format: **Una mano por partida**, 2–8 jugadores.
- Aesthetic: **UNO icónico** (rojo/amarillo/verde/azul) sobre fondo oscuro neutro.

## 1. Architecture

Mirrors the existing per-game namespace pattern in `server.js`:

- `app.get('/uno', ...)` route.
- `setupUno(io.of('/uno'))` block alongside `setupBlackjack` and `setupPoker`.
- `public/uno/{index.html, client.js, style.css}`.
- Third game card on `public/index.html` lobby.

Reuses cross-game pieces: `crypto.randomUUID` for session ids, `isLocalhostAddr` for host detection. UNO uses its own 108-card deck (not the shared `buildShoe`).

## 2. Card Model

```
Card = { color: 'R'|'Y'|'G'|'B'|'W', value: 0..9 | 'skip' | 'reverse' | '+2' | 'wild' | 'wild+4' }
```

108-card deck:
- 4 colors × (1 zero + 2 each of 1–9 + 2 Skip + 2 Reverse + 2 +2) = 100
- 4 Wild + 4 Wild +4 = 8

## 3. Server State

```
game = {
  phase: 'waiting' | 'playing' | 'roundOver',
  players: Map<sid, {sessionId, name, hand, saidUno, connected, isHost, gracePurgeTimer}>,
  order: sid[],
  currentTurnIdx,
  direction: +1 | -1,
  discardTop,                       // Card
  drawPile,                         // Card[]
  pendingDraw: 0 | 2 | 4 | 6 ...,   // stacking accumulator
  activeColor: 'R'|'Y'|'G'|'B',     // Wild override
  turnEndsAt, timer,
  winnerId
}
```

Constants: `MAX_SEATS = 8`, `MIN_PLAYERS = 2`, `TURN_TIME_MS = 30000`, `SESSION_GRACE_MS = 5 * 60 * 1000`.

## 4. Rules

**Setup:** 7 cards per player. First discard drawn from pile; if Wild+4, reshuffle until non-+4. If Wild → first player picks color. If action card → effect applies to first player.

**Legality:** A card is playable if (a) color matches `activeColor`, (b) value matches discard top value, or (c) card is Wild/Wild+4. While `pendingDraw > 0`, only `+2` or `+4` are playable (stacking).

**Stacking (+2/+4):** Either type can be stacked onto either type. Player who can't stack draws `pendingDraw` and loses turn. (Simplified vs official: any combination allowed.)

**Jump-in:** Out of turn, a player may play a card identical (same color AND same value) to discard top. Turn jumps to them, then continues from there. Wilds cannot jump-in. Disabled while `pendingDraw > 0`.

**7-0:**
- Play a 7 → choose target player, swap hands.
- Play a 0 → all hands rotate in current direction.

**UNO call / Catch:** When a player plays their penultimate card, they must press "UNO!" within a small window (we use: must be pressed when count == 2, before their next turn comes back around). Any opponent can press "Catch!" on them; if they hadn't called, they draw 2.

**+4 challenge:** Skipped for simplicity — Wild+4 always legal (house rule simplification).

**Action card on first discard:**
- Skip → skip player 0
- Reverse → reverse before play starts
- +2 → first player draws 2, skipped

**Reshuffling:** When draw pile empties, shuffle discard pile (minus current top) back in.

**Win:** First to empty their hand. Round ends, server emits `event:winner`, then auto-resets to `waiting` after 8s with same seated players (option to deal a new round if 2+ present).

## 5. Socket.io Events

**Client → server:**
- `join({name, sessionId?})`
- `playCard({cardIdx, chosenColor?, swapTargetId?})`
- `drawCard()` — also pulls `pendingDraw` if active
- `pass()` — only valid right after drawing one non-playable card
- `sayUno()`
- `catchUno({playerId})`
- `jumpIn({cardIdx})`

**Server → clients:**
- `state` — phase, turn, direction, top, activeColor, conteos por jugador, pendingDraw, turnEndsAt
- `private:hand` — only to that socket
- `log` — text feed
- `error_msg` — invalid action reason

## 6. Client UI

Layout:
- Center: draw pile (face-down) + discard pile (face-up); ring around discard tinted to `activeColor`.
- Direction arrow circling the table area, flipped by Reverse.
- Your hand at the bottom in a horizontal fan; click to play.
- Other players as avatars positioned around the table with card-back count badge.
- **UNO!** button (prominent yellow) — flashes when your count drops to 2.
- **Catch!** mini-button on each opponent avatar.
- Color picker overlay on Wild/Wild+4 play.
- Player picker overlay on 7 play.
- Pending draw badge when `pendingDraw > 0`.

Aesthetic:
- Background: `#15161a`.
- UNO palette: Red `#ED1C24`, Yellow `#FFD700`, Green `#3DAF38`, Blue `#0066B3`.
- Cards: rounded rect, color background, white inner ellipse, large number/icon in color.
- Typography: Poppins / Inter for chrome; large bold italic "UNO" wordmark.

## 7. Error Handling / Edge Cases

- Invalid play → `error_msg` with reason, state unchanged.
- Disconnect mid-turn → auto-draw 1 + auto-pass after turn timeout; `SESSION_GRACE_MS` before full purge.
- Empty draw pile → reshuffle discard minus top.
- All but one player disconnect → that player wins.
- Player tries to call "UNO!" outside window → no-op.

## 8. Testing

- `node --check server.js`
- `node --check public/uno/client.js`
- HTTP smoke test: `/uno`, `/uno/client.js`, `/uno/style.css` → 200.
- Manual 2-player playthrough covering: number cards, Skip, Reverse, +2 stacking, Wild + color pick, +4 stacking on +2, 7 swap, 0 rotation, jump-in, UNO! call, Catch.
