# Building "DropRoom" — A Two-Person Real-Time Transfer App
## A Complete Course + Implementation Roadmap

**What you're building:** A website where two people join a temporary room using a short code and send text and files to each other in real time, in both directions, with no accounts.

**How to use this document:** Work through the phases in order. Each phase produces something that runs. Do not skip the *Concepts* sections — the entire point is that at the end, you can debug and extend this app without help. Every phase ends with a checkpoint; don't move on until you pass it honestly.

---

# Phase 0 — Planning and the Big Architecture Decision

## Goal of this phase

Before writing code, you must answer one question that shapes everything else: **when Person A sends a file to Person B, what path does the data take?** You'll leave this phase with a written set of requirements, a chosen architecture for Version 1, and an upgrade path for Version 2.

## Concepts you need to know

### How the web normally works: HTTP request/response

HTTP is a *pull* protocol. The browser asks ("GET /page"), the server answers, and the connection is conceptually done. The server **cannot** spontaneously say "hey browser, Person B just sent you a message." It has no way to initiate contact. That's the fundamental mismatch with our app: we need the server to *push* data to Person B the moment Person A sends it.

Workarounds people used before better tools existed:

- **Polling:** the browser asks "anything new?" every 2 seconds. Wasteful (most requests return nothing) and laggy (up to 2s delay).
- **Long polling:** the browser asks and the server *holds* the request open until something happens. Better, but awkward — every message requires tearing down and re-establishing a request.

### WebSockets: a phone call instead of letters

A **WebSocket** is a persistent, two-way connection between browser and server. It starts life as a normal HTTP request with a special `Upgrade: websocket` header; the server agrees, and from then on the same TCP connection stays open and **either side can send a message at any time**.

Mental model: HTTP is exchanging letters (each one addressed, stamped, and sent separately). A WebSocket is a phone call — once connected, either party just talks.

Key properties that matter for us:

- **Bidirectional:** server→browser pushes are native. This solves the HTTP mismatch.
- **Message-based:** you send discrete messages (text or binary), not a raw byte stream.
- **Stays open:** the server always has a live handle to each connected user, which is exactly what "route this message to the other person in the room" requires.
- **Ordered and reliable:** messages arrive in the order sent, or the connection errors. (This is TCP underneath.)

### NAT: why browsers can't just talk to each other

You might wonder: why involve a server at all? Why can't Browser A open a connection straight to Browser B?

Because of **NAT (Network Address Translation)**. Almost every device sits behind a home/office router. Your laptop's address (`192.168.1.7`) is private — meaningless on the public internet. The router translates between your private address and its one public address. Consequence: **you can dial out, but strangers can't dial in.** Browser B has no publicly reachable address for Browser A to connect to. The two browsers are like two people in different apartment buildings with no listed phone numbers — someone with a listed number (our server) has to introduce them.

### WebRTC: browser-to-browser, with help

**WebRTC** is the browser technology built to solve exactly this. It lets two browsers establish a *direct* peer-to-peer connection for audio, video, or arbitrary data. The data part is called a **DataChannel** — think "WebSocket, but between two browsers."

But because of NAT, WebRTC needs helpers:

- **Signaling server:** before connecting, the browsers must exchange introduction info ("here's how to reach me, here are my encryption keys"). WebRTC deliberately doesn't specify how — *you* provide the channel. Our WebSocket server is a perfect signaling channel. Signaling is just passing small text blobs (called SDP offers/answers) between the peers.
- **STUN server:** a simple public server that answers one question: "what does my address look like from the outside?" Your browser asks STUN, learns its public IP:port as seen through the NAT, and includes that in its introduction. Free public STUN servers exist (Google runs some).
- **ICE:** the process of gathering every possible way to reach a peer (local address, STUN-discovered public address, TURN relay) — each called a *candidate* — and testing pairs until one works.
- **TURN server:** the fallback when NATs are too strict for a direct connection (roughly 10–20% of pairs, e.g. strict corporate networks). TURN *relays* the traffic through itself. Note the irony: TURN is a server in the middle again — but a dumb one that just forwards encrypted bytes. TURN servers cost real bandwidth money, which is why there are no free public ones.

### Comparing the two architectures

**Architecture 1 — Server-mediated relay:**

```text
A → Server → B        B → Server → A
```

Every message and file flows through your server over WebSockets.

**Architecture 2 — WebRTC P2P:**

```text
A ↔ B   (direct DataChannel)
    ↑
Server used only for signaling + room codes
```

| Dimension | Server relay (WS) | WebRTC P2P |
|---|---|---|
| Complexity | Low — one protocol, one code path | High — signaling, ICE, connection states, fallbacks |
| Works everywhere | Yes (WS rarely blocked) | ~85–90% direct; rest need TURN |
| Server bandwidth | **Every byte** transits your server — costs scale with usage | Near zero (signaling is tiny) |
| Large files | Limited by server bandwidth/memory discipline | Excellent — limited only by the two connections |
| Privacy | Server *can* see all data (unless you add E2E encryption yourself) | DTLS-encrypted end-to-end by default; server never sees content |
| Latency | Two hops | One hop (usually lower) |
| Debugging | Easy — log at the server | Harder — connection lives outside your server |
| Deployment | Trivial | Need STUN (free) and ideally TURN (costs money) |

### Recommendation

**Version 1: server-mediated WebSocket relay.**
Reasons: one new concept (WebSockets) instead of five (WebRTC, SDP, ICE, STUN, TURN); a single code path to debug; and — critically — **you need the WebSocket server anyway** for room codes and signaling, so nothing is wasted. For a learning project with small files between two people, server bandwidth is a non-issue.

**Version 2: add WebRTC DataChannels for file transfer, keeping the WebSocket path as fallback.**
The upgrade is natural: your existing WebSocket becomes the signaling channel. Files go P2P (fast, private, cheap); if ICE fails, fall back to the relay you already built. This "relay first, P2P later" order is how real products (including many screen-sharing and file-drop tools) evolved.

This document builds Version 1 fully, then Phase 15 shows the WebRTC upgrade.

## Requirements (write these down)

**Functional:** create room → get 6-char code; join by code; max 2 people; either person sends text/files at any time, simultaneously; show sender + timestamp; download received files; rooms die when empty or expired.

**Non-functional:** no accounts; no permanent storage of transferred content; HTTPS/WSS in production; sane limits (start: 50 MB/file); honest privacy claims (V1 is *transport-encrypted*, not end-to-end encrypted — the server could technically read data; we say so plainly).

## Checkpoint

```text
[ ] I can explain why plain HTTP can't push data to Person B
[ ] I can explain what NAT is and why browsers can't connect directly without help
[ ] I can explain the roles of signaling, STUN, and TURN in one sentence each
[ ] I can defend "relay for V1, WebRTC for V2" to another developer
```

**Common mistakes at this stage:** starting with WebRTC because it sounds impressive (you'll drown in ICE states before sending one byte); or claiming "private/E2E encrypted" for a relay architecture (it isn't, and honesty here is a security skill).

---

# Phase 1 — Project Setup

## Goal

A running Express server that serves a static frontend, with a clean folder structure that survives the whole project.

## Concepts

**Why Express at all?** Node's built-in `http` module works, but Express gives us tidy routing and static-file serving in 3 lines. We deliberately keep the stack minimal: **Node + Express + the `ws` library + vanilla JS frontend.** No React, no bundler, no database.

