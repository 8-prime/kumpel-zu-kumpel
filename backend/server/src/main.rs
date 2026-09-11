use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use eyre::{Ok, eyre};

struct Session {
    send_peer_connected: bool,
    receive_peer_connected: bool,
}

impl Session {
    pub fn all_offline(&self) -> bool {
        return self.send_peer_connected && self.receive_peer_connected;
    }
}

struct SessionStore {
    sessions: Mutex<HashMap<String, Session>>,
}

impl SessionStore {
    pub fn set_receiver_online(&self, session_id: String) -> eyre::Result {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|err| eyre::eyre!("Session mutex poisoned: {err}"))?;

        let session = sessions.entry(session_id).or_insert_with(|| Session {
            receive_peer_connected: false,
            send_peer_connected: false,
        });

        session.receive_peer_connected = true;
        return Ok(());
    }

    pub fn set_sender_online(&self, session_id: String) -> eyre::Result {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|err| eyre::eyre!("Session mutex poisoned: {err}"))?;

        let session = sessions.entry(session_id).or_insert_with(|| Session {
            receive_peer_connected: false,
            send_peer_connected: false,
        });

        session.send_peer_connected = true;
        return Ok(());
    }

    pub fn set_sender_offline(&self, session_id: String) -> eyre::Result {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|err| eyre::eyre!("Session mutex poisoned: {err}"))?;

        let Some(session) = sessions.get_mut(&session_id) else {
            return Ok(());
        };

        session.send_peer_connected = false;
        if session.all_offline() {
            sessions.remove(&session_id);
        }

        return Ok(());
    }

    pub fn set_receiver_offline(&self, session_id: String) -> eyre::Result {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|err| eyre::eyre!("Session mutex poisoned: {err}"))?;

        let Some(session) = sessions.get_mut(&session_id) else {
            return Ok(());
        };

        session.receive_peer_connected = false;
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
