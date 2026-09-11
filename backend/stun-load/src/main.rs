use std::{
    collections::{HashMap, VecDeque},
    env,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use tokio::{
    net::UdpSocket,
    task::JoinSet,
    time::{Instant, sleep_until},
};

const BINDING_REQUEST: u16 = 0x0001;
const BINDING_SUCCESS_RESPONSE: u16 = 0x0101;
const MAGIC_COOKIE: u32 = 0x2112_A442;
const XOR_MAPPED_ADDRESS: u16 = 0x0020;
const STUN_HEADER_LENGTH: usize = 20;
const MAX_PACKET_LENGTH: usize = 1500;
const STARTUP_LEAD_TIME: Duration = Duration::from_secs(1);

#[derive(Clone, Copy)]
struct Config {
    target: SocketAddr,
    clients: usize,
    rate: u64,
    duration: Duration,
    timeout: Duration,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            target: SocketAddr::from(([127, 0, 0, 1], 3478)),
            clients: 100,
            rate: 1_000,
            duration: Duration::from_secs(10),
            timeout: Duration::from_secs(1),
        }
    }
}

impl Config {
    fn parse() -> Result<Option<Self>, String> {
        let mut config = Self::default();
        let mut args = env::args().skip(1);

        while let Some(argument) = args.next() {
            match argument.as_str() {
                "--target" => {
                    config.target = next_value(&mut args, "--target")?
                        .parse()
                        .map_err(|_| "--target must be an IP socket address such as 127.0.0.1:3478 or [::1]:3478".to_owned())?;
                }
                "--clients" => {
                    config.clients =
                        parse_positive(&next_value(&mut args, "--clients")?, "--clients")?;
                }
                "--rate" => {
                    config.rate = parse_positive(&next_value(&mut args, "--rate")?, "--rate")?;
                }
                "--duration" => {
                    config.duration =
                        parse_seconds(&next_value(&mut args, "--duration")?, "--duration")?;
                }
                "--timeout-ms" => {
                    let milliseconds: u64 =
                        parse_positive(&next_value(&mut args, "--timeout-ms")?, "--timeout-ms")?;
                    config.timeout = Duration::from_millis(milliseconds);
                }
                "-h" | "--help" => return Ok(None),
                _ => return Err(format!("unknown argument: {argument}")),
            }
        }

        if config.clients > u32::MAX as usize {
            return Err("--clients is too large".to_owned());
        }
        if config.rate > 1_000_000_000 {
            return Err("--rate cannot exceed 1,000,000,000 requests per second".to_owned());
        }

        Ok(Some(config))
    }
}

fn next_value(args: &mut impl Iterator<Item = String>, option: &str) -> Result<String, String> {
    args.next()
        .ok_or_else(|| format!("missing value for {option}"))
}

fn parse_positive<T>(value: &str, option: &str) -> Result<T, String>
where
    T: std::str::FromStr + PartialEq + Default,
{
    let parsed = value
        .parse::<T>()
        .map_err(|_| format!("invalid value for {option}: {value}"))?;
    if parsed == T::default() {
        return Err(format!("{option} must be greater than zero"));
    }
    Ok(parsed)
}

fn parse_seconds(value: &str, option: &str) -> Result<Duration, String> {
    let seconds = value
        .parse::<f64>()
        .map_err(|_| format!("invalid value for {option}: {value}"))?;
    if !seconds.is_finite() || seconds <= 0.0 {
        return Err(format!(
            "{option} must be a finite number greater than zero"
        ));
    }
    Ok(Duration::from_secs_f64(seconds))
}

fn print_help() {
    println!(
        "stun-load - protocol-aware STUN Binding load generator\n\
\n\
Usage:\n\
  cargo run --release -p stun-load -- [options]\n\
\n\
Options:\n\
  --target <IP:PORT>  Server address (default: 127.0.0.1:3478)\n\
  --clients <COUNT>   Number of UDP client sockets (default: 100)\n\
  --rate <RPS>        Total target request rate (default: 1000)\n\
  --duration <SECS>   Sending duration, decimals allowed (default: 10)\n\
  --timeout-ms <MS>   Per-request response timeout (default: 1000)\n\
  -h, --help          Show this help\n\
\n\
Examples:\n\
  stun-load --target 127.0.0.1:3478 --clients 100 --rate 5000 --duration 30\n\
  stun-load --target [::1]:3478 --clients 100 --rate 5000 --duration 30"
    );
}

