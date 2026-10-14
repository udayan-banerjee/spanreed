const http = require("http");
const express = require("express");
const { WebSocketServer, WebSocket } = require("ws");
const path = require("path");
const { messageHandler } = require("./routers/messageRouter");

const app = express();
app.use(express.static(path.join(__dirname, "..", "client")));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function safeSend(socket, obj) {
  if(!socket) return;
  if(socket.readyState !== WebSocket.OPEN) return;
  try {
    let reply = JSON.stringify(obj);
    socket.send(reply);
  } catch (error) {
    console.error(error);
  }
}

wss.on("connection", (ws) => {
  console.log("client connected");
  
  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (error) {
      safeSend(ws, { type: "error", reason: "invalid-json" });
      return;
    }

    if (typeof msg !== "object" || msg === null || typeof msg.type !== "string") {
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
      safeSend(ws, { type:"error", reason:"internal-error" });
    }
  });

  ws.on("close", () => console.log("client left"));
});

server.listen(3000, () => console.log("Running"));