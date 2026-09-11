use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use axum::{
    Router,
    extract::{
        Path, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use eyre::eyre;
use serde::Deserialize;
use serde_json::json;
use tokio::sync::mpsc;
use tower_http::services::ServeDir;

#[derive(Clone)]
enum SessionSignal {
    StartStun {
        stun_server: String,
    },
    /// Opaque, client-encrypted WebRTC SDP containing the gathered ICE candidates.
    ReceivePeerInformation(Vec<u8>),
    PeerLeft,
}

impl SessionSignal {
    fn into_message(self) -> Message {
        let value = match self {
            Self::StartStun { stun_server } => {
                json!({"type": "start_stun", "stun_server": stun_server})
            }
            Self::ReceivePeerInformation(data) => {
                json!({"type": "receive_peer_information", "data": data})
            }
            Self::PeerLeft => json!({"type": "peer_left"}),
        };
        Message::Text(value.to_string().into())
    }
}

#[derive(Clone, Copy)]
enum Role {
    Sender,
    Receiver,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum ClientSignal {
    PeerInformation { data: Vec<u8> },
    Ready,
}

struct Session {
    send_peer_signals: Option<mpsc::Sender<SessionSignal>>,
    receive_peer_signals: Option<mpsc::Sender<SessionSignal>>,
}

impl Session {
    pub fn all_offline(&self) -> bool {
        return self.send_peer_signals.is_none() && self.receive_peer_signals.is_none();
    }
}

//TODO:  scc hasmap down the road https://docs.rs/scc/latest/scc/
struct SessionStore {
    sessions: Mutex<HashMap<String, Session>>,
    stun_server: String,
}

impl SessionStore {
    // The WebSocket handler owns the receiving end of this channel.
    pub fn set_receiver_online(
        &self,
        session_id: String,
        signals: mpsc::Sender<SessionSignal>,
    ) -> eyre::Result<()> {
        self.register(session_id, Role::Receiver, signals)
    }

    // The WebSocket handler owns the receiving end of this channel.
    pub fn set_sender_online(
        &self,
        session_id: String,
        signals: mpsc::Sender<SessionSignal>,
    ) -> eyre::Result<()> {
        self.register(session_id, Role::Sender, signals)
    }

    fn register(
        &self,
        session_id: String,
        role: Role,
        signals: mpsc::Sender<SessionSignal>,
    ) -> eyre::Result<()> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|err| eyre::eyre!("Session mutex poisoned: {err}"))?;

        let session = sessions.entry(session_id).or_insert_with(|| Session {
            receive_peer_signals: None,
            send_peer_signals: None,
        });

        let slot = match role {
            Role::Sender => &mut session.send_peer_signals,
            Role::Receiver => &mut session.receive_peer_signals,
        };
        if slot.is_some() {
            return Err(eyre!(
                "This role already has a connected peer. Close the other tab or create a new link."
            ));
        }
        *slot = Some(signals);

        if let (Some(sender), Some(receiver)) =
            (&session.send_peer_signals, &session.receive_peer_signals)
        {
            let signal = SessionSignal::StartStun {
                stun_server: self.stun_server.clone(),
            };
            // Registration is synchronous; never hold the map lock across an await.
            // Both new connections have capacity for this initial command.
            if sender.try_send(signal.clone()).is_err() || receiver.try_send(signal).is_err() {
                match role {
                    Role::Sender => session.send_peer_signals = None,
                    Role::Receiver => session.receive_peer_signals = None,
                }
                return Err(eyre!(
                    "Your peer is unavailable. Create a new link to retry."
                ));
            }
        }
        return Ok(());
    }

    pub async fn send_to_sender(
        &self,
        session_id: &str,
        signal: SessionSignal,
    ) -> eyre::Result<()> {
        let signals = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|err| eyre!("Session mutex poisoned: {err}"))?;

            sessions
                .get(session_id)
                .and_then(|session| session.send_peer_signals.clone())
                .ok_or_else(|| eyre!("Sender is offline for session {session_id}"))?
        };

        // Release the sessions lock before waiting for channel capacity.
        signals
            .send(signal)
            .await
            .map_err(|_| eyre!("Sender signal channel closed for session {session_id}"))
    }

    pub async fn send_to_receiver(
        &self,
        session_id: &str,
        signal: SessionSignal,
    ) -> eyre::Result<()> {
        let signals = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|err| eyre!("Session mutex poisoned: {err}"))?;

            sessions
                .get(session_id)
                .and_then(|session| session.receive_peer_signals.clone())
                .ok_or_else(|| eyre!("Receiver is offline for session {session_id}"))?
        };

        // Release the sessions lock before waiting for channel capacity.
        signals
            .send(signal)
            .await
            .map_err(|_| eyre!("Receiver signal channel closed for session {session_id}"))
    }

    pub fn set_sender_offline(
        &self,
        session_id: String,
        signals: &mpsc::Sender<SessionSignal>,
        ready: bool,
    ) -> eyre::Result<()> {
        self.remove_peer(session_id, Role::Sender, signals, ready)
    }

    pub fn set_receiver_offline(
        &self,
        session_id: String,
        signals: &mpsc::Sender<SessionSignal>,
        ready: bool,
    ) -> eyre::Result<()> {
        self.remove_peer(session_id, Role::Receiver, signals, ready)
    }

    fn remove_peer(
        &self,
        session_id: String,
        role: Role,
        signals: &mpsc::Sender<SessionSignal>,
        ready: bool,
    ) -> eyre::Result<()> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|err| eyre::eyre!("Session mutex poisoned: {err}"))?;

        let Some(session) = sessions.get_mut(&session_id) else {
            return Ok(());
        };

        let (slot, other) = match role {
            Role::Sender => (
                &mut session.send_peer_signals,
                &session.receive_peer_signals,
            ),
            Role::Receiver => (
                &mut session.receive_peer_signals,
                &session.send_peer_signals,
            ),
        };
        // A stale connection must not unregister a newer connection for the role.
        if !slot
            .as_ref()
            .is_some_and(|current| current.same_channel(signals))
        {
            return Ok(());
        }
        *slot = None;
        if !ready {
            if let Some(other) = other {
                let _ = other.try_send(SessionSignal::PeerLeft);
            }
        }
        if session.all_offline() {
            sessions.remove(&session_id);
        }

        return Ok(());
    }
}