#[derive(Default)]
struct Counters {
    sent: AtomicU64,
    received: AtomicU64,
    valid: AtomicU64,
    timed_out: AtomicU64,
    invalid: AtomicU64,
    io_errors: AtomicU64,
}

#[derive(Clone, Copy)]
struct CounterSnapshot {
    sent: u64,
    received: u64,
    valid: u64,
    timed_out: u64,
    invalid: u64,
    io_errors: u64,
}

impl Counters {
    fn snapshot(&self) -> CounterSnapshot {
        CounterSnapshot {
            sent: self.sent.load(Ordering::Relaxed),
            received: self.received.load(Ordering::Relaxed),
            valid: self.valid.load(Ordering::Relaxed),
            timed_out: self.timed_out.load(Ordering::Relaxed),
            invalid: self.invalid.load(Ordering::Relaxed),
            io_errors: self.io_errors.load(Ordering::Relaxed),
        }
    }
}

#[derive(Default)]
struct WorkerReport {
    valid_latencies_micros: Vec<u64>,
    error_samples: Vec<String>,
}

#[tokio::main]
async fn main() -> eyre::Result<()> {
    let config = match Config::parse() {
        Ok(Some(config)) => config,
        Ok(None) => {
            print_help();
            return Ok(());
        }
        Err(error) => {
            eprintln!("error: {error}\n");
            print_help();
            std::process::exit(2);
        }
    };

    let bind_address = match config.target {
        SocketAddr::V4(_) => SocketAddr::from(([0, 0, 0, 0], 0)),
        SocketAddr::V6(_) => SocketAddr::from(([0u16; 8], 0)),
    };

    println!(
        "Preparing {} clients for {} at {} req/s for {:.3}s (timeout {} ms)",
        config.clients,
        config.target,
        config.rate,
        config.duration.as_secs_f64(),
        config.timeout.as_millis()
    );

    let mut sockets = Vec::with_capacity(config.clients);
    for _ in 0..config.clients {
        let socket = UdpSocket::bind(bind_address).await?;
        socket.connect(config.target).await?;
        sockets.push(socket);
    }

    let period = client_period(config.clients, config.rate)?;
    let counters = Arc::new(Counters::default());
    let start = Instant::now() + STARTUP_LEAD_TIME;
    let mut workers = JoinSet::new();

    for (client_id, socket) in sockets.into_iter().enumerate() {
        let counters = Arc::clone(&counters);
        let offset = client_offset(client_id, config.rate)?;
        workers.spawn(run_client(
            client_id as u32,
            socket,
            start + offset,
            start + config.duration,
            period,
            config.timeout,
            counters,
        ));
    }

    let mut progress = tokio::time::interval(Duration::from_secs(1));
    progress.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    progress.tick().await;

    let mut reports = Vec::with_capacity(config.clients);
    while !workers.is_empty() {
        tokio::select! {
            result = workers.join_next() => {
                if let Some(result) = result {
                    reports.push(result?);
                }
            }
            _ = progress.tick() => {
                let snapshot = counters.snapshot();
                println!(
                    "progress: sent={} valid={} timeout={} invalid={} io-errors={}",
                    snapshot.sent,
                    snapshot.valid,
                    snapshot.timed_out,
                    snapshot.invalid,
                    snapshot.io_errors,
                );
            }
        }
    }

    let snapshot = counters.snapshot();
    let mut latencies: Vec<u64> = reports
        .iter_mut()
        .flat_map(|report| std::mem::take(&mut report.valid_latencies_micros))
        .collect();
    latencies.sort_unstable();

    let error_samples: Vec<String> = reports
        .into_iter()
        .flat_map(|report| report.error_samples)
        .take(10)
        .collect();

    print_summary(config, snapshot, &latencies, &error_samples);
    Ok(())
}

fn client_period(clients: usize, rate: u64) -> eyre::Result<Duration> {
    let nanoseconds = 1_000_000_000u128
        .checked_mul(clients as u128)
        .ok_or_else(|| eyre::eyre!("client period overflow"))?
        / rate as u128;
    let nanoseconds =
        u64::try_from(nanoseconds).map_err(|_| eyre::eyre!("client period is too large"))?;
    if nanoseconds == 0 {
        eyre::bail!("requested rate is too high for the selected client count");
    }
    Ok(Duration::from_nanos(nanoseconds))
}

