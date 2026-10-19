mod config;
mod transport;
mod tunnel;
mod ws;

use tauri::{Manager, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ws::WsState::default())
        .invoke_handler(tauri::generate_handler![
            config::list_profiles,
            config::upsert_profile,
            config::delete_profile,
            config::set_active_profile,
            config::set_device_token,
            ws::connect,
            ws::disconnect,
            ws::send,
            ws::connection_status,
            transport::local_gateway_status,
            transport::gateway_cli,
        ])
        .setup(|app| {
            // Auto-connect the active profile when the user opted in.
            let profiles = config::load(app.handle());
            let active = profiles
                .active_id
                .as_ref()
                .and_then(|id| profiles.profiles.iter().find(|profile| &profile.id == id));
            if let Some(profile) = active {
                if profile.auto_connect.unwrap_or(false) {
                    let state = app.state::<ws::WsState>();
                    if let Err(err) = ws::start(app.handle().clone(), &state, profile.id.clone()) {
                        eprintln!("masondesk: auto-connect failed: {err}");
                    }
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the MasonDesk application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                ws::shutdown(app);
            }
        });
}
