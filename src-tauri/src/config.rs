use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Local,
    Ssh,
    Ip,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Local => "local",
            Mode::Ssh => "ssh",
            Mode::Ip => "ip",
        }
    }
}

/// A persisted connection profile. See docs/connections.md.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub mode: Mode,
    #[serde(default)]
    pub ssh_host: Option<String>,
    #[serde(default)]
    pub ssh_port: Option<u16>,
    #[serde(default)]
    pub ssh_remote_port: Option<u16>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub auto_connect: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfilesState {
    #[serde(default)]
    pub profiles: Vec<Profile>,
    #[serde(default)]
    pub active_id: Option<String>,
}

fn profiles_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|err| format!("cannot resolve the app config directory: {err}"))?;
    fs::create_dir_all(&dir).map_err(|err| format!("cannot create {}: {err}", dir.display()))?;
    Ok(dir.join("profiles.json"))
}

pub fn load(app: &AppHandle) -> ProfilesState {
    let Ok(path) = profiles_path(app) else {
        return ProfilesState::default();
    };
    let Ok(text) = fs::read_to_string(&path) else {
        return ProfilesState::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

fn save(app: &AppHandle, state: &ProfilesState) -> Result<(), String> {
    let path = profiles_path(app)?;
    let text = serde_json::to_string_pretty(state).map_err(|err| err.to_string())?;
    fs::write(&path, text).map_err(|err| format!("cannot write {}: {err}", path.display()))
}

pub fn find(app: &AppHandle, id: &str) -> Option<Profile> {
    load(app).profiles.into_iter().find(|profile| profile.id == id)
}

#[tauri::command]
pub fn list_profiles(app: AppHandle) -> ProfilesState {
    load(&app)
}

#[tauri::command]
pub fn upsert_profile(app: AppHandle, profile: Profile) -> Result<ProfilesState, String> {
    let mut state = load(&app);
    match state
        .profiles
        .iter_mut()
        .find(|existing| existing.id == profile.id)
    {
        Some(existing) => *existing = profile,
        None => {
            if state.active_id.is_none() {
                state.active_id = Some(profile.id.clone());
            }
            state.profiles.push(profile);
        }
    }
    save(&app, &state)?;
    Ok(state)
}

#[tauri::command]
pub fn delete_profile(app: AppHandle, id: String) -> Result<ProfilesState, String> {
    let mut state = load(&app);
    state.profiles.retain(|profile| profile.id != id);
    if state.active_id.as_deref() == Some(id.as_str()) {
        state.active_id = state.profiles.first().map(|profile| profile.id.clone());
    }
    save(&app, &state)?;
    Ok(state)
}

#[tauri::command]
pub fn set_active_profile(app: AppHandle, id: Option<String>) -> Result<ProfilesState, String> {
    let mut state = load(&app);
    state.active_id = id;
    save(&app, &state)?;
    Ok(state)
}

#[tauri::command]
pub fn set_device_token(
    app: AppHandle,
    profile_id: String,
    token: Option<String>,
) -> Result<ProfilesState, String> {
    let mut state = load(&app);
    let Some(profile) = state
        .profiles
        .iter_mut()
        .find(|profile| profile.id == profile_id)
    else {
        return Err(format!("unknown profile: {profile_id}"));
    };
    profile.token = token;
    save(&app, &state)?;
    Ok(state)
}
