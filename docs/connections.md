# Connection modes — local, SSH, direct IP

The app has exactly one protocol ([`protocol.md`](./protocol.md)) and exactly one client
implementation. A *connection mode* only decides **how a reachable `ws://` URL is
obtained**. Nothing above that boundary ever branches on the mode.

## The three modes

| Mode | How the URL is obtained | Notes |
|---|---|---|
| **Local** | Read the gateway run-state file, dial `ws://127.0.0.1:<port>` | Optionally start/stop the local gateway through the `mason` CLI |
| **SSH** (default remote) | Supervise `ssh -N -L …`, dial `ws://127.0.0.1:<localport>` | Reuses the user's keys, ssh-agent and `~/.ssh/config` |
| **IP** (opt-in) | Dial the profile's `wss://host:port` | Requires TLS + token; gated behind a warning |

## Local mode

Run-state file: `~/.mason/run/gateway.json` — written by the gateway, read by the app.

- The reader is **tolerant**: keys are matched case/spacing-insensitively (`port`,
  `Port`, `pid`, `launch_mode`, `started_at`, `log_path`…), because the exact serialization
  is the framework's business.
- If the file is missing or has no port, the app shows "gateway not running" and offers
  `mason gateway --background` (executed through the CLI, never in a shell).
- The memories screen gets its data from the protocol's `memory.stats` frame, which mirrors
  `GET /health`'s `memory` block.

CLI actions exposed in Settings (local mode only, spawn without a shell):

```
mason gateway --background
mason gateway status | restart | stop
mason gateway logs --tail 80 --no-follow
```

The binary is resolved in this order: `~/.local/bin/mason`, `~/.mason/venv/bin/mason`,
`~/.nanobot/venv/bin/mason`, `/opt/homebrew/bin/mason`, `/usr/local/bin/mason`, then `PATH`.

## SSH mode

Implemented as a **tunnel only** — the app supervises the system `ssh` binary and then dials
loopback, exactly like local mode.

```
ssh -N -T \
    -o BatchMode=yes \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=15 \
    -o ServerAliveCountMax=3 \
    -o StrictHostKeyChecking=accept-new \
    [-p <ssh_port>] \
    -L 127.0.0.1:<localport>:127.0.0.1:<remote_port> \
    <host>
```

- `<host>` is `user@host` or a plain alias understood by `~/.ssh/config` (host aliases,
  `Port`, `ProxyJump` all work for free).
- `remote_port` is the gateway port **on the remote machine's loopback** — default
  `18790`.
- `<localport>` is chosen by binding `127.0.0.1:0` and releasing it, then passed to `ssh`.
- `BatchMode=yes`: the app **never** prompts for or stores passwords. Key/agent auth only.
- `ExitOnForwardFailure=yes`: if the forward can't be established, `ssh` exits nonzero and
  the supervisor reports a real error instead of hanging.
- `-T -N`: no remote command, no TTY.

**Supervisor duties** (Rust, `src-tauri/src/tunnel.rs` + `ws.rs`):

1. Spawn; poll TCP `127.0.0.1:<localport>` (250 ms) until reachable, up to 20 s.
2. If `ssh` exits or the port stops answering, respawn with exponential backoff
   (1 s → 30 s, jittered).
3. Kill the child on disconnect and on app exit (`kill_on_drop` + explicit kill).

A healthy tunnel is **kept across WebSocket reconnects**; it is only torn down when it fails
a health check or the user disconnects.

## Direct IP mode (opt-in, later)

- URL must be `wss://…` **unless** the host is loopback (`ws://` to loopback is allowed for
  development). The app refuses plaintext `ws://` to non-loopback hosts, because the
  gateway's `/health` is unauthenticated off-loopback and TLS is mandatory there.
- A device token is required; the pairing handshake is identical.
- The UI states the trade-off explicitly before this mode can be saved.

## Profiles

Persisted in the Tauri app-config directory (`profiles.json`):

| field | meaning |
|---|---|
| `id`, `name` | identity + display name |
| `mode` | `local` \| `ssh` \| `ip` |
| `sshHost`, `sshPort?`, `sshRemotePort?` | SSH mode target |
| `url` | IP mode endpoint (`wss://…`) |
| `token` | device token issued by the pairing handshake (revocable) |
| `autoConnect?` | connect on app start |

Rules:

- No passwords, ever — not stored, not prompted. Secrets may live in `~/.ssh/config`,
  ssh-agent, or the OS keychain; the profile file holds only a revocable device token.
- Tokens are replaced automatically when the server rotates them, and are cleared with
  "Forget token" in Settings (the owner should also `mason pairing revoke desktop <sender>`
  server-side).

## Reconnect and status

One status machine is shared by all modes (`connecting → connected → reconnecting →
disconnected | error | unauthorized`). Backoff and stop conditions are specified in
[`protocol.md` §7](./protocol.md#7-client-reconnect-policy).