fn client_offset(client_id: usize, rate: u64) -> eyre::Result<Duration> {
    let nanoseconds = 1_000_000_000u128
        .checked_mul(client_id as u128)
        .ok_or_else(|| eyre::eyre!("client offset overflow"))?
        / rate as u128;
    let nanoseconds =
        u64::try_from(nanoseconds).map_err(|_| eyre::eyre!("client offset is too large"))?;
    Ok(Duration::from_nanos(nanoseconds))
}

async fn run_client(
    client_id: u32,
    socket: UdpSocket,
    first_send: Instant,
    deadline: Instant,
    period: Duration,
    timeout: Duration,
    counters: Arc<Counters>,
) -> WorkerReport {
    let drain_deadline = deadline + timeout;
    let mut next_send = first_send;
    let mut sequence = 0u64;
    let mut pending = HashMap::<[u8; 12], Instant>::new();
    let mut expirations = VecDeque::<([u8; 12], Instant)>::new();
    let mut response = [0u8; MAX_PACKET_LENGTH];
    let mut report = WorkerReport::default();

    loop {
        let now = Instant::now();

        while expirations
            .front()
            .is_some_and(|(_, expires_at)| *expires_at <= now)
        {
            let (transaction_id, _) = expirations.pop_front().expect("front was present");
            if pending.remove(&transaction_id).is_some() {
                counters.timed_out.fetch_add(1, Ordering::Relaxed);
            }
        }

        if next_send < deadline && next_send <= now {
            let transaction_id = make_transaction_id(client_id, sequence);
            sequence = sequence.wrapping_add(1);
            let request = make_binding_request(transaction_id);
            let sent_at = Instant::now();

            match socket.send(&request).await {
                Ok(bytes_sent) if bytes_sent == request.len() => {
                    counters.sent.fetch_add(1, Ordering::Relaxed);
                    pending.insert(transaction_id, sent_at);
                    expirations.push_back((transaction_id, sent_at + timeout));
                }
                Ok(bytes_sent) => {
                    counters.io_errors.fetch_add(1, Ordering::Relaxed);
                    record_sample(
                        &mut report,
                        format!(
                            "client {client_id}: sent {bytes_sent} of {} request bytes",
                            request.len()
                        ),
                    );
                }
                Err(error) => {
                    counters.io_errors.fetch_add(1, Ordering::Relaxed);
                    record_sample(
                        &mut report,
                        format!("client {client_id}: send failed: {error}"),
                    );
                }
            }

            next_send += period;
            let after_send = Instant::now();
            if next_send < after_send {
                next_send = after_send + period;
            }
            continue;
        }

        let has_future_send = next_send < deadline;
        if !has_future_send && pending.is_empty() {
            break;
        }
        if now >= drain_deadline {
            let outstanding = pending.len() as u64;
            counters.timed_out.fetch_add(outstanding, Ordering::Relaxed);
            break;
        }

        let mut wake_at = drain_deadline;
        if has_future_send {
            wake_at = wake_at.min(next_send);
        }
        if let Some((_, expires_at)) = expirations.front() {
            wake_at = wake_at.min(*expires_at);
        }

        tokio::select! {
            received = socket.recv(&mut response) => {
                match received {
                    Ok(length) => {
                        counters.received.fetch_add(1, Ordering::Relaxed);
                        process_response(
                            client_id,
                            &response[..length],
                            &mut pending,
                            &counters,
                            &mut report,
                        );
                    }
                    Err(error) => {
                        counters.io_errors.fetch_add(1, Ordering::Relaxed);
                        record_sample(
                            &mut report,
                            format!("client {client_id}: receive failed: {error}"),
                        );
                    }
                }
            }
            _ = sleep_until(wake_at) => {}
        }
    }

    report
}

