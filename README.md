# Spanreed

Two people, one four-digit code, text and files straight between their
browsers. No accounts, nothing kept after both of them leave.

One person opens a channel and gets a code. The other types it in. From then
on either side can send text or files until someone closes the tab.

---

## Running it

```
npm install
npm run dev        # auto-restarts on save
npm start          # plain start
```

Then open the port it prints. `PORT` comes from `.env` (gitignored) or falls
back to `3000`. Requires Node 18+; developed on Node 24.

To show it to someone else without deploying, point a tunnel at it:

```
cloudflared tunnel --url http://localhost:5000
```

The page picks `wss://` automatically when served over HTTPS.

---

## Layout

```
client/
├── index.html        three screens in one file, toggled with [hidden]
├── app.js            all browser logic: socket, UI, file chunking
├── style.css         app styles — no colour or font-size literals
└── icons/            copy, file, download, upload (used as CSS masks)
server/
├── index.js          HTTP + WebSocket, the only place that sends frames
├── rooms.js          room state: the Map, codes, idle timers
└── routers/
    └── messageRouter.js   one case per message type, returns an envelope
design/
└── tokens.css        every colour, type-scale and spacing value
```

There is no build step. The server serves `client/` statically and mounts
`design/` so the page can load `tokens.css`.

---

## How it fits together

**The server never holds your data.** It matches two sockets by a code and
forwards bytes between them. Text is relayed as JSON; file chunks are relayed
as raw binary frames without being parsed or buffered to disk.

**Rooms live in memory.** `rooms.js` keeps a `Map` of code → `{ clients,
createdAt, timer }`. A restart drops every room, and the app must run as a
**single instance** — with two instances behind a load balancer, two people
can land on different servers and the code will not match.

**Only `index.js` sends anything.** Handlers in `messageRouter.js` are pure:
they return an envelope

```js
{ reply: <message to the sender>, outbox: [{ to: <socket>, msg: <message> }] }
```

and `index.js` walks it, passing everything through one `safeSend` that checks
the socket is open, serialises, and swallows errors. That keeps transport
concerns out of the protocol logic and makes handlers testable without sockets.

**Room lifecycle.** Codes are four digits (`0000`–`9999`, 10,000 of them), so
they are short enough to read aloud. A room holds exactly two sockets. A room
with only one person in it — because nobody joined, or because the other
person left — deletes itself after **three minutes** and tells whoever is left.

---

## Protocol

Every frame in both directions is either a JSON object with a string `type`,
or a raw binary frame (a file chunk). Anything that is not valid JSON, is not
an object, or has no string `type` is rejected before reaching a handler.

### Client → server

```json
{ "type": "create-room" }
```
Makes a room, puts you in it, answers with the code.

```json
{ "type": "join-room", "code": "4821" }
```
Joins an existing room. `code` is a **string** — a number will not match,
because codes are stored as string keys.

```json
{ "type": "chat", "text": "the password is in the next message" }
```
Relayed to the other person. **Not echoed back to you** — render your own
messages locally when you send them.

```json
{ "type": "file-start", "id": "f_10001", "name": "cat.jpg", "size": 812345, "mime": "image/jpeg" }
```
Announces a file. Everything that follows until `file-end` is its content.

```json
{ "type": "file-end", "id": "f_10001" }
```
That transfer is complete.

Between those two, the sender emits **raw binary frames** of 64 KB. They are
forwarded untouched.

### Server → client

```json
{ "type": "room-created", "code": "4821" }
```
Answer to `create-room`. Show the code and wait.

```json
{ "type": "room-joined", "code": "4821" }
```
Answer to a successful `join-room`, sent to the person who joined.

```json
{ "type": "peer-joined", "code": "4821" }
```
Sent to the person already in the room. This and `room-joined` are the two
"you may start" signals — one per side.

```json
{ "type": "peer-left", "closesIn": 180000 }
```
The other socket closed. `closesIn` is milliseconds until the room deletes
itself for being down to one person. It travels with the message so clients
never hardcode a duration that could drift from the server's.

```json
{ "type": "room-expired" }
```
The room was deleted after three minutes with one person in it. The code stops
working at the same moment, so the client returns to the home screen.

```json
{ "type": "chat", "text": "…", "from": "peer", "ts": 1792131671528 }
```
A message from the other person. `ts` is epoch milliseconds from the **server**
clock, so both ends agree on ordering regardless of local time.

```json
{ "type": "error", "reason": "not-found" }
```
Every failure uses this shape. `reason` is a stable machine-readable token,
never prose — the UI maps it to a sentence.

