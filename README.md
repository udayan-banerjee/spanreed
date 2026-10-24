# Spanreed

Two people, one four-digit code, text straight between their browsers.
No accounts, nothing stored after both of them leave.

```
npm install
npm run dev        # http://localhost:3000, or PORT from .env
```

## Protocol

Every frame in both directions is a JSON object with a string `type`.
Anything that isn't valid JSON, isn't an object, or has no string `type` is
rejected before it reaches a handler.

A room holds exactly two sockets. Rooms live in memory, so a server restart
drops every room. A room with only one person in it is deleted after three
minutes, whether that is because nobody ever joined or because the other
person left.

### Client → server

```json
{ "type": "create-room" }
```
Makes a room, puts you in it, and answers with the code.

```json
{ "type": "join-room", "code": "4821" }
```
Joins an existing room. `code` is a **string** of four digits — a number will
not match, because room codes are stored as string keys.

```json
{ "type": "chat", "text": "the password is in the next message" }
```
Relayed to the other person. Not echoed back to you — render your own
messages locally when you send them.

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
Sent to the person already in the room when someone joins. Both sides are now
live; this and `room-joined` are the two "you may start" signals.

```json
{ "type": "peer-left", "closesIn": 180000 }
```
Sent to whoever is still in the room when the other socket closes. If the room
is now empty it is deleted. `closesIn` is milliseconds until the room closes
itself for being down to one person — it travels with the message so clients
never hardcode a duration that could drift from the server's.

```json
{ "type": "room-expired" }
```
Sent to whoever is left when a room has held only one person for three
minutes. The server deletes the room first, so the code stops working at the
same moment — the client should return to the home screen.

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
| `invalid-json` | The frame wasn't parseable JSON. |
| `invalid-message` | Parsed, but not an object with a string `type`. |
| `unknown-type` | No handler for that `type`. |
| `not-found` | No room with that code. |
| `full` | That room already holds two people. |
| `no-peer` | Sent `chat` with nobody else in the room. |
| `internal-error` | A handler threw. Details stay in the server log. |
| `close-error` | Disconnect cleanup threw. |

Ordering between the two sockets is not guaranteed. `room-joined` and
`peer-joined` travel on different connections, so neither side may assume one
arrives before the other.

## Not implemented yet

These are part of the planned file-transfer phase. The server has no handler
for them today and will answer `unknown-type`.

```json
{ "type": "file-start", "id": "f_x1", "name": "cat.jpg", "size": 812345, "mime": "image/jpeg" }
```
Announces an incoming file. `id` ties the chunks and the end marker together,
so several transfers can be in flight at once. `size` is bytes, and lets the
receiver show progress rather than a spinner.

```json
{ "type": "file-end", "id": "f_x1" }
```
Marks that transfer complete. The receiver assembles the buffered chunks into
a blob of type `mime` and offers it for download.

Binary chunks between these two travel as raw WebSocket frames, not JSON, so
they are not run through `JSON.stringify`.
