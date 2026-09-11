use std::{collections::HashMap, sync::Mutex};

use eyre::eyre;
use tokio::sync::mpsc;

enum SessionSignal {
    StartStun,
    /// The raw response returned by the other peer's STUN request.
    ReceivePeerInformation(Vec<u8>),
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

struct SessionStore {
    sessions: Mutex<HashMap<String, Session>>,
}

impl SessionStore {
    // The WebSocket handler owns the receiving end of this channel.
    pub fn set_receiver_online(
        &self,
        session_id: String,
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

        session.receive_peer_signals = Some(signals);
        return Ok(());
    }

    // The WebSocket handler owns the receiving end of this channel.
    pub fn set_sender_online(
        &self,
        session_id: String,
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

        session.send_peer_signals = Some(signals);
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

    pub fn set_sender_offline(&self, session_id: String) -> eyre::Result<()> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|err| eyre::eyre!("Session mutex poisoned: {err}"))?;

        let Some(session) = sessions.get_mut(&session_id) else {
            return Ok(());
        };

        session.send_peer_signals = None;
        if session.all_offline() {
            sessions.remove(&session_id);
        }

        return Ok(());
    }

    pub fn set_receiver_offline(&self, session_id: String) -> eyre::Result<()> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|err| eyre::eyre!("Session mutex poisoned: {err}"))?;

        let Some(session) = sessions.get_mut(&session_id) else {
            return Ok(());
        };

        session.receive_peer_signals = None;
        if session.all_offline() {
            sessions.remove(&session_id);
        }

        return Ok(());
    }
}

// peer a connects to relay server and opens session with key
// peer b connects to relay server and opens session with key from peer a
// when both peers conncted, notiy peer a and b to run stun command.
// peer a and b relay stun infomration though this server ot each other
// peer a and b, using relayed stun information, open p2p connection.
// peer a closes session with server on successful p2p creation
// peer b closes session with server on successfl p2p creation
// when all peers are disconnected, discard session
//
//
// offer websocket connection to allow for passing relevant info between peer and server

fn main() {
    println!("Hello, world!");
}
