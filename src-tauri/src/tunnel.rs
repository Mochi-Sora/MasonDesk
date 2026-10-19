use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::net::TcpStream;
use tokio::process::{Child, Command};

use crate::config::Profile;

/// Everything needed to run the tunnel half of an SSH connection.
#[derive(Debug, Clone)]
pub struct SshSpec {
    pub host: String,
    pub port: Option<u16>,
    pub remote_port: u16,
}

impl SshSpec {
    pub fn from_profile(profile: &Profile) -> Result<Self, String> {
        let host = profile
            .ssh_host
            .clone()
            .unwrap_or_default()
            .trim()
            .to_string();
        if host.is_empty() {
            return Err(
                "SSH profile is missing a host (use user@host or an ssh_config alias)".to_string(),
            );
        }
        // `host` is passed to ssh as a single argv entry — never through a shell — so
        // ~/.ssh/config aliases, ports and ProxyJump keep working without injection risk.
        Ok(Self {
            host,
            port: profile.ssh_port,
            remote_port: profile.ssh_remote_port.unwrap_or(18790),
        })
    }
}

/// A supervised `ssh -N -L` tunnel. Killed on drop as a last resort.
pub struct TunnelHandle {
    child: Child,
    pub local_port: u16,
}

impl TunnelHandle {
    pub async fn spawn(spec: &SshSpec) -> Result<Self, String> {
        let local_port = pick_free_port()?;
        let mut command = Command::new("ssh");
        command.arg("-N").arg("-T");
        // Never prompt for or store passwords; key / ssh-agent auth only.
        command.args(["-o", "BatchMode=yes"]);
        // Fail fast when the forward cannot be established.
        command.args(["-o", "ExitOnForwardFailure=yes"]);
        command.args(["-o", "ServerAliveInterval=15"]);
        command.args(["-o", "ServerAliveCountMax=3"]);
        command.args(["-o", "StrictHostKeyChecking=accept-new"]);
        if let Some(port) = spec.port {
            command.arg("-p");
            command.arg(port.to_string());
        }
        command.arg("-L");
        command.arg(format!(
            "127.0.0.1:{local_port}:127.0.0.1:{}",
            spec.remote_port
        ));
        command.arg(&spec.host);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        command.kill_on_drop(true);
        let child = command
            .spawn()
            .map_err(|err| format!("failed to start ssh: {err}"))?;
        Ok(Self { child, local_port })
    }

    /// True when the ssh process is alive and the forwarded port answers.
    pub async fn healthy(&mut self) -> bool {
        match self.child.try_wait() {
            Ok(Some(_)) => return false,
            Ok(None) => {}
            Err(_) => return false,
        }
        TcpStream::connect(("127.0.0.1", self.local_port))
            .await
            .is_ok()
    }

    pub async fn wait_ready(&mut self, timeout: Duration) -> Result<(), String> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            match self.child.try_wait() {
                Ok(Some(status)) => {
                    let mut stderr = String::new();
                    if let Some(mut pipe) = self.child.stderr.take() {
                        let _ = pipe.read_to_string(&mut stderr).await;
                    }
                    let detail = if stderr.trim().is_empty() {
                        format!("ssh exited with {status}")
                    } else {
                        format!("ssh exited with {status}: {}", stderr.trim())
                    };
                    return Err(format!("the SSH tunnel could not be established ({detail})"));
                }
                Ok(None) => {}
                Err(err) => return Err(format!("failed to poll the ssh process: {err}")),
            }
            if TcpStream::connect(("127.0.0.1", self.local_port))
                .await
                .is_ok()
            {
                return Ok(());
            }
            if tokio::time::Instant::now() >= deadline {
                return Err("timed out waiting for the SSH tunnel to become reachable".to_string());
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }

    pub async fn kill(mut self) {
        let _ = self.child.kill().await;
        let _ = self.child.wait().await;
    }
}

fn pick_free_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|err| format!("could not allocate a local port: {err}"))?;
    let port = listener
        .local_addr()
        .map_err(|err| err.to_string())?
        .port();
    drop(listener);
    Ok(port)
}
