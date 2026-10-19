use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;

use crate::config::{Mode, Profile};
use crate::tunnel::{SshSpec, TunnelHandle};

/// The result of resolving a profile: "a reachable ws:// URL".
/// Everything above this boundary is mode-agnostic.
pub struct Target {
    pub ws_url: String,
}

/// Tolerant view of `~/.mason/run/gateway.json`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayState {
    pub found: bool,
    pub running: bool,
    pub port: Option<u16>,
    pub pid: Option<u32>,
    pub launch_mode: Option<String>,
    pub started_at: Option<String>,
    pub log_path: Option<String>,
    pub state_path: String,
}

pub fn gateway_state_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "cannot resolve the home directory".to_string())?;
    Ok(home.join(".mason").join("run").join("gateway.json"))
}

/// Read the gateway run-state file. Keys are matched case/spacing-insensitively, because
/// the exact serialization is the framework's business.
pub fn read_gateway_state() -> GatewayState {
    let path = gateway_state_path();
    let state_path = path
        .as_ref()
        .map(|path| path.display().to_string())
        .unwrap_or_default();
    let mut out = GatewayState {
        found: false,
        running: false,
        port: None,
        pid: None,
        launch_mode: None,
        started_at: None,
        log_path: None,
        state_path,
    };
    let Ok(path) = path else { return out };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return out;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return out;
    };
    out.found = true;

    let lookup = |names: &[&str]| -> Option<serde_json::Value> {
        let object = value.as_object()?;
        object.iter().find_map(|(key, value)| {
            let normalized: String = key
                .chars()
                .filter(|c| c.is_ascii_alphanumeric())
                .collect::<String>()
                .to_ascii_lowercase();
            if names.contains(&normalized.as_str()) {
                Some(value.clone())
            } else {
                None
            }
        })
    };

    out.port = lookup(&["port"])
        .and_then(|value| value.as_u64())
        .and_then(|port| u16::try_from(port).ok());
    out.pid = lookup(&["pid"])
        .and_then(|value| value.as_u64())
        .and_then(|pid| u32::try_from(pid).ok());
    out.launch_mode =
        lookup(&["launchmode", "mode"]).and_then(|value| value.as_str().map(str::to_string));
    out.started_at =
        lookup(&["startedat", "started"]).and_then(|value| value.as_str().map(str::to_string));
    out.log_path =
        lookup(&["logpath", "logs", "log"]).and_then(|value| value.as_str().map(str::to_string));
    out.running = out.port.is_some();
    out
}

/// Resolve a profile to a reachable WebSocket URL, spawning or reusing the SSH tunnel
/// when needed. A healthy tunnel is kept across WebSocket reconnects.
pub async fn resolve(
    profile: &Profile,
    tunnel: &mut Option<TunnelHandle>,
) -> Result<Target, String> {
    match profile.mode {
        Mode::Local => {
            let state = read_gateway_state();
            let Some(port) = state.port else {
                return Err(format!(
                    "no local gateway run-state found at {} — start it with `mason gateway --background`",
                    state.state_path
                ));
            };
            Ok(Target {
                ws_url: format!("ws://127.0.0.1:{port}"),
            })
        }
        Mode::Ssh => {
            let spec = SshSpec::from_profile(profile)?;
            let alive = match tunnel.as_mut() {
                Some(handle) => handle.healthy().await,
                None => false,
            };
            if !alive {
                if let Some(old) = tunnel.take() {
                    old.kill().await;
                }
                *tunnel = Some(TunnelHandle::spawn(&spec).await?);
            }
            let handle = tunnel
                .as_mut()
                .expect("the tunnel was just spawned or reused");
            handle.wait_ready(Duration::from_secs(20)).await?;
            Ok(Target {
                ws_url: format!("ws://127.0.0.1:{}", handle.local_port),
            })
        }
        Mode::Ip => {
            let url = profile.url.clone().unwrap_or_default();
            if !(url.starts_with("wss://") || url.starts_with("ws://")) {
                return Err("IP mode requires a ws:// or wss:// URL".to_string());
            }
            let is_loopback = url.starts_with("ws://127.0.0.1")
                || url.starts_with("ws://localhost")
                || url.starts_with("ws://[::1]");
            if url.starts_with("ws://") && !is_loopback {
                return Err(
                    "refusing plaintext ws:// to a non-loopback host — direct mode requires wss:// (TLS)"
                        .to_string(),
                );
            }
            Ok(Target { ws_url: url })
        }
    }
}

#[tauri::command]
pub fn local_gateway_status() -> GatewayState {
    read_gateway_state()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliOutput {
    pub ok: bool,
    pub output: String,
}

/// Run the `mason` CLI (local mode only). Never via a shell.
#[tauri::command]
pub async fn gateway_cli(action: String) -> Result<CliOutput, String> {
    let args: Vec<&str> = match action.as_str() {
        "start" => vec!["gateway", "--background"],
        "stop" => vec!["gateway", "stop"],
        "restart" => vec!["gateway", "restart"],
        "status" => vec!["gateway", "status"],
        "logs" => vec!["gateway", "logs", "--tail", "80", "--no-follow"],
        other => return Err(format!("unsupported gateway action: {other}")),
    };
    let binary = find_mason_binary().ok_or_else(|| {
        "could not find the `mason` CLI (checked ~/.local/bin, ~/.mason/venv/bin, \
         ~/.nanobot/venv/bin, Homebrew and PATH)"
            .to_string()
    })?;
    let output = tokio::process::Command::new(binary)
        .args(args)
        .output()
        .await
        .map_err(|err| format!("failed to run mason: {err}"))?;
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !stderr.trim().is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&stderr);
    }
    Ok(CliOutput {
        ok: output.status.success(),
        output: text,
    })
}

fn find_mason_binary() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".local").join("bin").join("mason"));
        candidates.push(home.join(".mason").join("venv").join("bin").join("mason"));
        candidates.push(
            home.join(".nanobot")
                .join("venv")
                .join("bin")
                .join("mason"),
        );
    }
    candidates.push(PathBuf::from("/opt/homebrew/bin/mason"));
    candidates.push(PathBuf::from("/usr/local/bin/mason"));
    for candidate in &candidates {
        if candidate.is_file() {
            return Some(candidate.clone());
        }
    }
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join("mason");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}
