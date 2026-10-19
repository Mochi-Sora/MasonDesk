use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;

use crate::config;
use crate::transport::{self, Target};
use crate::tunnel::TunnelHandle;

/// Raw server frames (responses *and* events), as JSON objects.
pub const FRAME_EVENT: &str = "masondesk://frame";
/// Connection status machine transitions.
pub const STATUS_EVENT: &str = "masondesk://status";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusPayload {
    pub state: String,
    pub mode: Option<String>,
    pub detail: Option<String>,
    pub attempt: u32,
    pub profile_id: Option<String>,
}

/// Shared connection state. Managed by Tauri; `inner` is cloned into the session task.
#[derive(Default, Clone)]
pub struct WsState {
    inner: Arc<Mutex<Option<Session>>>,
}

struct Session {
    token: String,
    cancel: CancellationToken,
    sender: mpsc::UnboundedSender<String>,
    profile_id: String,
    mode: Option<String>,
    attempt: u32,
    state: String,
    detail: Option<String>,
}

impl Session {
    fn payload(&self) -> StatusPayload {
        StatusPayload {
            state: self.state.clone(),
            mode: self.mode.clone(),
            detail: self.detail.clone(),
            attempt: self.attempt,
            profile_id: Some(self.profile_id.clone()),
        }
    }
}

enum Outcome {
    Cancelled,
    Unauthorized,
    Fatal(String),
    Retry(String),
}

fn next_token() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}")
}

/// Start (or restart) a connection for a profile. Non-blocking: the session task owns
/// the socket, the tunnel, and the reconnect loop.
pub fn start(app: AppHandle, state: &WsState, profile_id: String) -> Result<(), String> {
    let Some(profile) = config::find(&app, &profile_id) else {
        return Err(format!("unknown profile: {profile_id}"));
    };
    stop(state);
    let cancel = CancellationToken::new();
    let (sender, receiver) = mpsc::unbounded_channel::<String>();
    let session = Session {
        token: next_token(),
        cancel: cancel.clone(),
        sender,
        profile_id: profile.id.clone(),
        mode: Some(profile.mode.as_str().to_string()),
        attempt: 0,
        state: "connecting".to_string(),
        detail: None,
    };
    let payload = session.payload();
    let token = session.token.clone();
    if let Ok(mut guard) = state.inner.lock() {
        *guard = Some(session);
    }
    let _ = app.emit(STATUS_EVENT, payload);
    tauri::async_runtime::spawn(session_task(
        app,
        profile,
        receiver,
        cancel,
        state.clone(),
        token,
    ));
    Ok(())
}

fn stop(state: &WsState) {
    if let Ok(mut guard) = state.inner.lock() {
        if let Some(session) = guard.take() {
            session.cancel.cancel();
        }
    }
}

fn current_attempt(state: &WsState, token: &str) -> u32 {
    match state.inner.lock() {
        Ok(guard) => guard
            .as_ref()
            .filter(|session| session.token == token)
            .map(|session| session.attempt)
            .unwrap_or(0),
        Err(_) => 0,
    }
}

fn mark(
    app: &AppHandle,
    state: &WsState,
    token: &str,
    new_state: &str,
    detail: Option<String>,
    attempt: Option<u32>,
) {
    let payload = match state.inner.lock() {
        Ok(mut guard) => match guard.as_mut() {
            Some(session) if session.token == token => {
                session.state = new_state.to_string();
                session.detail = detail;
                if let Some(attempt) = attempt {
                    session.attempt = attempt;
                }
                Some(session.payload())
            }
            _ => None,
        },
        Err(_) => None,
    };
    if let Some(payload) = payload {
        let _ = app.emit(STATUS_EVENT, payload);
    }
}

async fn session_task(
    app: AppHandle,
    profile: config::Profile,
    mut receiver: mpsc::UnboundedReceiver<String>,
    cancel: CancellationToken,
    state: WsState,
    token: String,
) {
    let mut tunnel: Option<TunnelHandle> = None;

    loop {
        if cancel.is_cancelled() {
            break;
        }
        let attempt = current_attempt(&state, &token);
        let phase = if attempt == 0 { "connecting" } else { "reconnecting" };
        mark(&app, &state, &token, phase, None, None);

        let outcome = match transport::resolve(&profile, &mut tunnel).await {
            Ok(target) => run_connected(&app, &state, &token, &target, &mut receiver, &cancel).await,
            Err(err) => Outcome::Retry(err),
        };

        match outcome {
            Outcome::Cancelled => break,
            Outcome::Unauthorized => {
                mark(&app, &state, &token, "unauthorized", None, None);
                break;
            }
            Outcome::Fatal(detail) => {
                mark(&app, &state, &token, "error", Some(detail), None);
                break;
            }
            Outcome::Retry(detail) => {
                mark(
                    &app,
                    &state,
                    &token,
                    "disconnected",
                    Some(detail),
                    Some(attempt + 1),
                );
            }
        }

        if cancel.is_cancelled() {
            break;
        }
        if !sleep_backoff(&cancel, attempt + 1).await {
            break;
        }
    }

    if let Some(handle) = tunnel.take() {
        handle.kill().await;
    }

    // Only clear the shared session if it is still ours; a newer connect() replaces it.
    if let Ok(mut guard) = state.inner.lock() {
        if guard
            .as_ref()
            .map(|session| session.token == token)
            .unwrap_or(false)
        {
            *guard = None;
        }
    }
}