**Why the `ws` library and not Socket.IO?** Socket.IO is the popular batteries-included choice: it adds automatic reconnection, fallbacks, named events, and rooms. We're *not* using it, for a learning-project reason: Socket.IO hides exactly the mechanics you're here to learn (framing messages, routing, reconnection). `ws` is a thin, faithful implementation of the actual WebSocket protocol — what you learn transfers everywhere. Alternatives dismissed: Socket.IO (too magical for our goal — fine choice in a job context), `uWebSockets.js` (performance-focused, C++ build complexity we don't need).

**Why no frontend framework?** Our UI is one page with a message list and two inputs. Vanilla DOM code keeps the learning surface small. If the UI grows in V2, you can migrate.

## Implementation plan

1. **Initialize the project.**
   ```bash
   mkdir droproom && cd droproom
   npm init -y
   npm install express ws nanoid
   ```
   (`nanoid` generates secure random IDs — we'll use it for room codes later. It uses the crypto module's randomness, not `Math.random()` — this matters for security, explained in Phase 9.)

2. **Create the structure:**
   ```text
   droproom/
   ├── client/            ← everything the browser downloads
   │   ├── index.html
   │   ├── style.css
   │   └── app.js
   ├── server/
   │   └── index.js       ← entry point
   ├── package.json
   └── README.md
   ```
   *Why this split:* the client folder is dumb static files; the server folder is logic. When we later add `rooms.js` and `wsHandlers.js`, they join `server/`.

3. **Minimal server — `server/index.js`:**
   ```js
   const express = require("express");
   const path = require("path");

   const app = express();
   app.use(express.static(path.join(__dirname, "..", "client")));

   const PORT = process.env.PORT || 3000;
   app.listen(PORT, () => console.log(`http://localhost:${PORT}`));
   ```
   `express.static` means "any file in client/ is served as-is" — request `/app.js`, get `client/app.js`. `process.env.PORT` matters at deployment (hosts assign you a port).

4. **Placeholder `client/index.html`** with `<h1>DropRoom</h1>` and `<script src="app.js"></script>`. Confirm it loads.

5. Add `"start": "node server/index.js"` to package.json scripts, and a `dev` script using `node --watch server/index.js` (Node ≥ 18.11 restarts on change — no nodemon dependency needed).

## Checkpoint

```text
[ ] npm start serves my page at localhost:3000
[ ] I can explain what express.static does
[ ] I can explain why we chose ws over Socket.IO for this project
```

**Common mistakes:** deep-nesting folders prematurely; installing libraries "we might need"; putting server files where the static middleware can serve them (never serve `server/`!).

---
# Phase 2 — First WebSocket Connection

## Goal

Browser and server exchange their first live messages. You'll see a message travel browser → server → browser with your own eyes. Nothing room-related yet — just the pipe.

## Concepts

### The WebSocket lifecycle

Every WebSocket connection goes through the same life:

```text
1. Handshake   — browser sends HTTP GET with "Upgrade: websocket"
2. Open        — both sides can now send messages freely
3. Messages    — any number, either direction, any time
4. Close       — either side closes (or the network dies)
```

In the browser, the API is tiny:

```js
const ws = new WebSocket("ws://localhost:3000");
ws.addEventListener("open",    () => { /* connected */ });
ws.addEventListener("message", (e) => { /* e.data arrived */ });
ws.addEventListener("close",   () => { /* it's over */ });
ws.send("hello");
```

`ws://` is to WebSockets what `http://` is to web pages; `wss://` is the TLS version (like `https://`) — production only ever uses `wss://`.

### Sharing one port

A subtle, important trick: the WebSocket server doesn't need its own port. Because the handshake *is* an HTTP request, the `ws` library can piggyback on Express's HTTP server and claim only the requests that ask to upgrade:

```text
Same port 3000:
   normal GET /index.html  → Express handles it
   GET / + Upgrade header  → ws library handles it
```

This matters at deployment too — one port, one process, one URL.

### Designing a message protocol

WebSocket messages are just strings (or binary — later). If we send raw text like `"hello"`, the receiver can't tell a chat message from a command. So we define a tiny **protocol**: every message is JSON with a `type` field.

```json
{ "type": "chat", "text": "hello" }
{ "type": "create-room" }
{ "type": "error", "message": "Room full" }
```

This is the single most load-bearing design decision in the app. Every feature we add for the rest of the project is "add a new message type and handle it on both sides." Write the types down in your README as you add them — that document *is* your API spec.

## Implementation plan

1. **Restructure the server to share the HTTP server** (`server/index.js`):
   ```js
   const http = require("http");
   const express = require("express");
   const { WebSocketServer } = require("ws");
   const path = require("path");

   const app = express();
   app.use(express.static(path.join(__dirname, "..", "client")));

   const server = http.createServer(app);        // Express rides on this
   const wss = new WebSocketServer({ server });  // ws rides on the same one

   wss.on("connection", (ws) => {
     console.log("client connected");

     ws.on("message", (data) => {
       const msg = JSON.parse(data);             // trust no one later; fine for now
       console.log("received:", msg);
       ws.send(JSON.stringify({ type: "echo", original: msg }));
     });

     ws.on("close", () => console.log("client left"));
   });

   server.listen(3000);
   ```
   Note we now call `server.listen`, not `app.listen` — `app.listen` creates a hidden HTTP server we couldn't attach `ws` to.

2. **Client side (`client/app.js`):** connect, log the open event, send a test JSON message on a button click, log what comes back. Build the WebSocket URL from the page's own location so it works in production later:
   ```js
   const proto = location.protocol === "https:" ? "wss" : "ws";
   const ws = new WebSocket(`${proto}://${location.host}`);
   ```

3. **Test properly:** open two browser tabs. Notice each tab gets its *own* connection and its own echo — the server holds one `ws` object per client. Internalize this: **a `ws` object is a live handle to one specific person.** Routing messages between people = calling `.send()` on someone else's handle. That's the entire secret of the app.

## Checkpoint

```text
[ ] Two tabs each connect and get their own echoes
[ ] I can describe the four lifecycle stages of a WebSocket
[ ] I can explain why we JSON-encode with a "type" field
[ ] I can explain how Express and ws share port 3000
```

**Common mistakes:** calling `ws.send()` before the `open` event fires (queue or wait); forgetting `JSON.parse`/`JSON.stringify` and sending `[object Object]`; treating the message event's `data` as an object when it's a string.

---

# Phase 3 — Rooms: Create, Join, Reject

## Goal

Person A clicks **Create Room** and sees `A7K92P`. Person B enters that code and joins. A third person is refused. Invalid codes are refused. Both members are told when the room becomes complete.

## Concepts

### What is a room, really?

Nothing physical — just an entry in a server-side data structure grouping two connection handles:

```js
// server/rooms.js — module-level state
const rooms = new Map();
// code → { clients: [wsA, wsB], createdAt: 1712345678 }
```

A `Map` beats a plain object here: proper `.size`, easy iteration, no prototype weirdness. **In-memory is the right call for V1** — rooms are throwaway by design, so losing them on server restart is acceptable, and a database would add setup cost for zero benefit (full comparison in Phase 12's sidebar and Phase 14 for multi-server futures).

### Room codes: short but unguessable *enough*

Requirements pull in opposite directions: short enough to read over the phone, random enough that a stranger can't guess an active room. We'll use 6 characters from an unambiguous alphabet (no `0/O`, no `1/I/l`):

- Alphabet of 31 chars, length 6 → 31⁶ ≈ **887 million** combinations.
- With, say, 100 rooms active at once and codes expiring in minutes, guessing odds per attempt ≈ 100/887M ≈ 1 in 9 million. Combined with rate limiting (Phase 9), that's sound for this app.
- Must be generated with **crypto-grade randomness** (`nanoid`'s `customAlphabet`), never `Math.random()` — Phase 9 explains how predictable `Math.random()` actually is.

### Connection state

Each connection now needs to remember *which room it's in*. Simplest approach: hang it on the socket object itself (`ws.roomCode = code`). It's slightly inelegant but honest and debuggable; a `Map<ws, state>` is the cleaner alternative — pick one and be consistent.

## Architecture

```text
Person A                      SERVER                       Person B
   |                            |                             |
   |--- {type:"create-room"} -->|                             |
   |                      make code A7K92P                    |
   |                      rooms.set("A7K92P", {clients:[A]})  |
   |<-- {type:"room-created",   |                             |
   |     code:"A7K92P"} --------|                             |
   |                            |<-- {type:"join-room",       |
   |                            |     code:"A7K92P"} ---------|
   |                      push B into room.clients            |
   |<-- {type:"peer-joined"} ---|--- {type:"room-joined"} --->|
```

## Implementation plan

1. **Create `server/rooms.js`** exporting pure-ish functions: `createRoom(ws)`, `joinRoom(code, ws)`, `leaveRoom(ws)`, `getPeer(ws)`. Keeping room logic out of the WebSocket handler file pays off immediately in readability and later in testing (Phase 12 tests this module in isolation).

   ```js
   const { customAlphabet } = require("nanoid");
   const makeCode = customAlphabet("23456789ABCDEFGHJKMNPQRSTUVWXYZ", 6);
   const rooms = new Map();

   function createRoom(ws) {
     const code = makeCode();
     rooms.set(code, { clients: [ws], createdAt: Date.now() });
     ws.roomCode = code;
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
   ```

   `getPeer` is the function the whole app pivots on: "the other person in my room."

2. **Add a message router** in the server's message handler — a `switch` on `msg.type` dispatching to handlers for `create-room` and `join-room`. Reject malformed JSON with try/catch around the parse (never let one bad client crash the process).

3. **Handle join failures explicitly** — send `{type:"error", code:"not-found" | "room-full"}` and let the UI show a human message. Enumerate your failure cases; every `return` in `joinRoom` becomes a user-visible state.

4. **Notify both sides on completion** — joiner gets `room-joined`, creator gets `peer-joined`. The UI meaning: "you may now start sending."

5. **Frontend:** two screens in one HTML file (home + room), toggled with a `hidden` class. Home screen = Create button, code input, Join button. On `room-created`, show the code big and copyable with a "waiting for peer…" note; on `peer-joined`/`room-joined`, reveal the transfer UI (empty for now).

6. **Handle disconnect minimally for now:** on `ws.on("close")`, remove the socket from its room; if the room is empty, delete it; if a peer remains, send them `{type:"peer-left"}`. Phase 10 hardens this.

## Checkpoint

```text
[ ] Two browsers can create/join and both see "connected"
[ ] A third browser gets a "room full" error
[ ] A wrong code gets a "not found" error
[ ] Closing one tab tells the other tab "peer left"
[ ] I can explain why Math.random() is wrong for room codes
```

**Common mistakes:** generating codes with `Math.random()`; forgetting the length check (three people in a "two-person" room); leaking rooms forever because disconnect doesn't clean up; building separate HTML pages for home/room and losing the WebSocket on navigation (page navigation kills the socket — that's why it's one page with two screens).

---
# Phase 4 — Real Bidirectional Messaging

## Goal

Anything one person sends, the other receives instantly — in both directions, simultaneously, in order. This phase is short but it's the heart transplant: after it, the app *is* a communication app.

## Concepts

### Routing vs broadcasting

Generic chat tutorials **broadcast**: loop over all connected sockets and send to everyone. We must not — other rooms would receive your data. We **route**: exactly one recipient, found via `getPeer(ws)`.

```text
BROADCAST (wrong here):  msg → every connected socket
ROUTE (ours):            msg → getPeer(sender) only
```

### Why "simultaneous sending" needs no special code

A worry from the project spec: "both people can send at the same time — how?" The answer: it's automatic, and understanding *why* is the point. Each person has their **own** WebSocket connection — two independent phone lines into the server. A sends on line 1 while B sends on line 2; the server's event loop processes whichever message arrives first, then the other. There is no shared channel to contend for, no "turn-taking" to implement. Full-duplex behavior falls out of the architecture.

### Ordering guarantees — and their limit

Within one direction (A→B), order is guaranteed: TCP delivers A's messages in the order A sent them, and Node processes them in arrival order. **Across** directions there is no global order — if A and B send "simultaneously," each sees their own message first. For chat this is fine (each side's view is internally consistent). Distributed systems people call this the absence of a total order; you now know it from experience, and it's why we timestamp on the server (one clock) rather than trusting two different client clocks.

## Implementation plan

1. **Server: add a `relay` case** to the router:
   ```js
   case "chat": {
     const peer = getPeer(ws);
     if (!peer) return sendErr(ws, "no-peer");
     peer.send(JSON.stringify({
       type: "chat",
       text: String(msg.text).slice(0, 10_000),  // cap — see Phase 5
       from: "peer",
       ts: Date.now(),                            // server clock = one truth
     }));
     break;
   }
   ```
2. **Client: send path** — form input + Enter key → `ws.send({type:"chat", text})` → *also* render your own message locally tagged "You" (your message never echoes back from the server; you render it optimistically).
3. **Client: receive path** — on `chat`, render tagged "Peer" with the server timestamp.
4. **Test the simultaneity claim:** two windows side by side, type in both, hit Enter at the same moment. Both appear in both windows. You've verified full-duplex empirically.

## Checkpoint

```text
[ ] Messages flow A→B and B→A with no reloads
[ ] Simultaneous sends both arrive
[ ] I can explain why simultaneous sending required zero extra code
[ ] I can explain why the server sets the timestamp
```

**Common mistakes:** broadcasting to `wss.clients` instead of routing to the peer; echoing the sender's message back (double render); sending to a peer whose connection is closing — check `peer.readyState === WebSocket.OPEN` before `.send()`.

---

# Phase 5 — Text Transfer, Done Properly

## Goal

Turn "messages flow" into a polished, safe text experience: sender labels, timestamps, copy buttons, long-text handling, rapid-fire ordering, and a clear storage policy.

## Concepts

### XSS: the one bug you must not ship

If you render a received message with `element.innerHTML = text`, and the peer sends `<img src=x onerror="...">`, **their JavaScript runs in your page**. That's Cross-Site Scripting. In our app the attacker is "the person you invited," which sounds low-risk — until you remember room codes get shared over shoulder-surfable channels and V2 might allow links. The fix is one discipline: **received data is text, never markup.** Use `element.textContent = text` (the browser then treats `<script>` as six harmless characters). This single choice eliminates the class of bug.

### Storage policy: don't store

Should the server keep messages? Our answer: **no**. The server is a router, not a mailbox — messages exist in server memory only for the microseconds between receive and forward. Consequences to accept explicitly: if you join late or refresh, prior messages are gone (session-only history lives in each browser's JS array). This is a *feature* for a privacy-focused tool, and it's also less code. Write this policy in the README — "what we don't store" is part of a security posture.

### Backpressure (a first taste)

If someone pastes a novel and hits Enter 50 times, `ws.send()` never blocks — it buffers. `ws.bufferedAmount` tells you how many bytes are queued but unsent. For text this rarely matters; for files (Phase 7) it's the difference between working and crashing. Meet the concept now: **sending faster than the network can carry means memory fills somewhere.**

## Implementation plan

1. **Message rendering component** — a `renderMessage({from, text, ts})` function creating DOM nodes via `createElement`/`textContent`, adding a copy button (`navigator.clipboard.writeText(text)`), formatting `ts` with `toLocaleTimeString()`.
2. **Long text** — CSS `overflow-wrap: anywhere` so a 10k-char URL doesn't destroy layout; collapse messages taller than ~8 lines behind a "Show more" toggle; keep the server-side 10k cap from Phase 4 and surface a friendly client-side warning before sending something over the cap.
3. **Rapid-fire test** — a temporary loop sending 100 numbered messages; verify they render 1..100 in order on the peer (they will — this *demonstrates* the ordering guarantee rather than taking my word).
4. **Auto-scroll etiquette** — scroll to bottom on new message *only if* the user is already near the bottom (don't yank them up while reading history).

## Checkpoint

```text
[ ] Sending "<script>alert(1)</script>" renders as literal text on the peer
[ ] 100 rapid messages arrive in order
[ ] Copy button works; timestamps show; long text doesn't break layout
[ ] I can explain our no-storage policy and its user-visible consequences
```

**Common mistakes:** `innerHTML` anywhere near received data; trusting client timestamps; storing history on the server "just in case" (scope creep with privacy costs).

---

# Phase 6 — File Transfer Fundamentals (No Code Yet That Ships)

## Goal

Before implementing file transfer, understand every object involved: File, Blob, ArrayBuffer, MIME types, chunking, and binary WebSocket frames. You'll write throwaway console experiments, not app code. Skipping this phase is why most people's file transfer "almost works."

## Concepts

### The browser's file objects, in one map

```text
<input type="file">
        │  .files[0]
        ▼
      File          ← name, size, type + the bytes (lazily, still on disk)
        │  is-a
        ▼
      Blob          ← immutable bag of bytes; .slice(a, b) is FREE (no copy)
        │  await blob.arrayBuffer()
        ▼
   ArrayBuffer      ← raw bytes actually loaded in memory
```

- **File** — what you get from a file input or drag-drop. Metadata is instantly available; the bytes stay on disk until asked for. `file.size` (bytes), `file.name`, `file.type`.
- **Blob** — File's parent class. The crucial superpower: `blob.slice(start, end)` returns a *view* without reading anything into memory. This is what makes chunking cheap.
- **ArrayBuffer** — actual bytes in RAM. `await chunkBlob.arrayBuffer()` is the moment data leaves disk and enters memory. Golden rule: **only ever hold one chunk's ArrayBuffer at a time.**

### MIME types — labels, not truth

`file.type` is like `"image/png"` or `"application/pdf"` — a *claim* based on file extension, set by the browser, trivially spoofable (rename `evil.exe` → `evil.png`). Use it for UX (icons, previews) and for the receiver to reconstruct the file; never as a security decision. Also: `file.type` is often `""` for unusual extensions — always have a fallback (`application/octet-stream`, the MIME term for "unknown bytes").

### Why chunking is non-negotiable

Naive plan: read whole file → one `ws.send()`. Failure modes:

1. **Memory:** a 2 GB file becomes a 2 GB ArrayBuffer in the sender's RAM, then in server RAM, then in receiver RAM. Tabs and servers die.
2. **All-or-nothing:** one hiccup at 99% loses everything; no resume possible.
3. **No progress:** one giant send = no way to show 47%.
4. **Head-of-line blocking:** WebSocket messages are ordered — a giant frame blocks every chat message behind it for the whole transfer.

Chunking — sending the file as thousands of ~64 KB slices — fixes all four: bounded memory (one chunk at a time), granular progress, interruption loses one chunk not the file, and chat messages can interleave between chunks.

**Why 64 KB?** A tuning balance: smaller → more per-message overhead and more event-loop churn; bigger → chunkier progress, more memory per step, longer head-of-line stalls. 16–256 KB all work; 64 KB is a sane default. Make it a constant and experiment later.

### Binary WebSocket messages

So far we've sent text frames (JSON). WebSockets also carry **binary frames** — hand `ws.send()` an ArrayBuffer and the raw bytes travel with zero encoding overhead. (Base64-encoding bytes into JSON works but inflates size 33% and wastes CPU — a classic beginner detour. Don't.)

New problem: a binary frame is *anonymous bytes* — no `type` field, no "this is chunk 12 of cat.jpg." Two solutions:

- **A. Interleaved control + data (ours):** announce with JSON (`file-start` carrying name/size/type/id), then send binary chunks, relying on WebSocket's ordering guarantee to keep them associated; finish with `file-end`. Simple, readable, and it *uses* the ordering property you learned in Phase 4.
- **B. Header-in-frame:** prepend each binary frame with your own byte header (file id, chunk index) and parse with DataView. More robust for multiplexing several files at once; more fiddly. We'll adopt a light version of B in Phase 8 when we want per-chunk ids for cancellation. Starting with A keeps Phase 7 debuggable.

On the receiving side, set `ws.binaryType = "arraybuffer"` in the browser (default is Blob; ArrayBuffer is easier to accumulate), collect chunks in an array, and at the end: `new Blob(chunks, {type: mimeType})` — the browser assembles the file.

### The download trick

Browsers won't silently write files to disk (thankfully). The idiom:

```js
const url = URL.createObjectURL(blob);   // blob gets a fake local URL
a.href = url; a.download = fileName;     // <a download> = "save, don't navigate"
a.click();
URL.revokeObjectURL(url);                // free it — these leak if you forget
```

## Do these experiments (throwaway page, 30 minutes)

```text
[ ] Log name/size/type of a picked file; rename a .txt to .png and observe the lie
[ ] Slice a big file into 64 KB blobs in a loop; watch memory stay flat (DevTools)
[ ] Read ONE chunk's arrayBuffer() and log its byteLength
[ ] Make a Blob from two typed strings and download it via createObjectURL
```

## Checkpoint

```text
[ ] I can draw File → Blob → ArrayBuffer from memory and say what each is
[ ] I can give all four reasons chunking is required
[ ] I can explain why binary frames beat base64-in-JSON
[ ] I can explain why file.type must never be trusted for security
```

---
# Phase 7 — File Transfer Implementation

## Goal

Pick a file, watch it arrive on the other side, download it, verify it's byte-identical. This is the app's signature feature and the project's hardest single phase — but Phase 6 did the thinking; this is assembly.

## Architecture: the transfer protocol

```text
SENDER                         SERVER (relay)                    RECEIVER
  |                                |                                |
  |-- JSON file-start ------------>|-- forward -------------------->|  allocate
  |   {id, name, size, mime}       |                                |  chunks=[]
  |                                |                                |
  |-- binary chunk 0 ------------->|-- forward -------------------->|  push
  |-- binary chunk 1 ------------->|-- forward -------------------->|  push
  |            ...                 |            ...                 |   ...
  |                                |                                |
  |-- JSON file-end {id} --------->|-- forward -------------------->|  assemble Blob,
  |                                |                                |  show Download
```

The server's role is deliberately dumb: **forward JSON to peer; forward binary to peer; never buffer a whole file.** The interesting logic lives at the edges.

## Implementation plan

1. **Define the protocol messages** (add to your README spec):
   ```json
   { "type": "file-start", "id": "f_x1", "name": "cat.jpg", "size": 812345, "mime": "image/jpeg" }
   { "type": "file-end",   "id": "f_x1" }
   ```
   The `id` (nanoid again) future-proofs for cancellation and multiple files.

2. **Server: relay binary frames.** In the `ws` library, the message handler receives a Buffer and an `isBinary` flag:
   ```js
   ws.on("message", (data, isBinary) => {
     if (isBinary) {
       const peer = getPeer(ws);
       if (peer && peer.readyState === WebSocket.OPEN) peer.send(data, { binary: true });
       return;                    // binary = file chunk, just forward
     }
     // ...existing JSON router, which now also forwards
     // file-start / file-end to the peer
   });
   ```
   Note what's absent: the server never inspects, stores, or assembles files. Memory stays flat regardless of file size.

3. **Sender loop with backpressure** — the crux of the phase:
   ```js
   const CHUNK = 64 * 1024, HIGH_WATER = 1 * 1024 * 1024; // 1 MB queue cap

   async function sendFile(file) {
     const id = "f_" + nanoid(6);
     ws.send(JSON.stringify({ type: "file-start", id, name: file.name,
                              size: file.size, mime: file.type || "application/octet-stream" }));
     for (let off = 0; off < file.size; off += CHUNK) {
       const buf = await file.slice(off, off + CHUNK).arrayBuffer();
       ws.send(buf);
       while (ws.bufferedAmount > HIGH_WATER) {         // ← backpressure
         await new Promise((r) => setTimeout(r, 20));    //   let the pipe drain
       }
       updateProgressUI(id, Math.min(off + CHUNK, file.size) / file.size);
     }
     ws.send(JSON.stringify({ type: "file-end", id }));
   }
   ```
   **Why the while-loop matters:** without it, this loop reads chunks far faster than any network sends them; `bufferedAmount` balloons to the size of the file and you've reinvented the memory problem chunking was meant to solve. The check turns the loop into "send only as fast as the connection drains." This is backpressure, and it's the concept separating toy transfers from working ones. (Polling with setTimeout is crude but clear; Phase 8 refines it.)

4. **Receiver assembly:**
   ```js
   const incoming = new Map();   // id → {meta, chunks: []}

   // on file-start:  incoming.set(msg.id, { meta: msg, chunks: [] });
   // on binary frame: append to the transfer announced most recently
   //                  (protocol A: order guarantees it belongs to it)
   // on file-end:
   const { meta, chunks } = incoming.get(msg.id);
   const blob = new Blob(chunks, { type: meta.mime });
   incoming.delete(msg.id);
   renderFileMessage(meta, blob);   // filename, human size, [Download] button
   ```
   Verify `blob.size === meta.size` and show an error if not — your first integrity check.

5. **The receiver-memory honesty note:** the receiver *does* hold the whole file in memory before download — for a relay through JS there's no way around it in V1 (the File System Access API and StreamSaver-style tricks exist but are V2 material). This is the real reason for the 50 MB limit, enforced sender-side (friendly error) *and* server-side in `file-start` (`size > LIMIT → reject`) because client checks are suggestions, not enforcement.

6. **Test matrix:** a 1 KB text file (works at all?), a 5 MB image (progress visible? opens correctly?), a 50 MB file (memory in DevTools Performance monitor stays sane on sender?), a file with `""` type (fallback works?). Then the byte-identical test: send a zip, download, extract — corruption would surface instantly.

## Checkpoint

```text
[ ] A photo sent A→B downloads and opens identically
[ ] Progress bar moves smoothly on the sender
[ ] Sender memory stays flat during a 50 MB send (DevTools verified)
[ ] Chat messages still work between chunks of an ongoing transfer
[ ] I can explain what bufferedAmount measures and what the while-loop prevents
```

**Common mistakes:** no backpressure check (works on localhost, dies on real networks — localhost drains instantly, hiding the bug!); reading the whole file with one `arrayBuffer()` call; forgetting `binaryType = "arraybuffer"` and being confused by Blobs in the message event; server-side JSON.parse attempted on binary frames (that's what `isBinary` is for).

---

# Phase 8 — Progress, Errors, and Reliability

## Goal

Handle the unhappy paths: transfers that fail midway, peers who vanish mid-send, cancellation, and multiple files. The difference between a demo and software.

## Concepts

### Failure inventory (write yours before coding)

```text
1. Receiver disconnects mid-transfer   → sender must be told, loop must stop
2. Sender disconnects mid-transfer     → receiver must discard partial chunks
3. Receiver wants to cancel (huge file)→ needs a control message flowing "upstream"
4. Server restarts                     → both sides need reconnect UX (room is gone — by design)
5. Two files sent overlapping          → protocol A's "latest announced" assumption breaks
```

### Fixing #5: per-chunk ids (light version of protocol B)

Interleaved JSON+binary worked when transfers were strictly sequential. To allow two simultaneous transfers (or robust cancellation), each binary frame must self-identify. Prepend a tiny fixed header to each chunk:

```text
[ 8 bytes: file id, ASCII-padded ][ ...chunk bytes... ]
```

Sender: build with a Uint8Array concat. Receiver: `new DataView(buf)` / `buf.slice(8)` to split header from payload, route the chunk to `incoming.get(id).chunks`. Twenty lines total, and now chunks are unambiguous. (This is your first taste of designing a binary format — the same idea underlies TCP headers, PNG chunks, everything.)

### Cancellation is cooperative

There's no way to "un-send" — cancellation means asking the sender to stop: receiver sends `{type:"file-cancel", id}`, relay forwards it, sender's loop checks a `cancelled` Set each iteration and breaks. The receiver discards buffered chunks immediately, then *tolerates and drops* any chunks already in flight for that id (they were sent before the cancel arrived — draw the timeline and this stops being surprising).

## Implementation plan

1. Add the 8-byte chunk header; update sender/receiver accordingly.
2. **Peer-loss handling:** you already send `peer-left` (Phase 3). Now make the sender loop check a flag set by that message (`if (peerGone || cancelled.has(id)) break;`), and the receiver discard `incoming` entries on `peer-left`.
3. **Cancel buttons** on both ends' progress UI; wire the `file-cancel` flow.
4. **Receiver-side progress:** receiver knows `meta.size` and counts received bytes — show progress on both ends, not just the sender.
5. **Transfer states in the UI:** `sending → done | failed | cancelled` per file id. A finished transfer's UI should say which.
6. **Reconnect UX (not resume):** on WebSocket `close`, show a banner ("Connection lost — rooms are temporary, create a new one") rather than silently dying. True resumable transfers (offset negotiation on rejoin) are a genuinely meaty V2 feature — note it and move on.
7. **Chaos test:** start a 50 MB transfer, kill the receiver tab at 40% → sender stops within a second, UI shows "failed." Kill the *server* mid-transfer → both browsers show the banner. Cancel at 30% → both UIs agree.

## Checkpoint

```text
[ ] Two files sent at once both arrive intact
[ ] Killing either side mid-transfer produces a clean, labelled failure
[ ] Cancel works from the receiving side
[ ] I can explain why cancellation still lets a few chunks arrive
```

**Common mistakes:** infinite send loops after peer death (check every iteration, not just at start); treating in-flight chunks after cancel as a bug; attempting resume before basic reliability works.

---

# Phase 9 — Security Hardening

## Goal

Make the no-login architecture defensible: unguessable codes, rate limits, validated inputs, size caps, honest encryption claims.

## Concepts

### Identification vs Authentication vs Authorization — without accounts

- **Identification:** *who are you claiming to be?* Here: "someone holding room code A7K92P."
- **Authentication:** *prove it.* Here, knowledge of the code **is** the proof. The room code is a **bearer token** — like a movie ticket, whoever bears it gets in. No email needed; the secret itself authenticates.
- **Authorization:** *what may you do?* Here: a socket may only send to the room it authenticated into — which our routing already enforces structurally (`getPeer` can only ever return your roommate; there is no API to address anyone else). Notice that good architecture did most of the authorization work for free.

Security consequence of bearer tokens: anyone who sees the code *is* authenticated. Hence: codes must be unguessable, short-lived, and single-use-ish (room dies when empty).

### Why `Math.random()` would break everything

`Math.random()` is a *pseudo*-random generator optimized for speed, not secrecy — its internal state can be reconstructed from a handful of outputs, after which every future "random" code is predictable. An attacker could then precompute upcoming room codes. `crypto.getRandomValues` / `crypto.randomBytes` (what nanoid uses) draws from OS entropy and has no such weakness. Rule: **randomness that guards anything must come from `crypto`.**

### Guessing math + rate limiting

887M code space is only meaningful if attackers can't try millions of guesses. Rate-limit `join-room` attempts per IP (e.g., 10/min, then temporary block). Also rate-limit room *creation* (someone scripting 100k rooms is a memory DoS) and total concurrent connections per IP. For V1, a small in-memory `Map<ip, {count, windowStart}>` is fine — you'll clean it with the same sweeper as Phase 10.

### What's encrypted from whom (be precise)

```text
V1 (relay over WSS):
Browser A ──TLS──> Server ──TLS──> Browser B
  encrypted on the wire ✔        encrypted on the wire ✔
  but the SERVER sees plaintext ✘  → "transport encryption"

V2 (WebRTC DataChannel):
Browser A ══DTLS══════════════════ Browser B
  server never sees content ✔      → effectively end-to-end for our threat model

True E2E over a relay would mean the BROWSERS encrypt/decrypt
(Web Crypto API, key derived from something the server never sees) —
a great V3 project, not claimed until built.
```

Your UI/README must say exactly which of these you provide. Overclaiming privacy is the security equivalent of shipping XSS.

### Malicious files

You relay bytes; you cannot scan them meaningfully. Your defenses are: never execute/render received content (download only — no inline HTML preview of received files!), keep the receiver-initiated download flow (browser applies its own protections), display the *claimed* type but treat it as decoration, and rely on the trust relationship (peers chose to share a code). Image previews in V2 must use `createObjectURL` into an `<img>` only — never `innerHTML`.

## Implementation plan

1. Validation module: every inbound JSON message checked — known `type`, expected fields, length caps (`name` ≤ 255, `text` ≤ 10k, `size` ≤ 50 MB) — violations get an error + connection close.
2. Rate limiter middleware for `join-room`, `create-room`, and connection count per IP.
3. Cap binary frame size server-side (`data.length` ≤ CHUNK + header + slack) — a client sending 100 MB frames is hostile.
4. Timing-safe niceties: identical error message for "room not found" and "room expired" (don't leak which codes were real).
5. A `SECURITY.md` documenting: threat model, what's protected, what isn't, the honest encryption statement above.

## Checkpoint

```text
[ ] I can define identification/authentication/authorization for this app in one line each
[ ] 11th join attempt in a minute is refused
[ ] Oversized/malformed messages close the connection
[ ] My README states the exact encryption property truthfully
```

**Common mistakes:** claiming E2E encryption; validating only on the client; rate-limiting joins but not creations; letting received "images" render via innerHTML.

---

# Phase 10 — Temporary Rooms and Cleanup

## Goal

Rooms reliably die: when both leave, when idle too long, when never joined. Server memory stays flat forever.

## Concepts

**Why cleanup is a real feature:** every abandoned room is leaked memory *and* a live bearer token someone could still join. Cleanup is thus both a resource and a security task.

**Lifecycle to implement:**

```text
created ──(peer joins)──> active ──(one leaves)──> half ──(other leaves)──> deleted
   │                                                  │
   └── 10 min unjoined → deleted (sweeper)            └── 2 min no rejoin → deleted (sweeper)
Any room: 24h absolute max age → deleted (sweeper)
```

**Two cleanup mechanisms, both needed:** *event-driven* (the `close` handler — instant, but only fires when sockets close cleanly) and a *periodic sweeper* (`setInterval` every 60s scanning `rooms` for expiry — catches everything events miss, e.g. sockets that died without a close frame). Belt and suspenders is the standard pattern for expiring state.

**Detecting silent deaths — heartbeats:** a yanked cable or slept laptop sends no close frame; the server would hold a zombie socket forever. WebSocket has built-in **ping/pong** control frames: server pings every 30s; a socket that misses a pong is declared dead and `terminate()`d, which fires your normal close handler and thus normal cleanup. The `ws` README's heartbeat recipe is ~15 lines; implement it, then test by killing a client's network (not the tab) and watching the peer get `peer-left` within a minute.

**Do we need a database? (promised comparison)** State = a few hundred bytes per room, valueless after minutes, fine to lose on restart. **No database** is the correct choice, not a shortcut: Redis adds ops for persistence we don't want; PostgreSQL adds schema/migrations for relational queries we don't have; MongoDB adds a document store for... a Map. The honest limitation: state lives in *one process's memory*, so we can't run two server instances (each would have half the rooms) — that's the Phase 14 problem, and Redis becomes the right answer *there*, for sharing, not persistence.

## Implementation plan

1. Room struct gains `createdAt`, `lastActivity` (touched on every relayed message), `emptySince`.
2. Sweeper interval applying the lifecycle rules; log each deletion with a reason (you'll thank yourself in production).
3. Heartbeat ping/pong with `terminate()` on missed pong.
4. Kill-switch test suite (manual): never-joined room disappears in 10 min (temporarily set to 10s for testing); both-tabs-closed room deletes immediately; network-killed client detected ≤ 60s.

## Checkpoint

```text
[ ] Room count returns to 0 after every test scenario
[ ] I can explain why events alone aren't enough (and why sweepers alone aren't either)
[ ] I can explain why V1 correctly has no database, and what Redis would solve later
```

**Common mistakes:** cleanup only in close handlers (zombies accumulate); forgetting to clear the sweeper in tests (Jest "open handle" warnings); deleting the room while a peer is mid-reconnect grace period.

---

# Phase 11 — UI/UX That Respects the User

## Goal

Same features, drastically better feel. Priorities: clarity of connection state, effortless code sharing, and mobile usability — this app's killer use case is phone ↔ laptop.

## Implementation plan (design notes inline)

1. **Connection state is the UI's spine.** A persistent status strip: `waiting for peer / connected / peer left / reconnecting / room closed`. Every user confusion in apps like this is "is it working?" — answer it permanently on screen.
2. **Code sharing:** giant monospace code, one-tap copy with feedback, and a copyable join *link* (`https://yourapp/#A7K92P` — client reads `location.hash` and auto-joins). QR code (Phase 15) builds on this link.
3. **Drag-and-drop + paste:** drop zone covering the message area (`dragover`/`drop` events, `e.dataTransfer.files`); paste-to-send for clipboard images (`paste` event, `e.clipboardData.files`) — a magical touch that's ~10 lines.
4. **File messages that look like files:** icon by category, name, human size (`812 KB`), progress bar during, Download button after.
5. **Mobile:** viewport meta, 44px touch targets, `visualViewport` awareness so the keyboard doesn't cover the input, test on a real phone over your LAN (`http://<your-ip>:3000` — you'll need to allow it through your firewall; note some file APIs behave differently on iOS Safari — test, don't assume).
6. **Empty/edge states:** what shows before any message, during "waiting for peer," after "peer left." Empty states are where good UIs are won.
7. Accessibility pass: focus management when screens switch, `aria-live="polite"` on the message list and status strip, visible focus rings, contrast check.

## Checkpoint

```text
[ ] A non-technical friend completes phone→laptop photo transfer without asking questions
[ ] Every connection state is visible and worded for humans
[ ] Drag-drop, paste, and the join link all work
```

**Common mistakes:** hiding state behind toasts that vanish; desktop-only testing; drop handler forgetting `preventDefault` (browser navigates to the file).

---
# Phase 12 — Testing

## Goal

A test suite that lets you refactor without fear, covering room logic, the WebSocket protocol, and one end-to-end file transfer.

## Concepts

### The testing pyramid, applied to this app

```text
        E2E (few)        ← Playwright drives two real browsers through a transfer
   Integration (some)    ← real ws clients hit a real server instance, assert protocol
    Unit (many, fast)    ← rooms.js functions tested as pure logic, no network
```

- **Unit tests** are why Phase 3 put room logic in its own module: `createRoom`, `joinRoom` (full/not-found paths), `getPeer`, expiry rules — all testable with fake `{}` objects standing in for sockets, running in milliseconds.
- **Integration tests** answer "does the protocol actually work over a socket?" Pattern: start your server on a random port in `beforeAll`, connect two `ws` clients from the test, drive a scenario, assert on received messages. The awkward part is that WebSocket tests are event-driven — you'll write a small helper `waitForMessage(client, type)` returning a Promise; this one helper makes every test readable.
- **E2E** with Playwright: launch two browser contexts, create/join a room through the real UI, send a file, assert the download happened. One or two of these — they're slow but they test the truth.

**Tooling: Vitest** (or Jest — same API; Vitest is faster and config-free) + **Playwright**. What to consciously *not* test: the `ws` library itself, styling, and the browser's Blob implementation — test *your* logic and *your* protocol.

### What "should be tested" — the concrete list

```text
UNIT        room codes: length, alphabet, uniqueness over 10k generations
            join: success / not-found / full
            getPeer symmetry; cleanup rules with fake timers
INTEGRATION create→join handshake message sequence
            chat routed to peer, NOT echoed to sender, NOT to other rooms
            third join rejected with room-full
            file-start with oversize size field rejected
            disconnect produces peer-left
E2E         full two-browser text + file transfer, byte-size asserted
```

## Implementation plan

1. `npm i -D vitest` ; split `server/index.js` so the server is created in an exported function (`createServer()`) and only *started* when run directly — this is what makes integration tests possible.
2. Write unit tests for `rooms.js` including expiry via `vi.useFakeTimers()`.
3. Write the `waitForMessage` helper, then the integration list above.
4. `npm i -D @playwright/test` ; one E2E spec with two contexts.
5. Add `"test": "vitest run"` and run everything green.

## Checkpoint

```text
[ ] Tests pass; breaking joinRoom's length check makes exactly the right tests fail
[ ] I can explain what each pyramid layer catches that the others don't
[ ] Fake timers test expiry without waiting real minutes
```

**Common mistakes:** testing only happy paths (the failure cases *are* the product); sleeping fixed durations instead of awaiting events (slow + flaky); E2E-testing everything (minutes-long suites you'll stop running).

---

# Phase 13 — Deployment

## Goal

A public URL, HTTPS/WSS, working transfers between two real devices on different networks.

## Concepts

**What changes in production:**

```text
localhost                          production
─────────                          ──────────
http:// + ws://                    https:// + wss://  (TLS certificates)
you are the only user              strangers + scanners hit it within hours
crashes are visible                crashes must restart + be logged
port 3000 direct                   reverse proxy in front
```

**Reverse proxy:** a front-door server (nginx/Caddy — or your PaaS's built-in one) that terminates TLS and forwards traffic to your Node process. For WebSockets it must forward the `Upgrade` header — the classic "works locally, connection closes in prod" bug is a proxy dropping it. PaaS platforms handle this; on a VPS with nginx you need `proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";` and a long `proxy_read_timeout` (default 60s silently kills idle sockets — your Phase 10 heartbeat also conveniently keeps them alive).

**Hosting choice:** you want a **long-running process** (persistent connections + in-memory rooms), which rules out serverless/edge functions (they're per-request and stateless — a genuine architectural mismatch, not a fashion choice). Good fits: Render / Railway / Fly.io free-ish tiers, or a small VPS if you want the full nginx + certbot + systemd experience (recommended once, for the learning). Frontend hosting: since Express already serves `client/`, deploy as one service — separate static hosting (Netlify etc.) would put frontend and WS on different origins and force CORS ceremony for zero benefit at this scale. (CORS in one line: browsers block cross-origin requests unless the server opts in via headers; same-origin deployment sidesteps it entirely.)

**Environment variables:** `PORT` (host-assigned), `NODE_ENV`, later TURN credentials. Never hardcode; locally use a `.env` (git-ignored) if you like.

**Logging & monitoring, minimum viable:** structured console logs (JSON lines: event, roomCode, reason) — the platform captures stdout; a `/health` endpoint returning `{rooms: n, connections: m}`; an uptime pinger (e.g. any free monitor) hitting it. That triple answers "is it up, is it leaking, what happened."

## Implementation plan

1. Add `/health`; make the client's WS URL derive from `location` (done in Phase 2 — verify).
2. Push to GitHub; connect the repo to Render/Railway; set start command; deploy.
3. Verify in the browser: padlock, `wss://` in DevTools Network → WS tab, phone-on-4G ↔ laptop-on-wifi transfer (this is the moment the project becomes real — savor it).
4. Watch logs for a day; you *will* see scanner bots probing `/wp-admin` — your rate limiting is now non-theoretical.

## Checkpoint

```text
[ ] Public URL over HTTPS; transfers work across different networks
[ ] I can explain what a reverse proxy does and the Upgrade-header pitfall
[ ] I can explain why serverless doesn't fit this app
[ ] /health reports live room/connection counts
```

**Common mistakes:** hardcoded `ws://localhost:3000` (works nowhere else); proxy timeouts killing quiet rooms; deploying frontend and backend to different origins without a reason.

---

# Phase 14 — Scaling (Read Now, Build When Needed)

## Goal

Understand exactly what breaks when one server isn't enough, and what the fixes are. This phase is deliberately *knowledge*, not code — premature scaling is a classic project-killer, but you should be able to whiteboard the answers.

## Concepts

**What actually breaks with 2+ server instances:** in-memory `rooms` means Person A (connected to server 1) and Person B (server 2) can't find each other:

```text
        Load balancer
        /           \
   Server 1        Server 2
   rooms: {A7K92P}  rooms: {}     ← B joins here: "not found" ✘
```

**The fixes, in order of adoption:**

1. **Sticky sessions** — the load balancer hashes each client to a consistent server. Cheap, gets you surprisingly far; both peers must still land on the same server, so it fixes reconnects, not cross-server rooms.
2. **Redis pub/sub as inter-server mail** — room *directory* lives in Redis (`room:A7K92P → members`); each server subscribes to channels for its local clients; relaying to a peer on another server = publish to that channel. This is the standard architecture and the point where Redis earns its place (shared state, not persistence — as promised in Phase 10).
3. **Vertical honesty check** — a single decent Node process handles thousands of concurrent sockets; the relay's real ceiling is **bandwidth** (every file crosses your NIC twice). For a two-person-rooms app, you'd hit bandwidth costs long before connection counts.
4. **Which is the real argument for WebRTC (Phase 15):** P2P removes file bytes from your servers entirely — the scaling problem largely evaporates. TURN servers (coturn on a VPS, or a managed service) re-introduce some relay cost for the ~15% of strict-NAT pairs; that's the bandwidth budget line item to know about.

**Connection limits & abuse at scale:** per-IP caps (Phase 9) become per-IP *per-instance* unless coordinated through Redis too — a nice example of how every in-memory feature must be re-audited when going multi-server.

## Checkpoint

```text
[ ] I can draw the two-server room-split failure from memory
[ ] I can explain sticky sessions vs Redis pub/sub and what each fixes
[ ] I can explain why the relay's bottleneck is bandwidth, not CPU
[ ] I know what problem TURN cost budgets belong to
```

---

# Phase 15 — Advanced Improvements (V2 Menu)

Ordered by learning-value-per-effort. Each is scoped enough to start from this document alone.

**1. WebRTC P2P file transfer — the headline upgrade.** Your WebSocket becomes the signaling channel (it already reaches both peers — that's what signaling needs). Flow: on room-complete, A creates `RTCPeerConnection` (with a public STUN server in `iceServers`), creates a DataChannel, generates an *offer* (SDP text blob), relays it via `{type:"rtc-offer", sdp}`; B sets it as remote description, answers; both relay ICE candidates as they're discovered (trickle ICE); when the channel opens, port your Phase 7/8 protocol onto it nearly unchanged — DataChannels have their own backpressure (`bufferedAmount` + `bufferedamountlow` event, an *event* instead of your polling loop — strictly nicer). Keep the WS relay as automatic fallback when the channel fails to open within a timeout. Skip TURN initially; add coturn later and measure how many of your real transfers needed it.

**2. Resumable transfers.** Persist received chunk count per file id; on reconnect, receiver reports offsets, sender resumes from there. Teaches idempotency and protocol versioning.

**3. QR-code joining.** Render the Phase 11 join link as a QR (one tiny library, or an API-free canvas implementation if you want the deeper dive). Phone camera → instant join. Demo gold.

**4. True end-to-end encryption over the relay.** Derive a key *in the browsers* (ECDH via Web Crypto, exchanged over the DataChannel or from a secret in the URL *fragment* — fragments never reach the server), encrypt chunks client-side. Then the relay genuinely can't read anything and your privacy claim upgrades honestly. Substantial, excellent learning.

**5. Image/preview niceties.** `createObjectURL` into `<img>` for received images (only via object URLs — never innerHTML, per Phase 9), multiple-file selection, session transfer history, clipboard-image paste polish.

**6. Streamed downloads for huge files.** Service-worker-based streaming (the StreamSaver technique) so the receiver writes to disk as chunks arrive — removes the receiver-memory ceiling from Phase 7.

---

# Final Reference Sections

## Complete V1 architecture

```text
                    ┌────────────────────────────────────┐
                    │  Node process                      │
   Person A         │  ┌─────────┐    ┌──────────────┐  │         Person B
  ┌─────────┐  WSS  │  │ Express │    │ ws server    │  │  WSS   ┌─────────┐
  │ Browser │◄─────►│  │ static  │    │  msg router  │  │◄──────►│ Browser │
  │ app.js  │       │  │ /health │    │  validation  │  │        │ app.js  │
  └─────────┘       │  └─────────┘    │  rate limits │  │        └─────────┘
                    │                 └──────┬───────┘  │
                    │                 ┌──────┴───────┐  │
                    │                 │ rooms.js     │  │
                    │                 │ Map + sweeper│  │
                    │                 │ + heartbeat  │  │
                    │                 └──────────────┘  │
                    └────────────────────────────────────┘
                         (reverse proxy / TLS in front)
```

## Final folder structure

```text
droproom/
├── client/
│   ├── index.html          # both screens (home + room)
│   ├── style.css
│   ├── app.js              # WS connection, router, UI state
│   ├── transfer.js         # sendFile loop, receiver assembly
│   └── ui.js               # rendering, progress, drag-drop, states
├── server/
│   ├── index.js            # createServer() + start-if-main
│   ├── wsHandlers.js       # message router
│   ├── rooms.js            # room state + lifecycle
│   ├── validate.js         # message validation
│   └── rateLimit.js
├── tests/
│   ├── rooms.test.js
│   ├── protocol.test.js    # integration
│   └── e2e.spec.js         # Playwright
├── SECURITY.md
├── README.md               # includes the message-type spec
└── package.json
```

## Data-flow walkthroughs

**Create:** click → `{create-room}` → server generates code, stores room, replies `{room-created, code}` → UI shows code + waiting.

**Join:** enter code → `{join-room, code}` → validate (exists? <2 members? rate-limit ok?) → on success push socket, reply `{room-joined}` to B and `{peer-joined}` to A → both UIs unlock.

**Text:** A types → `{chat, text}` → server validates, stamps `ts`, forwards to `getPeer(A)` only → B renders; A rendered optimistically at send time.

**File:** A picks file → `{file-start, id, name, size, mime}` (server checks size cap) → forwarded → B allocates buffer → loop: A slices 64 KB → arrayBuffer → binary frame (8-byte id header) → server forwards blindly → B appends; A throttles on `bufferedAmount`, both update progress → `{file-end, id}` → B assembles `Blob`, verifies size, shows Download → user clicks → `createObjectURL` + `<a download>`.

**Disconnect:** socket closes (or misses pongs → terminated) → server removes it from room → survivor gets `{peer-left}`, aborts inbound/outbound transfers, UI shows state → room deleted when empty (event) or expired (sweeper).

## Security model summary

```text
PROTECTED    transport encryption (WSS) · unguessable crypto-random codes ·
             two-member cap · route-only-to-peer authorization · rate limits ·
             size caps · input validation · XSS-safe rendering · no storage at rest ·
             room expiry (bearer tokens die)
NOT PROTECTED (V1, stated honestly)
             server can technically read relayed data (no E2E) ·
             no malware scanning (peers trust each other) ·
             anyone holding a live code is "authenticated" ·
             no protection from a malicious *server operator*
```

## MVP (V1) checklist

```text
[ ] Create/join with 6-char crypto-random codes; 2-person cap enforced
[ ] Bidirectional real-time text w/ sender labels, server timestamps, XSS-safe
[ ] Chunked file transfer w/ backpressure, progress both ends, 50 MB cap
[ ] Cancellation + clean failure on disconnect; multi-file via chunk ids
[ ] Validation, rate limiting, honest SECURITY.md
[ ] Heartbeat + sweeper: room count provably returns to zero
[ ] Unit + integration + one E2E test, all green
[ ] Deployed on HTTPS/WSS with /health; cross-network transfer verified
```

## V2 checklist

```text
[ ] WebRTC DataChannel transfers with WS fallback   [ ] QR joining
[ ] Resumable transfers                             [ ] Image previews (object URLs)
[ ] True E2E encryption (Web Crypto)                [ ] Streamed downloads
[ ] TURN server + fallback metrics                  [ ] Redis pub/sub if multi-instance
```

## What you will have learned

HTTP vs push, the WebSocket protocol and lifecycle, protocol design (JSON control + binary data frames, then binary headers), routing vs broadcasting, ordering guarantees and their limits, NAT/ICE/STUN/TURN and signaling, WebRTC DataChannels, File/Blob/ArrayBuffer and streaming reads, chunking and backpressure, bearer-token auth and the identification/authentication/authorization triad, XSS-safe rendering, rate limiting, DoS thinking, state lifecycle + heartbeats + sweepers, the no-database decision and when Redis enters, the testing pyramid for event-driven systems, reverse proxies/TLS/WSS deployment, and the real scaling bottlenecks of relay architectures.

That list, spoken fluently because you *built* each item, is a stronger interview asset than the app itself. Build it phase by phase, keep a dev log of what broke, and put both the app and the log in the README.
