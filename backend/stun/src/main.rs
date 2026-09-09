use std::{
    io::{self},
    net::SocketAddr,
};
use tokio::task::JoinSet;

use crate::network::{bind_worker, process};

mod network;
mod stun;

#[tokio::main]
async fn main() -> io::Result<()> {
    let addr = SocketAddr::from((std::net::Ipv6Addr::UNSPECIFIED, 3478));
    let workers = std::thread::available_parallelism()?.get();

    let mut tasks = JoinSet::new();
    for id in 0..workers {
        tasks.spawn(process(id, bind_worker(addr)?));
    }

    while let Some(result) = tasks.join_next().await {
        match result {
            Ok(Ok(())) => {}
            Ok(Err(err)) => eprintln!("STUN worker error: {err:?}"),
            Err(err) => eprintln!("STUN worker task failed: {err}"),
        }
    }
    Ok(())
}