async fn run_connected(
    app: &AppHandle,
    state: &WsState,
    token: &str,
    target: &Target,
    receiver: &mut mpsc::UnboundedReceiver<String>,
    cancel: &CancellationToken,
) -> Outcome {
    let connect = tokio_tungstenite::connect_async(target.ws_url.as_str());
    let (mut socket, _response) =
        match tokio::time::timeout(Duration::from_secs(15), connect).await {
            Ok(Ok(pair)) => pair,
            Ok(Err(err)) => {
                return Outcome::Retry(format!("failed to connect to {}: {err}", target.ws_url));
            }
            Err(_) => {
                return Outcome::Retry(format!("timed out connecting to {}", target.ws_url));
            }
        };

    mark(app, state, token, "connected", None, Some(0));

    loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                let _ = socket.close(None).await;
                return Outcome::Cancelled;
            }
            outgoing = receiver.recv() => {
                match outgoing {
                    Some(frame) => {
                        if let Err(err) = socket.send(Message::Text(frame.into())).await {
                            return Outcome::Retry(format!("send failed: {err}"));
                        }
                    }
                    None => {
                        let _ = socket.close(None).await;
                        return Outcome::Cancelled;
                    }
                }
            }
            incoming = socket.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        match serde_json::from_str::<Value>(&text) {
                            Ok(frame) => {
                                let _ = app.emit(FRAME_EVENT, frame);
                            }
                            Err(err) => {
                                eprintln!("masondesk: ignored non-JSON frame: {err}");
                            }
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        let _ = socket.send(Message::Pong(payload)).await;
                    }
                    Some(Ok(Message::Close(frame))) => {
                        let code = frame.as_ref().map(|frame| u16::from(frame.code));
                        if code == Some(4401) {
                            return Outcome::Unauthorized;
                        }
                        if code == Some(4400) {
                            return Outcome::Fatal(
                                "the server rejected this protocol version (close 4400)".to_string(),
                            );
                        }
                        let detail = match frame {
                            Some(frame) => format!(
                                "server closed the connection: {} {}",
                                u16::from(frame.code),
                                frame.reason
                            ),
                            None => "server closed the connection".to_string(),
                        };
                        return Outcome::Retry(detail);
                    }
                    Some(Ok(_)) => {}
                    Some(Err(err)) => return Outcome::Retry(format!("websocket error: {err}")),
                    None => return Outcome::Retry("connection closed".to_string()),
                }
            }
        }
    }
}

/// Exponential backoff 1 s → 30 s with sub-second jitter. Returns false when cancelled.
async fn sleep_backoff(cancel: &CancellationToken, attempt: u32) -> bool {
    let seconds = 2f64.powi(attempt.saturating_sub(1) as i32).min(30.0);
    let jitter = {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.subsec_nanos())
            .unwrap_or(0);
        f64::from(nanos % 500) / 1000.0
    };
    let delay = Duration::from_secs_f64((seconds + jitter).max(0.5));
    tokio::select! {
        _ = cancel.cancelled() => false,
        _ = tokio::time::sleep(delay) => true,
    }
}

#[tauri::command]
pub fn connect(app: AppHandle, state: State<'_, WsState>, profile_id: String) -> Result<(), String> {
    start(app, &state, profile_id)
}

#[tauri::command]
pub fn disconnect(app: AppHandle, state: State<'_, WsState>) {
    stop(&state);
    let _ = app.emit(
        STATUS_EVENT,
        StatusPayload {
            state: "disconnected".to_string(),
            mode: None,
            detail: None,
            attempt: 0,
            profile_id: None,
        },
    );
}

#[tauri::command]
pub fn send(state: State<'_, WsState>, frame: String) -> Result<(), String> {
    let sender = match state.inner.lock() {
        Ok(guard) => guard.as_ref().map(|session| session.sender.clone()),
        Err(_) => None,
    };
    match sender {
        Some(sender) => sender
            .send(frame)
            .map_err(|_| "the connection is closed".to_string()),
        None => Err("not connected".to_string()),
    }
}

#[tauri::command]
pub fn connection_status(state: State<'_, WsState>) -> Option<StatusPayload> {
    match state.inner.lock() {
        Ok(guard) => guard.as_ref().map(|session| session.payload()),
        Err(_) => None,
    }
}

/// Called on app exit: cancel the session and let the task kill its tunnel.
pub fn shutdown(app: &AppHandle) {
    let state = app.state::<WsState>();
    stop(&state);
}
