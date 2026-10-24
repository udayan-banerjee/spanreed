const { createRoom, joinRoom, getPeer } = require("../rooms");

function messageHandler(ws, msg) {
  let replies = {
    reply: null,
    outbox: [],
  };

  switch (msg.type) {
    case "create-room": {
      const code = createRoom(ws);
      replies.reply = { type: "room-created", code };
      return replies;
    }

    case "join-room": {
      const result = joinRoom(msg.code, ws);
      if (!result.ok) {
        replies.reply = { type: "error", reason: result.reason };
        return replies;
      }

      const creator = getPeer(ws);
      replies.reply = { type: "room-joined", code: msg.code };
      replies.outbox.push({
        to: creator,
        msg: { type: "peer-joined", code: msg.code },
      });
      return replies;
    }

    case "chat": {
      const peer = getPeer(ws);
      if (!peer) {
        replies.reply = { type: "error", reason: "no-peer" };
        return replies;
      }

      replies.outbox.push({
        to: peer,
        msg: {
          type: "chat",
          text: String(msg.text),
          from: "peer",
          ts: Date.now(), // server clock = one truth
        }
      })
      return replies;
    }

    case "file-start": {
      const peer = getPeer(ws);
      if (!peer) {
        replies.reply = { type: "error", reason: "no-peer" };
        return replies;
      }

      replies.outbox.push({
        to: peer,
        msg: {
          type: msg.type,
          id: msg.id,
          name: msg.name,
          size: msg.size,
          mime: msg.mime
        }
      })
      return replies;
    }

    case "file-end": {
      const peer = getPeer(ws);
      if (!peer) {
        replies.reply = { type: "error", reason: "no-peer" };
        return replies;
      }

      replies.outbox.push({
        to: peer,
        msg: {
          type: msg.type,
          id: msg.id,
        }
      })
      return replies;
    }

    default: {
      replies.reply = { type: "error", reason: "unknown-type" };
      return replies;
    }
  }
}

module.exports = { messageHandler };
