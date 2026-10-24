const proto = location.protocol === "https:" ? "wss" : "ws";
const ws = new WebSocket(`${proto}://${location.host}`);
let incoming = new Map();
let latestFileID;
ws.binaryType = "arraybuffer";

const createBtn = document.getElementById("create");
createBtn.disabled = true;

const joinBtn = document.getElementById("join");
joinBtn.disabled = true;

const errormsg = document.getElementById("errormsg");

const errorList = {
  "not-found": "No room with that code. Check the digits and try again.",
  full: "That room already has two people.",
  "no-peer": "There's nobody else in the room.",
};

// must match -webkit-line-clamp in style.css
const MAX_LINES = 8;
let msgCount = 0;

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

  // Count lines while the bubble is still unclamped — measuring after the
  // clamp would depend on how overflow reports height, which is the thing
  // that made the 9th line leak in the first place.
  const style = getComputedStyle(msg);
  const lineHeight = parseFloat(style.lineHeight);
  const padding =
    parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const lines = Math.round((msg.clientHeight - padding) / lineHeight);

  if (lines > MAX_LINES) {
    msg.id = `msg-${++msgCount}`;
    msg.classList.add("is-clamped");

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "show-more";
    toggle.textContent = "Show more";
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-controls", msg.id);
    toggle.addEventListener("click", () => {
      const clamped = msg.classList.toggle("is-clamped");
      toggle.textContent = clamped ? "Show more" : "Show less";
      toggle.setAttribute("aria-expanded", String(!clamped));
    });

    body.append(toggle);
  }

  msgDisplay.scrollTop = msgDisplay.scrollHeight;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let size = bytes / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${units[unit]}`;
}

// querySelector returns the FIRST match, so scope by direction as well as id:
// a sender's row is always .msg-own and a receiver's always .msg-peer, which
// makes an id clash a non-event rather than a silent mis-target.
function findFileRow(id, from) {
  const side = from === "You" ? ".msg-own" : ".msg-peer";
  return document.querySelector(
    `.message-display ${side}[data-file-id="${id}"]`,
  );
}

function updateProgressUI(id, loaded, total, from) {
  const row = findFileRow(id, from);
  if (!row) return;

  const pct = total ? Math.round((loaded / total) * 100) : 0;
  const fill = row.querySelector(".fill");
  // transition from the current width, never re-animated from zero
  if (fill) fill.style.width = `${pct}%`;

  const meta = row.querySelector(".file-meta");
  if (meta) {
    meta.textContent = `${formatBytes(loaded)} of ${formatBytes(total)} · ${pct}%`;
  }
}

// bytes are all through: drop the bar and turn on the download
function completeFileUI(id, blob, meta, from) {
  const row = findFileRow(id, from);
  if (!row) return;

  row.querySelector(".track")?.remove();

  const line = row.querySelector(".file-meta");
  if (line) {
    line.textContent = `${formatBytes(meta.size)} · ${
      from === "You" ? "sent" : "received"
    }`;
  }

  const save = row.querySelector(".btn-save");
  if (save) {
    save.href = URL.createObjectURL(blob);
    save.hidden = false;
  }
}

function renderFileMessage(meta, blob, from) {
  const msgDisplay = document.querySelector(".message-display");

  const row = document.createElement("div");
  // same three direction cues as a text item: alignment, fill, tail corner
  row.className = from === "You" ? "msg msg-own" : "msg msg-peer";
  row.dataset.fileId = meta.id; // how updateProgressUI finds this row again

  const user = document.createElement("h4");
  user.textContent = from;

  const timestamp = document.createElement("time");
  const when = new Date();
  timestamp.dateTime = when.toISOString();
  timestamp.textContent = when.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  const metaRow = document.createElement("div");
  metaRow.className = "msg-meta";
  metaRow.append(user, timestamp);

  const tile = document.createElement("span");
  tile.className = "file-tile";
  tile.setAttribute("aria-hidden", "true");

  const name = document.createElement("span");
  name.className = "file-name";
  name.textContent = meta.name;
  name.title = meta.name; // the CSS truncates, so keep the full name reachable

  const size = document.createElement("span");
  size.className = "file-meta";
  size.textContent = blob
    ? `${formatBytes(meta.size)} · ${from === "You" ? "sent" : "received"}`
    : `0 B of ${formatBytes(meta.size)} · 0%`;

  const text = document.createElement("span");
  text.className = "file-text";
  text.append(name, size);

  // a real <a download>, not a click handler on a div
  const save = document.createElement("a");
  save.className = "btn-save";
  save.download = meta.name;
  save.textContent = "Save";
  if (blob) save.href = URL.createObjectURL(blob);
  else save.hidden = true; // nothing to save until the bytes are all here

  const row1 = document.createElement("div");
  row1.className = "file-row";
  row1.append(tile, text, save);

  const file = document.createElement("div");
  file.className = "file";
  file.append(row1);

  // 5px bar under the row while bytes are moving, on BOTH ends
  if (!blob) {
    const fill = document.createElement("div");
    fill.className = "fill";
    fill.style.width = "0%"; // the one inline style DESIGN.md allows
    const track = document.createElement("div");
    track.className = "track";
    track.append(fill);
    file.append(track);
  }

  const body = document.createElement("div");
  body.className = "msg-body";
  body.append(metaRow, file);

  row.append(body);
  msgDisplay.append(row);
  msgDisplay.scrollTop = msgDisplay.scrollHeight;
}


ws.addEventListener("open", () => {
  createBtn.disabled = false;
  joinBtn.disabled = false;
});

const roomNotice = document.querySelector(".room-notice");
let closeTimer = null;

function hideRoomNotice() {
  clearInterval(closeTimer);
  closeTimer = null;
  roomNotice.hidden = true;
  roomNotice.textContent = "";
}

// a fixed "3 minutes" would be a lie thirty seconds later, so count down
function showPeerLeft(closesIn) {
  let left = Math.round(closesIn / 1000);

  const paint = () => {
    const m = Math.floor(left / 60);
    const sec = String(left % 60).padStart(2, "0");
    roomNotice.textContent = `They've left. This room closes in ${m}:${sec}.`;
    if (left <= 0) clearInterval(closeTimer);
    left--;
  };

  clearInterval(closeTimer);
  roomNotice.hidden = false;
  paint();
  closeTimer = setInterval(paint, 1000);
}

