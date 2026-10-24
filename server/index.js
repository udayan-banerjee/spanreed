require("dotenv").config({ quiet: true });

const http = require("http");
const express = require("express");
const { WebSocketServer, WebSocket } = require("ws");
const path = require("path");
const { messageHandler } = require("./routers/messageRouter");
const {
  disconnectRoom,
  getPeer,
  setRoomExpiredHandler,
  IDLE_LIMIT,
} = require("./rooms");

const app = express();
app.use(express.static(path.join(__dirname, "..", "client")));
app.use("/design", express.static(path.join(__dirname, "..", "design")));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function safeSend(socket, obj) {
  if (!socket) return;
  if (socket.readyState !== WebSocket.OPEN) return;
  try {
    let reply = JSON.stringify(obj);
    socket.send(reply);
  } catch (error) {
    console.error(error);
  }
}

const PEER_HIGH_WATER = 1 * 1024 * 1024;

// rooms.js deletes the room itself; this just tells whoever was left behind
setRoomExpiredHandler((clients) => {
  for (const client of clients) safeSend(client, { type: "room-expired" });
});

wss.on("connection", (ws) => {
  console.log("client connected");

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      try {
        const peer = getPeer(ws);
        if (!peer || peer.readyState !== WebSocket.OPEN) return;

        peer.send(data, { binary: true }, () => {
          // fires once this chunk is actually written out to the peer.
          // Re-check rather than resuming blindly: other chunks may still
          // be queued, and pause/resume are not counted.
          if (peer.bufferedAmount <= PEER_HIGH_WATER) ws._socket.resume();
        });

        // The sender's own bufferedAmount only measures browser -> server,
        // which is never backed up. Stop reading from its socket so TCP
        // pushes back and the client's HIGH_WATER loop can finally fire.
        if (peer.bufferedAmount > PEER_HIGH_WATER) ws._socket.pause();
      } catch (error) {
        console.error(error);
      }
      return;
    }

    let msg;
    try {
      msg = JSON.parse(data);
    } catch (error) {
      safeSend(ws, { type: "error", reason: "invalid-json" });
      return;
    }

    if (
      typeof msg !== "object" ||
      msg === null ||
      typeof msg.type !== "string"
    ) {
      safeSend(ws, { type: "error", reason: "invalid-message" });
      return;
    }

    try {
      const handlerResult = messageHandler(ws, msg);
      if (handlerResult.reply) safeSend(ws, handlerResult.reply);
      for (const toBeSent of handlerResult.outbox)
        safeSend(toBeSent.to, toBeSent.msg);
    } catch (error) {
      console.error(error);
      safeSend(ws, { type: "error", reason: "internal-error" });
    }
  });

  ws.on("close", () => {
    console.log("client left");
    try {
      let peer = disconnectRoom(ws);
      // closesIn travels with the message so the client never hardcodes a
      // duration that could drift from IDLE_LIMIT
      if (peer) safeSend(peer, { type: "peer-left", closesIn: IDLE_LIMIT });
    } catch (error) {
      console.error(error);
      safeSend(ws, { type: "error", reason: "close-error" });
    }
  });
});

server.listen(process.env.PORT || 3000, () => console.log("Running"));