| `reason` | Means |
|---|---|
| `invalid-json` | The frame was not parseable JSON. |
| `invalid-message` | Parsed, but not an object with a string `type`. |
| `unknown-type` | No handler for that `type`. |
| `not-found` | No room with that code. |
| `full` | That room already holds two people. |
| `no-peer` | Sent something with nobody else in the room. |
| `internal-error` | A handler threw. Details stay in the server log. |
| `close-error` | Disconnect cleanup threw. |

**Ordering between the two sockets is not guaranteed.** `room-joined` and
`peer-joined` travel on different connections, so neither side may assume one
arrives before the other.

---

## File transfer

The sender slices the `File` into **64 KB** chunks and sends them as binary
frames between `file-start` and `file-end`. The receiver collects them in an
array and assembles a `Blob` at the end, which becomes the `href` of a real
`<a download>`.

**Chunks carry no id.** The receiver attributes every chunk to the most recent
`file-start`, which is only correct while transfers stay strictly sequential.
Two things keep that true, and both matter:

- `sendFile` is awaited per file, so a multi-file selection goes one at a time.
- A `sending` flag disables the submit button for the duration, so a second
  Send cannot start a concurrent transfer on the same socket.

Remove either and chunks from two files interleave. Nothing errors — both
files arrive the right size, with scrambled contents.

### Backpressure

`ws.bufferedAmount` in the browser only measures **browser → server**, which on
a local connection is never backed up. Left alone, the sender blasts a whole
file at full speed and the server queues whatever the receiver has not taken
yet in its own memory — roughly the size of the file.

So the server propagates the pressure: when `peer.bufferedAmount` passes
`PEER_HIGH_WATER` (1 MB) it pauses the *sender's* TCP socket, and resumes it
from the send callback once the peer has caught up. That stalls TCP, which
fills the browser's outbox, which finally makes the sender's own
`HIGH_WATER` loop fire. Without the server half, that client loop can never
trigger.

---

## Front end

Three screens in one document — `.home-screen`, `.room-screen`,
`.joined-room` — toggled with the `hidden` attribute. Because they are flex
containers, `[hidden] { display: none !important }` is load-bearing; without it
the flex display wins and every screen shows at once.

The visual design is "Quiet Paper": a warm off-white ground, Instrument Serif
for display and Inter for UI, hairline rules instead of boxes, and exactly one
accent (sage). **`design/tokens.css` is the only place colour, type-scale and
spacing values are defined** — nothing else hardcodes a hex or a px font-size.
Fonts come from Google Fonts, with Georgia and `system-ui` as fallbacks.

Behaviour worth knowing:

- **Enter sends, Shift+Enter newlines.** Enter also joins from the code field.
  Both guard `e.isComposing` so an IME confirming a word does not send.
- **Messages over 8 lines** collapse behind a "Show more" toggle. The clamp
  uses `line-clamp` with `overflow: clip` and `overflow-clip-margin:
  content-box` — plain `overflow: hidden` clips at the *padding* box and lets a
  ninth line show through.
- **Progress shows on both ends.** The receiver renders the file row at
  `file-start` and fills the bar as chunks arrive, rather than waiting.
- **Direction is carried by three cues at once** — alignment, fill, and the
  tail corner of the bubble — so it survives greyscale and colour-blindness.

---

## Not implemented

Described in the design spec or planned, but not built:

- **Cancelling a transfer in flight.** The progress bar has no stop button.
- **Drag and drop.** The dashed zone opens the file picker; it does not accept
  a drop.
- **A file size limit.** Nothing rejects a large file up front.
- **Header furniture** — the room-code chip with copy button, a persistent
  status line, and a "Leave room" button.
- **Rate limiting.** With 10,000 codes and no throttle, codes are guessable.

Known rough edges:

- `errorList` in `app.js` maps three of the eight error reasons and has no
  fallback, so an unlisted one writes an empty string into the notice.
- The idle countdown starts when the client receives `peer-left`, the server's
  timer when the socket closed. It is indicative, not authoritative.
- `design/DESIGN.md` and the reference mockups are gitignored, so a fresh clone
  gets `tokens.css` without the document explaining it.

---

## Deploying

Needs a host that runs a persistent Node process with WebSocket support —
Render, Railway, Fly. Serverless platforms cannot hold a socket open.

Two things to get right:

1. Bind `process.env.PORT`. Platforms inject it and health-check that port;
   this is already wired, but a hardcoded port is the classic silent failure.
2. **Run exactly one instance.** Rooms are in memory, so autoscaling breaks
   matching.

Free tiers sleep when idle, and waking drops every open room.
