# MasonDesk

A desktop client for the [Mason](https://github.com/Mochi-Sora/MasonAgent) agent
framework — chat, sessions, cron, memories, and settings over **local**, **SSH**, or
**direct IP** connections, built with Tauri v2 (Rust shell + vanilla TypeScript UI).

> **Status:** client implemented against the frozen protocol (additive v1.1: attachments).
> The gateway-side `desktop` channel lives in the framework repo (`mason/channels/desktop/`),
> including `media.upload`; `dev/mock-gateway.mjs` remains the reference server.

## Quickstart

### UI development, without Rust or the framework (recommended first run)

```bash
npm install
npm run mock     # terminal 1: mock gateway on ws://127.0.0.1:18790
npm run dev      # terminal 2: open the printed URL in a browser
```

The UI detects it is running outside Tauri and talks directly to the mock gateway with the
same protocol frames the desktop app uses. Try:

- `hello` — auto-pairs the dev profile;
- send any message — streamed deltas, a final message, `turn.end`;
- include `tool` in a message — the approval flow (`Approve` / `Deny`), tool and file-edit chips;
- include `long` in a message — a long stream to exercise `Stop` (turn interrupt);
- attach files (paperclip, drag & drop, or paste), record a voice note with the microphone, and
  send — each uploads first (`media.upload`) and is echoed back on the user message;
- while a `long` answer streams, press Enter to **queue** the draft or ⌘/Ctrl+Enter to **steer**
  the running turn (`chat.inject`); Esc stops it;
- `npm run smoke` — a 41-check conformance suite for [`docs/protocol.md`](docs/protocol.md)
  against the mock gateway.

### Desktop app (needs the Rust toolchain)

```bash
npm run tauri dev      # dev window
npm run tauri build    # bundle (icons/signing are still Phase 5 work)
```

Requires `cargo`/`rustc` on `PATH` (`~/.cargo/bin`). The Rust side owns the WebSocket, the
SSH tunnel supervisor, reconnect/backoff, and connection profiles.

## How it is put together

```
MasonDesk/
├── docs/
│   ├── protocol.md        # the frozen frame contract (build this first — done)
│   └── connections.md     # local / SSH / IP semantics and tunnel rules
├── dev/
│   ├── mock-gateway.mjs   # reference implementation of the protocol
│   └── smoke.mjs          # protocol conformance checks
├── src/                   # UI (vanilla TypeScript)
│   ├── main.ts            # shell, router, wiring
│   ├── protocol.ts        # frame types — mirrors docs/protocol.md
│   ├── chat.ts            # events → transcript (streaming, tools, approvals, one box per turn)
│   ├── media.ts           # attachments: classify, base64, upload, voice notes
│   ├── connection/        # client, profiles, gateway CLI helpers
│   └── views/             # chat, sessions, cron, memories, settings
└── src-tauri/src/
    ├── transport.rs       # profile → "a reachable ws:// URL"
    ├── tunnel.rs          # supervised `ssh -N -L` tunnel
    ├── config.rs          # persisted connection profiles + device tokens
    └── ws.rs              # protocol client, status machine, reconnect loop
```

The load-bearing idea: **all three connection modes are the same protocol**. SSH is a
tunnel, not a transport — see [`docs/connections.md`](docs/connections.md).

Design rules honoured from the framework brief:

- one protocol everywhere, even locally — no second code path;
- pairing-code device authorization (revocable), never passwords;
- direct IP is opt-in, requires TLS + token, and plaintext `ws://` is refused for
  non-loopback hosts;
- the `/health` `memory` block is reused verbatim as `memory.stats`.

## Connecting the real thing

1. Framework-side work (separate change): `mason/channels/desktop/` implements
   [`docs/protocol.md`](docs/protocol.md) including §3.1 attachments. Enable it under
   `channels.desktop` in the gateway config (onboarding, or `mason plugins enable desktop`).
   `dev/smoke.mjs` doubles as its acceptance suite.
2. In Settings, add a profile:
   - **local** — reads `~/.mason/run/gateway.json` for the port (optionally start/stop the
     gateway via the `mason` CLI);
   - **SSH** — `user@host` (or an `ssh_config` alias), remote loopback port (default
     `18790`); the app supervises `ssh -N -L` and reuses your keys/agent;
   - **IP** — `wss://host:port`, opt-in.
3. First connect shows a pairing code; approve it on the gateway host with
   `mason pairing approve <code>`. The device token is stored per profile.

## Attachments

Composer media follows [`docs/protocol.md`](docs/protocol.md) §3.1: every file is uploaded with
`media.upload` (base64, standard alphabet) and then referenced by id from `chat.send`. Photos,
voice notes, audio, video and arbitrary files are all the same frame.

- Sources: the paperclip picker, drag & drop onto the chat view, paste from the clipboard, and
  the microphone (voice notes) via `MediaRecorder`;
- kinds: `image` (click to open), `audio` / `video` (inline player), `file` (chip);
- sizing: the client pre-checks against `hello.limits.max_upload_bytes` (falling back to 25 MiB),
  the server cap is `channels.desktop.maxUploadMb` (default 25) and answers `too_large` beyond it;
  a frame past the transport's own maximum closes the socket with 1009 instead;
- reloads: `sessions.history` repeats the attachment records, and when the gateway advertises
  `hello.limits.max_fetch_bytes` the client fetches the bytes back over `media.fetch` to restore
  thumbnails and players (`media_gone` / `too_large` fall back to the chip, and results are
  cached per id);
- audio attachments are transcribed on the gateway when a transcription provider is configured
  (the transcript is appended to the message the model sees);
- recording needs macOS microphone permission — `src-tauri/Info.plist` carries the usage
  description, so the prompt only appears for a bundled build.

## Steering and queueing

While Mason answers, the composer stays usable:

- **Enter** queues the draft. The client holds it and sends it as the next turn when the
  running one ends (FIFO, per session), and the queued chips above the input show what is
  waiting — remove one with its ✕.
- **⌘/Ctrl+Enter** (or **Steer**) injects it into the running turn over `chat.inject`: the
  gateway drains it at its next model boundary and continues the **same** turn, with exactly
  one `turn.end`. Requires the gateway to advertise `chat.inject` in `hello.features`
  ([`docs/protocol.md`](docs/protocol.md) §3.4); without it the same keystroke queues instead.
- **Esc** (or **Stop**) interrupts the turn.

Queueing is purely client-side; steering is an additive protocol frame (v1.4) implemented by
both the mock gateway and the framework channel.

## Not done yet

- `media.fetch` (§3.2 of the protocol) is implemented client-side and in the mock gateway, but
  the framework gateway does not serve it yet — until it does, a real reloaded session falls back
  to metadata chips. The framework-side spec is in [`fixes-to-be-done.md`](./fixes-to-be-done.md).
- Phase 5: icons, bundles, signing, auto-update.
- No GitHub remote has been created.

## Licence

**AGPL-3.0-or-later** — full text in [`LICENSE`](LICENSE); the copyright holder and the
standard application notice are in [`NOTICE`](NOTICE). © 2026 Mochi-Sora. MasonDesk is a
separate work licensed the same way as the
[Mason framework](https://github.com/Mochi-Sora/MasonAgent) it talks to.
