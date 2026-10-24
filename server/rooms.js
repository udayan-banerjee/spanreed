const { customAlphabet } = require("nanoid");
const makeCode = customAlphabet("0123456789", 4);
const rooms = new Map();

// A room with only one person in it closes itself after this long.
const IDLE_LIMIT = 3 * 60 * 1000;

// rooms.js owns room state but never sends: index.js registers a handler here
// so every outgoing frame still goes through safeSend.
let onRoomExpired = () => {};
function setRoomExpiredHandler(fn) {
  onRoomExpired = fn;
}

function clearIdleTimer(code) {
  const room = rooms.get(code);
  if (room && room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }
}

function startIdleTimer(code) {
  const room = rooms.get(code);
  if (!room) return;
  clearIdleTimer(code);

  room.timer = setTimeout(() => {
    const dying = rooms.get(code);
    if (!dying) return;
    rooms.delete(code);
    // drop the back-reference too, or getPeer and disconnectRoom will keep
    // looking up a room that no longer exists
    for (const client of dying.clients) client.roomCode = undefined;
    onRoomExpired(dying.clients);
  }, IDLE_LIMIT);

  // an idle room should not hold the process open
  if (room.timer.unref) room.timer.unref();
}

function createRoom(ws) {
  const code = makeCode();
  rooms.set(code, { clients: [ws], createdAt: Date.now() });
  ws.roomCode = code;
  startIdleTimer(code); // nobody else here yet — start the clock
  console.log(code);
  return code;
}

function joinRoom(code, ws) {
  const room = rooms.get(code);
  if (!room) return { ok: false, reason: "not-found" };
  if (room.clients.length >= 2) return { ok: false, reason: "full" };
  room.clients.push(ws);
  ws.roomCode = code;
  clearIdleTimer(code); // two people now, so the room is no longer idle
  return { ok: true };
}

function getPeer(ws) {
  const room = rooms.get(ws.roomCode);
  if (!room) return null;
  return room.clients.find((c) => c !== ws) || null;
}

function disconnectRoom(ws) {
  const code = ws.roomCode;
  const room = rooms.get(code);
  if (!room) return null;

  room.clients.splice(room.clients.indexOf(ws), 1);

  if (room.clients.length === 0) {
    clearIdleTimer(code);
    rooms.delete(code);
    return null;
  }

  startIdleTimer(code); // someone is alone again — restart the clock
  return getPeer(ws);
}



module.exports = {
    createRoom,
    joinRoom,
    getPeer,
    disconnectRoom,
    setRoomExpiredHandler,
    IDLE_LIMIT,
}