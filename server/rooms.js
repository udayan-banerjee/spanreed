const { customAlphabet } = require("nanoid");
const makeCode = customAlphabet("0123456789", 4);
const rooms = new Map();

function createRoom(ws) {
  const code = makeCode();
  rooms.set(code, { clients: [ws], createdAt: Date.now() });
  ws.roomCode = code;
  console.log(code);
  return code;
}

function joinRoom(code, ws) {
  const room = rooms.get(code);
  if (!room) return { ok: false, reason: "not-found" };
  if (room.clients.length >= 2) return { ok: false, reason: "full" };
  room.clients.push(ws);
  ws.roomCode = code;
  return { ok: true };
}

function getPeer(ws) {
  const room = rooms.get(ws.roomCode);
  if (!room) return null;
  return room.clients.find((c) => c !== ws) || null;
}

module.exports = {
    createRoom,
    joinRoom,
    getPeer
}