// back to a clean home screen: the room is gone, so nothing from it should
// still be on screen or half-assembled in memory
function goHome() {
  hideRoomNotice();
  document.querySelector(".home-screen").hidden = false;
  document.querySelector(".room-screen").hidden = true;
  document.querySelector(".joined-room").hidden = true;
  document.querySelector(".message-display").replaceChildren();
  document.querySelector("#roomcode").value = "";
  incoming.clear();
  latestFileID = undefined;
}

ws.addEventListener("message", (e) => {
  if (typeof e.data === "string") {
    const data = JSON.parse(e.data);

    if (data.type === "error") {
      errormsg.textContent = errorList[data.reason];
      setTimeout(() => {
        errormsg.textContent = "";
      }, 2000);
    }

    if (data.type === "room-created") {
      document.querySelector(".room-screen").hidden = false;
      document.querySelector(".home-screen").hidden = true;
      document.querySelector("#copycode").textContent = data.code;
    }

    // if (data.type === "room-joined") {
    //   console.log("Room joined");
    // }

    if (data.type === "peer-joined" || data.type === "room-joined") {
      document.querySelector(".joined-room").hidden = false;
      document.querySelector(".home-screen").hidden = true;
      document.querySelector(".room-screen").hidden = true;
      hideRoomNotice(); // someone joined the room we were alone in
    }

    if (data.type === "peer-left") {
      showPeerLeft(data.closesIn);
    }

    if (data.type === "chat") renderMessage(data.from, data.text, data.ts);

    if (data.type === "room-expired") {
      goHome();
      errormsg.textContent = "Room closed. No one else joined.";
      setTimeout(() => {
        errormsg.textContent = "";
      }, 5000);
    }

    if (data.type === "file-start") {
      incoming.set(data.id, { meta: data, chunks: [], received: 0 });
      latestFileID = data.id;
      renderFileMessage(data, null, "Peer"); // in-progress, no blob yet
    }

    if (data.type === "file-end") {
      const { meta, chunks } = incoming.get(data.id);
      const blob = new Blob(chunks, { type: meta.mime });
      incoming.delete(data.id);
      completeFileUI(data.id, blob, meta, "Peer");
    }

    // console.log(data);
  } else {
    const transfer = incoming.get(latestFileID);
    if (!transfer) return; // a stray chunk with no open transfer
    transfer.chunks.push(e.data);
    transfer.received += e.data.byteLength;
    updateProgressUI(
      latestFileID,
      transfer.received,
      transfer.meta.size,
      "Peer",
    );
  }
});

