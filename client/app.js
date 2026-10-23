const proto = location.protocol === "https:" ? "wss" : "ws";
const ws = new WebSocket(`${proto}://${location.host}`);

const createBtn = document.getElementById("create");
createBtn.disabled = true;

const joinBtn = document.getElementById("join");
joinBtn.disabled = true;

const errormsg = document.getElementById("errormsg");

const errorList = {
  "not-found": "No room with that code. Check the digits and try again.",
  full: "That room already has two people.",
};

function renderMessage(from, text, ts) {
  const msgDisplay = document.querySelector(".message-display");

  const row = document.createElement("div");
  row.className = from === "You" ? "msg msg-own" : "msg msg-peer";

  const user = document.createElement("h4");
  user.textContent = from;

  const timestamp = document.createElement("time");
  const when = new Date(ts);
  timestamp.dateTime = when.toISOString();
  timestamp.textContent = when.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  const meta = document.createElement("div");
  meta.className = "msg-meta";
  meta.append(user, timestamp);

  const msg = document.createElement("p");
  msg.textContent = text;

  const body = document.createElement("div");
  body.className = "msg-body";
  body.append(meta, msg);

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "copy-btn";
  copyBtn.title = "Copy message";
  copyBtn.setAttribute("aria-label", "Copy message");
  copyBtn.addEventListener("click", () => {
    navigator.clipboard
      .writeText(text)
      // clipboard writes nothing visible, so flash the icon as the receipt
      .then(() => {
        copyBtn.classList.add("copied");
        setTimeout(() => copyBtn.classList.remove("copied"), 900);
      })
      .catch((error) => console.error(error));
  });

  row.append(body, copyBtn);
  msgDisplay.append(row);
  msgDisplay.scrollTop = msgDisplay.scrollHeight;
}

ws.addEventListener("open", () => {
  console.log("connected");
  createBtn.disabled = false;
  joinBtn.disabled = false;
});

ws.addEventListener("message", (e) => {
  const data = JSON.parse(e.data);

  if (data.type === "error") {
    errormsg.textContent = errorList[data.reason];
  }

  if (data.type === "room-created") {
    document.querySelector(".room-screen").hidden = false;
    document.querySelector(".home-screen").hidden = true;
    document.querySelector("#copycode").textContent = data.code;
  }

  if (data.type === "room-joined") {
    console.log("Room joined");
  }

  if (data.type === "peer-joined" || data.type === "room-joined") {
    document.querySelector(".joined-room").hidden = false;
    document.querySelector(".home-screen").hidden = true;
    document.querySelector(".room-screen").hidden = true;
  }

  if (data.type === "chat") renderMessage(data.from, data.text, data.ts);

  console.log(data);
});

ws.addEventListener("close", () => {
  console.log("disconnected");
  createBtn.disabled = true;
});

createBtn.addEventListener("click", () => {
  ws.send(JSON.stringify({ type: "create-room" }));
});

joinBtn.addEventListener("click", () => {
  const codeInput = document.getElementById("roomcode");

  ws.send(
    JSON.stringify({
      type: "join-room",
      code: codeInput.value,
    }),
  );
});

const message = document.querySelector("#messageForm");
message.addEventListener("submit", (e) => {
  e.preventDefault();

  const text = document.querySelector("#message").value;
  ws.send(JSON.stringify({ type: "chat", text: text }));

  renderMessage("You", text, Date.now())

  document.querySelector("#message").value = "";
});