// Peers join with a session ID and role. The encryption key never reaches this
// server. Once both join, instruct them to gather ICE candidates using STUN,
// relay their encrypted offer/answer, and release signaling when P2P is ready.

async fn handle_socket(
    mut socket: WebSocket,
    sessions: Arc<SessionStore>,
    session_id: String,
    role: Role,
) {
    let (signals, mut receiver) = mpsc::channel(32);
    let registration = match role {
        Role::Sender => sessions.set_sender_online(session_id.clone(), signals.clone()),
        Role::Receiver => sessions.set_receiver_online(session_id.clone(), signals.clone()),
    };
    if let Err(error) = registration {
        let _ = send_error(&mut socket, &error.to_string()).await;
        return;
    }

    let mut ready = false;
    loop {
        tokio::select! {
            signal = receiver.recv() => {
                let Some(signal) = signal else { break };
                if socket.send(signal.into_message()).await.is_err() { break; }
            }
            message = socket.recv() => {
                match message {
                    Some(Ok(Message::Text(text))) => {
                        match serde_json::from_str::<ClientSignal>(&text) {
                            Ok(ClientSignal::Ready) => ready = true,
                            Ok(ClientSignal::PeerInformation { data }) if !data.is_empty() && data.len() <= 64 * 1024 => {
                                let signal = SessionSignal::ReceivePeerInformation(data);
                                let relay = async {
                                    match role {
                                        Role::Sender => sessions.send_to_receiver(&session_id, signal).await,
                                        Role::Receiver => sessions.send_to_sender(&session_id, signal).await,
                                    }
                                };
                                match tokio::time::timeout(std::time::Duration::from_secs(5), relay).await {
                                    Ok(Ok(())) => {},
                                    _ => { let _ = send_error(&mut socket, "Your peer is unavailable. Create a new link to retry.").await; break; }
                                }
                            }
                            _ => { let _ = send_error(&mut socket, "Invalid signaling message.").await; break; }
                        }
                    }
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => {},
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(Message::Binary(_))) => {
                        let _ = send_error(&mut socket, "Expected a JSON signaling message.").await;
                        break;
                    }
                }
            }
        }
    }
    let cleanup = match role {
        Role::Sender => sessions.set_sender_offline(session_id, &signals, ready),
        Role::Receiver => sessions.set_receiver_offline(session_id, &signals, ready),
    };
    if let Err(error) = cleanup {
        eprintln!("Session cleanup failed: {error}");
    }
}

async fn send_error(socket: &mut WebSocket, message: &str) -> Result<(), axum::Error> {
    socket
        .send(Message::Text(
            json!({"type": "error", "message": message})
                .to_string()
                .into(),
        ))
        .await
}

async fn ws_handler(
    State(sessions): State<Arc<SessionStore>>,
    Path((session_id, role)): Path<(String, String)>,
    ws: WebSocketUpgrade,
) -> Response {
    let role = match role.as_str() {
        "sender" => Role::Sender,
        "receiver" => Role::Receiver,
        _ => return (StatusCode::BAD_REQUEST, "Role must be sender or receiver.").into_response(),
    };
    if session_id.is_empty()
        || session_id.len() > 128
        || !session_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return (StatusCode::BAD_REQUEST, "Invalid session ID.").into_response();
    }
    ws.max_message_size(512 * 1024)
        .max_frame_size(512 * 1024)
        .on_upgrade(move |socket| handle_socket(socket, sessions, session_id, role))
}

