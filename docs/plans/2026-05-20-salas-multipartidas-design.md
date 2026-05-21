# Salas para partidas simultáneas — Diseño

## Contexto

Hoy `/blackjack` y `/poker` corren **una sola partida global por namespace**: todos los que entren al URL juegan automáticamente en la misma mesa. Esto bloquea jugar dos partidas distintas al mismo tiempo (ej. dos grupos de amigos en la misma red, o un grupo que quiere dividirse en dos mesas). El objetivo es soportar **múltiples mesas concurrentes** del mismo juego, accesibles por código/link compartido.

## Decisiones de producto

| Tema | Decisión |
|---|---|
| Acceso | Solo por código/link compartido (no hay lobby con listado de mesas). |
| Alcance | Blackjack + Poker. Uno se deja para iteración futura. |
| Ciclo de vida | Sala vacía → se borra inmediatamente. |
| Default | `/blackjack` sin `?room=` cae a la sala fija `"lobby"`, que se crea y se borra como cualquier otra. |
| Crear privada | Botón "Nueva sala" genera código de 4 chars alfanuméricos y redirige a `/blackjack?room=XXXX`. |
| Host | Sin privilegios — todos los jugadores son iguales (igual que hoy). |

## Arquitectura

### Servidor (`server.js`)

Hoy cada namespace tiene `const game = { players, order, shoe, ... }` único. El refactor envuelve toda la lógica por-sala en un factory:

```js
const rooms = new Map(); // roomId -> RoomController

function createRoom(roomId) {
  const game = { /* mismo shape de antes */ };
  function broadcast() { nsp.to(roomId).emit('state', publicState()); }
  function log(msg)    { nsp.to(roomId).emit('log', { t: Date.now(), msg }); }
  // ... resto de funciones (startBetting, dealCards, advanceTurn, etc.)
  return { game, broadcast, log, ...handlers };
}

function getOrCreateRoom(roomId) {
  let r = rooms.get(roomId);
  if (!r) { r = createRoom(roomId); rooms.set(roomId, r); }
  return r;
}

function destroyIfEmpty(roomId) {
  const r = rooms.get(roomId);
  if (r && r.game.players.size === 0) { r.clearTimer(); rooms.delete(roomId); }
}
```

Las funciones que antes cerraban sobre `game` ahora cierran sobre el `game` de su sala (mismo código adentro, solo cambia el alcance del closure). Constantes (`STARTING_CHIPS`, `MIN_BET`, `MAX_SEATS`, ...) y helpers puros (`rankValue`, `handTotal`, `cleanName`) se quedan a nivel `setupBlackjack` para no duplicarse por sala.

**Connection handler**:
```js
nsp.on('connection', (socket) => {
  const roomId = sanitizeRoomId(socket.handshake.query.room) || 'lobby';
  const room = getOrCreateRoom(roomId);
  if (!room) { socket.emit('error_msg', 'Servidor lleno.'); socket.disconnect(); return; }
  socket.data.roomId = roomId;
  socket.join(roomId);
  // resto del handler usa room.game, room.doAction, etc.
});
```

**Broadcast scoped**:
- Blackjack: `nsp.emit('state', ...)` → `nsp.to(roomId).emit('state', ...)`.
- Poker: igual, pero como hoy emite per-socket (para ocultar hole cards al resto), filtra a sockets que pertenecen a la sala: `nsp.adapter.rooms.get(roomId)` + `nsp.sockets.get(sid)`.

**Disconnect**: tras quitar al jugador de `game.players`, llamar `destroyIfEmpty(roomId)`.

### Cliente (`public/blackjack/client.js`, `public/poker/client.js`)

```js
const params = new URLSearchParams(location.search);
const roomId = sanitizeRoomId(params.get('room')) || 'lobby';
const socket = io('/blackjack', { query: { room: roomId } });
```

**Cookie de sesión** (solo blackjack — poker no tiene reconnect hoy): cambiar nombre de cookie a `bj_session__${roomId}` y `bj_name__${roomId}` para que cada sala mantenga su propio token sin pisarse entre URLs.

**UI mínima nueva en el header**:
- Badge "Sala: `XXXX`" + botón copiar link (o "Sala pública" si `roomId === 'lobby'`).
- Botón "Nueva sala" que genera código y hace `location = '/blackjack?room=' + code`.

### Routing

No se agregan rutas. `/blackjack` sigue sirviendo el HTML; el cliente lee `?room=` del URL.

## Edge cases

| Caso | Manejo |
|---|---|
| Caracteres inválidos en `?room=` | Sanitizar a `[A-Za-z0-9_-]{1,16}`. Si no pasa, caer a `'lobby'`. |
| Sala se borra mientras alguien conecta con ese código | `getOrCreateRoom` la recrea — el nuevo entra a una sala vacía con el mismo nombre. Aceptable. |
| Colisión de código generado | 4 chars alfanuméricos = ~1.6M combos. Reintentar si el código ya existe en el momento de generarlo (chequeo local en el cliente no aplica — solo lo crea al entrar). En la práctica colisión es despreciable; si dos URLs nuevos coinciden, ambos jugadores entran a la misma sala. |
| Cap de salas | Limitar a 100 salas activas por namespace. Si se excede, rechazar con `error_msg`. |
| Cap de jugadores por sala | Mantener `MAX_SEATS` actual (BJ=5, Poker=6) sin cambios. |
| Reconexión a otra sala | Cookie scoped por roomId; si cambias de URL, vas como jugador nuevo a esa sala. |

## Archivos a modificar

- `server.js` — refactor de `setupBlackjack` y `setupPoker` (Uno queda intacto).
- `public/blackjack/client.js` — leer `?room=`, scoped cookies, helper `sanitizeRoomId`.
- `public/blackjack/index.html` — badge de sala + botón "Nueva sala" en el header.
- `public/poker/client.js` — leer `?room=`.
- `public/poker/index.html` — badge de sala + botón "Nueva sala".
- (Opcional) CSS mínimo para el badge si no se reusa `host-badge`.

## Verificación

1. **Smoke namespaces**: `node -c server.js` para confirmar parse, luego `npm start` y abrir `/blackjack` + `/blackjack?room=TEST` en pestañas distintas. Confirmar acciones aisladas.
2. **Multi-juego**: repetir con `/poker` y `/poker?room=XYZ`. Verificar que las cartas comunitarias y hole cards de una sala NO leakean a la otra.
3. **Cleanup**: cerrar todas las pestañas de una sala privada y, al reabrir con el mismo código, confirmar que la sala empezó de cero (los chips del jugador anterior se perdieron — comportamiento esperado por la decisión "borrar inmediatamente").
4. **Reconexión BJ**: en `/blackjack?room=ABCD` con partida en curso, recargar pestaña. Debe re-entrar a la misma sala con el mismo sessionId.
5. **Default**: entrar a `/blackjack` sin query. Debe caer a sala `lobby`. Otro browser entrando a `/blackjack?room=lobby` debe verlo.

## Alternativas consideradas (no elegidas)

- **Extraer clase `Room` compartida entre BJ y Poker**: más DRY, pero `server.js` es flat-procedural y los dos juegos tienen state shapes distintos. Over-engineering para 2 juegos.
- **Solo Socket.io rooms sin Map propio**: imposible compartir `game.players` entre sockets del mismo room sin un Map externo. No simplifica nada.
- **Lobby con listado de salas públicas**: descartado por decisión de producto (queremos solo código/link).