fn process_response(
    client_id: u32,
    response: &[u8],
    pending: &mut HashMap<[u8; 12], Instant>,
    counters: &Counters,
    report: &mut WorkerReport,
) {
    if response.len() < STUN_HEADER_LENGTH {
        counters.invalid.fetch_add(1, Ordering::Relaxed);
        record_sample(
            report,
            format!(
                "client {client_id}: response is only {} bytes",
                response.len()
            ),
        );
        return;
    }

    let mut transaction_id = [0u8; 12];
    transaction_id.copy_from_slice(&response[8..20]);
    let Some(sent_at) = pending.remove(&transaction_id) else {
        counters.invalid.fetch_add(1, Ordering::Relaxed);
        record_sample(
            report,
            format!("client {client_id}: response has an unknown or duplicate transaction ID"),
        );
        return;
    };

    match validate_binding_response(response, transaction_id) {
        Ok(()) => {
            counters.valid.fetch_add(1, Ordering::Relaxed);
            let micros = sent_at.elapsed().as_micros().min(u64::MAX as u128) as u64;
            report.valid_latencies_micros.push(micros);
        }
        Err(error) => {
            counters.invalid.fetch_add(1, Ordering::Relaxed);
            record_sample(report, format!("client {client_id}: {error}"));
        }
    }
}

fn validate_binding_response(response: &[u8], transaction_id: [u8; 12]) -> Result<(), String> {
    let message_type = read_u16(&response[0..2]);
    if message_type != BINDING_SUCCESS_RESPONSE {
        return Err(format!(
            "expected Binding success type 0x{BINDING_SUCCESS_RESPONSE:04X}, got 0x{message_type:04X}"
        ));
    }

    let message_length = read_u16(&response[2..4]) as usize;
    if !message_length.is_multiple_of(4) {
        return Err(format!(
            "message length {message_length} is not a multiple of four"
        ));
    }
    if STUN_HEADER_LENGTH + message_length != response.len() {
        return Err(format!(
            "header declares {} bytes, datagram contains {}",
            STUN_HEADER_LENGTH + message_length,
            response.len()
        ));
    }

    let magic_cookie = u32::from_be_bytes(response[4..8].try_into().expect("four-byte slice"));
    if magic_cookie != MAGIC_COOKIE {
        return Err(format!("invalid magic cookie 0x{magic_cookie:08X}"));
    }
    if response[8..20] != transaction_id {
        return Err("transaction ID was not echoed".to_owned());
    }

    let mut offset = STUN_HEADER_LENGTH;
    let mut mapped_endpoint = None;
    while offset < response.len() {
        if offset + 4 > response.len() {
            return Err("truncated attribute header".to_owned());
        }

        let attribute_type = read_u16(&response[offset..offset + 2]);
        let value_length = read_u16(&response[offset + 2..offset + 4]) as usize;
        let value_start = offset + 4;
        let value_end = value_start
            .checked_add(value_length)
            .ok_or_else(|| "attribute length overflow".to_owned())?;
        if value_end > response.len() {
            return Err(format!(
                "attribute 0x{attribute_type:04X} extends past the datagram"
            ));
        }

        if attribute_type == XOR_MAPPED_ADDRESS && mapped_endpoint.is_none() {
            mapped_endpoint = Some(decode_xor_mapped_address(
                &response[value_start..value_end],
                transaction_id,
            )?);
        }

        let padding = (4 - value_length % 4) % 4;
        offset = value_end
            .checked_add(padding)
            .ok_or_else(|| "attribute padding overflow".to_owned())?;
        if offset > response.len() {
            return Err("attribute padding extends past the datagram".to_owned());
        }
    }

    mapped_endpoint.ok_or_else(|| "response has no XOR-MAPPED-ADDRESS".to_owned())?;

    Ok(())
}

fn decode_xor_mapped_address(value: &[u8], transaction_id: [u8; 12]) -> Result<SocketAddr, String> {
    if value.len() < 4 {
        return Err("XOR-MAPPED-ADDRESS is shorter than four bytes".to_owned());
    }
    if value[0] != 0 {
        return Err("XOR-MAPPED-ADDRESS reserved byte is nonzero".to_owned());
    }

    let port = read_u16(&value[2..4]) ^ (MAGIC_COOKIE >> 16) as u16;
    let cookie_bytes = MAGIC_COOKIE.to_be_bytes();

    let ip = match value[1] {
        0x01 => {
            if value.len() != 8 {
                return Err(format!(
                    "IPv4 XOR-MAPPED-ADDRESS has {} value bytes instead of 8",
                    value.len()
                ));
            }
            let mut octets = [0u8; 4];
            for index in 0..4 {
                octets[index] = value[4 + index] ^ cookie_bytes[index];
            }
            IpAddr::V4(Ipv4Addr::from(octets))
        }
        0x02 => {
            if value.len() != 20 {
                return Err(format!(
                    "IPv6 XOR-MAPPED-ADDRESS has {} value bytes instead of 20",
                    value.len()
                ));
            }
            let mut mask = [0u8; 16];
            mask[..4].copy_from_slice(&cookie_bytes);
            mask[4..].copy_from_slice(&transaction_id);
            let mut octets = [0u8; 16];
            for index in 0..16 {
                octets[index] = value[4 + index] ^ mask[index];
            }
            IpAddr::V6(Ipv6Addr::from(octets))
        }
        family => return Err(format!("unknown XOR-MAPPED-ADDRESS family 0x{family:02X}")),
    };

    Ok(SocketAddr::new(ip, port))
}