ws.addEventListener("close", () => {
  // console.log("disconnected");
  createBtn.disabled = true;
});

createBtn.addEventListener("click", () => {
  ws.send(JSON.stringify({ type: "create-room" }));
});

document.getElementById("roomcode").addEventListener("keydown", (e) => {
  // isComposing guards IME input, where Enter confirms a candidate word
  if (e.key === "Enter" && !e.isComposing) {
    e.preventDefault();
    joinBtn.click();
  }
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

const CHUNK = 64 * 1024,
  HIGH_WATER = 1 * 1024 * 1024; // 1 MB queue cap
// Both clients used to start this counter at the same number, so each
// browser's first file was "f_10000" and the two collided. The random prefix
// is minted once per page load, so no two clients can produce the same id.
const clientId = crypto.randomUUID().slice(0, 6);
let fileCount = 1;
let sending = false;

async function sendFile(file) {
  const id = `f_${clientId}_${fileCount++}`;
  const meta = {
    type: "file-start",
    id,
    name: file.name,
    size: file.size,
    mime: file.type || "application/octet-stream",
  };
  ws.send(
    JSON.stringify(meta),
  );
  renderFileMessage(meta, null, "You"); // in-progress until the bytes are out
  for (let off = 0; off < file.size; off += CHUNK) {
    const buf = await file.slice(off, off + CHUNK).arrayBuffer();
    ws.send(buf);
    while (ws.bufferedAmount > HIGH_WATER) {
      // ← backpressure
      await new Promise((r) => setTimeout(r, 20)); //   let the pipe drain
    }
    updateProgressUI(id, Math.min(off + CHUNK, file.size), file.size, "You");
  }
  ws.send(JSON.stringify({ type: "file-end", id }));
  // File extends Blob, so the sender needs no reassembly
  completeFileUI(id, file, meta, "You");
}

// the real input is .sr-only, so the label has to report what is selected
const fileInput = document.getElementById("files");
const dropZone = document.querySelector(".drop");
const dropText = document.querySelector(".drop-text");
const dropIdle = dropText.textContent;

function showSelection() {
  const files = [...fileInput.files];
  dropZone.classList.toggle("has-files", files.length > 0);

  if (files.length === 0) {
    dropText.textContent = dropIdle;
  } else if (files.length === 1) {
    dropText.textContent = `${files[0].name} · ${formatBytes(files[0].size)}`;
  } else {
    const total = files.reduce((sum, f) => sum + f.size, 0);
    dropText.textContent = `${files.length} files · ${formatBytes(total)}`;
  }
}

fileInput.addEventListener("change", showSelection);

const message = document.querySelector("#messageForm");

document.getElementById("message").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault(); // otherwise Enter also inserts the newline
    // requestSubmit fires the submit event; form.submit() would skip it
    message.requestSubmit();
  }
});
message.addEventListener("submit", async (e) => {
  e.preventDefault();

  const fileInput = document.getElementById("files");
  if (fileInput.files.length > 0) {
    if (sending) return;              // a second Send mid-transfer interleaves
    sending = true;                   // chunks, and they carry no id to sort out
    const sendBtn = message.querySelector("button[type=submit]");
    sendBtn.disabled = true;

    try {
      for (const file of [...fileInput.files]) {   // snapshot: FileList is live
        await sendFile(file);
      }
    } catch (error) {
      console.error(error);
    } finally {
      sending = false;
      sendBtn.disabled = false;
      fileInput.value = "";           // in finally, so a failed send still clears
      showSelection();
    } // clearing the input fires no change event
  } else {
    const text = document.querySelector("#message").value;
    if (text === "") return;
    ws.send(JSON.stringify({ type: "chat", text: text }));

    renderMessage("You", text, Date.now());

    document.querySelector("#message").value = "";
  }
});