#[tokio::main]
async fn main() -> eyre::Result<()> {
    let sessions = Arc::new(SessionStore {
        sessions: Mutex::new(HashMap::new()),
        stun_server: std::env::var("STUN_SERVER")
            .unwrap_or_else(|_| "stun:127.0.0.1:3478".to_owned()),
    });

    let frontend_dir =
        std::env::var("FRONTEND_DIR").unwrap_or_else(|_| "../frontend/dist".to_owned());
    let app = Router::new()
        .route("/ws/{session_id}/{role}", get(ws_handler))
        .fallback_service(ServeDir::new(frontend_dir))
        .with_state(sessions);

    let address = std::env::var("SIGNAL_ADDR").unwrap_or_else(|_| "127.0.0.1:3000".to_owned());
    let listener = tokio::net::TcpListener::bind(&address).await?;
    println!("Signaling server listening on {address}");
    axum::serve(listener, app).await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> SessionStore {
        SessionStore {
            sessions: Mutex::new(HashMap::new()),
            stun_server: "stun:127.0.0.1:3478".to_owned(),
        }
    }

    #[test]
    fn starts_both_peers_only_when_the_pair_is_present_in_either_join_order() {
        for receiver_first in [false, true] {
            let store = store();
            let (sender, mut sender_rx) = mpsc::channel(4);
            let (receiver, mut receiver_rx) = mpsc::channel(4);
            if receiver_first {
                store
                    .set_receiver_online("test".into(), receiver.clone())
                    .unwrap();
                assert!(receiver_rx.try_recv().is_err());
                store
                    .set_sender_online("test".into(), sender.clone())
                    .unwrap();
            } else {
                store
                    .set_sender_online("test".into(), sender.clone())
                    .unwrap();
                assert!(sender_rx.try_recv().is_err());
                store
                    .set_receiver_online("test".into(), receiver.clone())
                    .unwrap();
            }
            for signal in [
                sender_rx.try_recv().unwrap(),
                receiver_rx.try_recv().unwrap(),
            ] {
                assert!(
                    matches!(signal, SessionSignal::StartStun { stun_server } if stun_server == "stun:127.0.0.1:3478")
                );
            }
            store
                .set_sender_offline("test".into(), &sender, true)
                .unwrap();
            assert!(receiver_rx.try_recv().is_err());
            store
                .set_receiver_offline("test".into(), &receiver, true)
                .unwrap();
            assert!(store.sessions.lock().unwrap().is_empty());
        }
    }

    #[tokio::test]
    async fn relays_opaque_bytes_both_ways_and_notifies_an_unexpected_disconnect() {
        let store = store();
        let (sender, mut sender_rx) = mpsc::channel(4);
        let (receiver, mut receiver_rx) = mpsc::channel(4);
        store
            .set_sender_online("test".into(), sender.clone())
            .unwrap();
        store
            .set_receiver_online("test".into(), receiver.clone())
            .unwrap();
        sender_rx.try_recv().unwrap();
        receiver_rx.try_recv().unwrap();
        store
            .send_to_receiver(
                "test",
                SessionSignal::ReceivePeerInformation(vec![0, 128, 255]),
            )
            .await
            .unwrap();
        store
            .send_to_sender("test", SessionSignal::ReceivePeerInformation(vec![1, 2]))
            .await
            .unwrap();
        assert!(
            matches!(receiver_rx.recv().await.unwrap(), SessionSignal::ReceivePeerInformation(data) if data == [0, 128, 255])
        );
        assert!(
            matches!(sender_rx.recv().await.unwrap(), SessionSignal::ReceivePeerInformation(data) if data == [1, 2])
        );
        store
            .set_receiver_offline("test".into(), &receiver, false)
            .unwrap();
        assert!(matches!(
            sender_rx.recv().await.unwrap(),
            SessionSignal::PeerLeft
        ));
        store
            .set_sender_offline("test".into(), &sender, false)
            .unwrap();
        assert!(store.sessions.lock().unwrap().is_empty());
    }

    #[test]
    fn duplicate_role_cannot_replace_or_remove_the_registered_peer() {
        let store = store();
        let (original, _original_rx) = mpsc::channel(4);
        let (duplicate, _duplicate_rx) = mpsc::channel(4);
        store
            .set_sender_online("test".into(), original.clone())
            .unwrap();
        assert!(
            store
                .set_sender_online("test".into(), duplicate.clone())
                .is_err()
        );
        store
            .set_sender_offline("test".into(), &duplicate, false)
            .unwrap();
        assert!(
            store.sessions.lock().unwrap()["test"]
                .send_peer_signals
                .as_ref()
                .unwrap()
                .same_channel(&original)
        );
    }
}