fn make_transaction_id(client_id: u32, sequence: u64) -> [u8; 12] {
    let mut transaction_id = [0u8; 12];
    transaction_id[..4].copy_from_slice(&client_id.to_be_bytes());
    transaction_id[4..].copy_from_slice(&sequence.to_be_bytes());
    transaction_id
}

fn make_binding_request(transaction_id: [u8; 12]) -> [u8; STUN_HEADER_LENGTH] {
    let mut request = [0u8; STUN_HEADER_LENGTH];
    request[0..2].copy_from_slice(&BINDING_REQUEST.to_be_bytes());
    request[2..4].copy_from_slice(&0u16.to_be_bytes());
    request[4..8].copy_from_slice(&MAGIC_COOKIE.to_be_bytes());
    request[8..20].copy_from_slice(&transaction_id);
    request
}

fn read_u16(bytes: &[u8]) -> u16 {
    u16::from_be_bytes(bytes.try_into().expect("two-byte slice"))
}

fn record_sample(report: &mut WorkerReport, error: String) {
    if report.error_samples.len() < 3 {
        report.error_samples.push(error);
    }
}

fn print_summary(
    config: Config,
    snapshot: CounterSnapshot,
    latencies: &[u64],
    error_samples: &[String],
) {
    let requested_seconds = config.duration.as_secs_f64();
    let offered_rate = snapshot.sent as f64 / requested_seconds;
    let valid_rate = snapshot.valid as f64 / requested_seconds;
    let success_percentage = percentage(snapshot.valid, snapshot.sent);
    let timeout_percentage = percentage(snapshot.timed_out, snapshot.sent);

    println!("\nSummary");
    println!("  target:          {}", config.target);
    println!("  clients:         {}", config.clients);
    println!("  target rate:     {} req/s", config.rate);
    println!("  offered rate:    {offered_rate:.1} req/s");
    println!("  valid rate:      {valid_rate:.1} resp/s");
    println!("  sent:            {}", snapshot.sent);
    println!("  received:        {}", snapshot.received);
    println!(
        "  valid:           {} ({success_percentage:.2}%)",
        snapshot.valid
    );
    println!(
        "  timed out:       {} ({timeout_percentage:.2}%)",
        snapshot.timed_out
    );
    println!("  invalid:         {}", snapshot.invalid);
    println!("  I/O errors:      {}", snapshot.io_errors);

    if latencies.is_empty() {
        println!("  latency:         no valid responses");
    } else {
        println!(
            "  latency p50:     {}",
            format_latency(percentile(latencies, 0.50))
        );
        println!(
            "  latency p95:     {}",
            format_latency(percentile(latencies, 0.95))
        );
        println!(
            "  latency p99:     {}",
            format_latency(percentile(latencies, 0.99))
        );
        println!(
            "  latency max:     {}",
            format_latency(*latencies.last().expect("not empty"))
        );
    }

    if !error_samples.is_empty() {
        println!("\nSample errors:");
        for error in error_samples {
            println!("  - {error}");
        }
    }
}

fn percentage(value: u64, total: u64) -> f64 {
    if total == 0 {
        0.0
    } else {
        value as f64 * 100.0 / total as f64
    }
}

fn percentile(sorted_values: &[u64], quantile: f64) -> u64 {
    let index = ((sorted_values.len() as f64 * quantile).ceil() as usize)
        .saturating_sub(1)
        .min(sorted_values.len() - 1);
    sorted_values[index]
}

fn format_latency(micros: u64) -> String {
    if micros < 1_000 {
        format!("{micros} us")
    } else {
        format!("{:.3} ms", micros as f64 / 1_000.0)
    }
}
