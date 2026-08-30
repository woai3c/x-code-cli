use std::ffi::c_void;
use std::fmt;
use std::future::Future;
use std::io;
use std::os::windows::io::AsRawHandle;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::windows::named_pipe::{
    ClientOptions, NamedPipeClient, NamedPipeServer, ServerOptions,
};
use tokio::runtime::Builder;
use tokio::time::{sleep, timeout};
use windows_sys::Win32::Foundation::{
    ERROR_FILE_NOT_FOUND, ERROR_NO_DATA, ERROR_PIPE_BUSY, ERROR_PIPE_NOT_CONNECTED, HANDLE,
};
use windows_sys::Win32::Storage::FileSystem::SECURITY_IDENTIFICATION;

use crate::process_peer::{
    ClientVerificationError, verify_named_pipe_client, verify_named_pipe_server,
};
use crate::protocol::{
    INBOX_TOKEN_BYTES, MAX_PEER_FRAME_BYTES, PROTOCOL_VERSION, valid_inbox_token,
    valid_instance_id, valid_namespace_id, valid_pipe_name_shape,
};
use crate::security::{
    Event, PrivateSecurityDescriptor, ProcessIdentity, constant_time_eq_43, random_bytes,
    verify_private_handle,
};

const PIPE_MAGIC: &[u8; 4] = b"XCPP";
const PIPE_HEADER_BYTES: usize = 12;
const REQUEST: u8 = 0x01;
const RESPONSE: u8 = 0x02;
const REQUEST_PAYLOAD_OVERHEAD: usize = 36 + INBOX_TOKEN_BYTES;
const MAX_PIPE_PAYLOAD: usize = REQUEST_PAYLOAD_OVERHEAD + MAX_PEER_FRAME_BYTES;
const INBOUND_REQUEST_DEADLINE: Duration = Duration::from_secs(30);
const CONTROL_POLL_INTERVAL: Duration = Duration::from_millis(5);
const CLIENT_RETRY_INTERVAL: Duration = Duration::from_millis(20);
const MAX_CONNECTIONS: usize = 64;
const PIPE_BUFFER_BYTES: u32 = 16 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PipeErrorCode {
    Timeout,
    Canceled,
    TargetUnavailable,
    IdentityUnverified,
    AuthenticationFailed,
    ProtocolMismatch,
    Capacity,
    ShuttingDown,
    SecurityContextLost,
    Io,
}

#[derive(Debug, Clone)]
pub struct PipeError {
    pub code: PipeErrorCode,
    message: &'static str,
    os_code: Option<i32>,
}

impl PipeError {
    pub(crate) fn new(code: PipeErrorCode, message: &'static str) -> Self {
        Self {
            code,
            message,
            os_code: None,
        }
    }

    fn os(code: PipeErrorCode, message: &'static str, error: io::Error) -> Self {
        Self {
            code,
            message,
            os_code: error.raw_os_error(),
        }
    }

    pub fn sanitized_message(&self) -> String {
        match self.os_code {
            Some(code) => format!("{} (Windows error {code})", self.message),
            None => self.message.to_owned(),
        }
    }
}

impl fmt::Display for PipeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.sanitized_message())
    }
}

impl std::error::Error for PipeError {}

pub trait InboundHandler: Send + Sync + 'static {
    fn handle_inbound(
        &self,
        sender_instance_id: String,
        peer_frame: Vec<u8>,
        deadline: Instant,
    ) -> Result<Vec<u8>, PipeError>;

    fn server_fatal(&self, error: PipeError);
}

#[derive(Clone)]
pub struct ServerConfig {
    pub namespace_id: String,
    pub inbox_token: [u8; INBOX_TOKEN_BYTES],
    pub identity: ProcessIdentity,
    pub force_shutdown: Event,
}

pub struct PipeServer {
    pub address: String,
    stop_accepting: Event,
    active_connections: Arc<AtomicUsize>,
    listener: Option<thread::JoinHandle<()>>,
}

impl PipeServer {
    pub fn start(
        config: ServerConfig,
        handler: Arc<dyn InboundHandler>,
    ) -> Result<Self, PipeError> {
        let address = generate_pipe_name(&config.namespace_id)?;
        let descriptor = Arc::new(
            PrivateSecurityDescriptor::new(&config.identity.account_sid, false).map_err(
                |error| {
                    PipeError::os(
                        PipeErrorCode::Io,
                        "pipe security descriptor creation failed",
                        error,
                    )
                },
            )?,
        );
        let stop_accepting = Event::manual_reset().map_err(|error| {
            PipeError::os(
                PipeErrorCode::Io,
                "listener stop event creation failed",
                error,
            )
        })?;
        let active_connections = Arc::new(AtomicUsize::new(0));
        let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
        let listener_address = address.clone();
        let listener_stop = stop_accepting.clone();
        let listener_active = active_connections.clone();
        let listener = thread::Builder::new()
            .name("xc-peer-pipe-listener".to_owned())
            .spawn(move || {
                run_listener(
                    listener_address,
                    descriptor,
                    config,
                    listener_stop,
                    listener_active,
                    handler,
                    ready_sender,
                );
            })
            .map_err(|error| {
                PipeError::os(PipeErrorCode::Io, "listener thread creation failed", error)
            })?;

        let ready = ready_receiver.recv().map_err(|_| {
            PipeError::new(
                PipeErrorCode::Io,
                "listener initialization ended unexpectedly",
            )
        })?;
        if let Err(error) = ready {
            let _ = listener.join();
            return Err(error);
        }
        Ok(Self {
            address,
            stop_accepting,
            active_connections,
            listener: Some(listener),
        })
    }

    pub fn stop_accepting(&self) {
        let _ = self.stop_accepting.signal();
    }

    pub fn active_connections(&self) -> usize {
        self.active_connections.load(Ordering::Acquire)
    }

    pub fn release_listener(&mut self) {
        self.listener.take();
    }
}

impl Drop for PipeServer {
    fn drop(&mut self) {
        self.stop_accepting();
        self.release_listener();
    }
}

fn run_listener(
    address: String,
    descriptor: Arc<PrivateSecurityDescriptor>,
    config: ServerConfig,
    stop_accepting: Event,
    active_connections: Arc<AtomicUsize>,
    handler: Arc<dyn InboundHandler>,
    ready: mpsc::SyncSender<Result<(), PipeError>>,
) {
    let runtime = match Builder::new_current_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => {
            let _ = ready.send(Err(PipeError::os(
                PipeErrorCode::Io,
                "listener runtime creation failed",
                error,
            )));
            return;
        }
    };
    let first = match runtime
        .block_on(async { create_server_instance(&address, true, &descriptor, &config.identity) })
    {
        Ok(first) => first,
        Err(error) => {
            let _ = ready.send(Err(error));
            return;
        }
    };
    if ready.send(Ok(())).is_err() {
        return;
    }

    let result = runtime.block_on(run_accept_loop(
        first,
        &address,
        descriptor,
        config.clone(),
        stop_accepting.clone(),
        active_connections,
        handler.clone(),
    ));
    if let Err(error) = result
        && !stop_accepting.is_signaled()
        && !config.force_shutdown.is_signaled()
    {
        handler.server_fatal(error);
    }
}

async fn run_accept_loop(
    first: NamedPipeServer,
    address: &str,
    descriptor: Arc<PrivateSecurityDescriptor>,
    config: ServerConfig,
    stop_accepting: Event,
    active_connections: Arc<AtomicUsize>,
    handler: Arc<dyn InboundHandler>,
) -> Result<(), PipeError> {
    let mut pending = Some(first);
    loop {
        if stop_accepting.is_signaled() || config.force_shutdown.is_signaled() {
            break;
        }
        let mut server = match pending.take() {
            Some(server) => server,
            None => create_server_instance(address, false, &descriptor, &config.identity)?,
        };
        match accept_connection(&server, &stop_accepting, &config.force_shutdown).await {
            Ok(()) => {}
            Err(error)
                if matches!(
                    error.code,
                    PipeErrorCode::Canceled | PipeErrorCode::ShuttingDown
                ) =>
            {
                break;
            }
            Err(error) if abandoned_accept(&error) => {
                tokio::task::yield_now().await;
                continue;
            }
            Err(error) => return Err(error),
        }
        if stop_accepting.is_signaled() || config.force_shutdown.is_signaled() {
            let _ = server.disconnect();
            break;
        }
        if active_connections
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |active| {
                (active < MAX_CONNECTIONS).then_some(active + 1)
            })
            .is_err()
        {
            let _ = server.disconnect();
            tokio::task::yield_now().await;
            continue;
        }

        let connection_config = config.clone();
        let connection_active = active_connections.clone();
        let connection_handler = handler.clone();
        tokio::spawn(async move {
            let _guard = ActiveConnectionGuard(connection_active);
            let fatal_handler = connection_handler.clone();
            if let Err(error) =
                handle_server_connection(&mut server, connection_config, connection_handler).await
            {
                if error.code == PipeErrorCode::SecurityContextLost {
                    fatal_handler.server_fatal(error);
                } else {
                    eprintln!("xc-peer-broker: inbound {:?}: {error}", error.code);
                }
            }
        });
        tokio::task::yield_now().await;
    }

    while active_connections.load(Ordering::Acquire) != 0 {
        sleep(CONTROL_POLL_INTERVAL).await;
    }
    Ok(())
}

async fn accept_connection(
    server: &NamedPipeServer,
    stop_accepting: &Event,
    force_shutdown: &Event,
) -> Result<(), PipeError> {
    let mut connect = std::pin::pin!(server.connect());
    loop {
        if stop_accepting.is_signaled() {
            return Err(PipeError::new(
                PipeErrorCode::Canceled,
                "peer listener stopped",
            ));
        }
        if force_shutdown.is_signaled() {
            return Err(PipeError::new(
                PipeErrorCode::ShuttingDown,
                "peer broker is shutting down",
            ));
        }
        if let Ok(result) = timeout(CONTROL_POLL_INTERVAL, connect.as_mut()).await {
            return result.map_err(|error| {
                PipeError::os(PipeErrorCode::Io, "named pipe accept failed", error)
            });
        }
    }
}

fn abandoned_accept(error: &PipeError) -> bool {
    matches!(
        error.os_code,
        Some(code) if code == ERROR_NO_DATA as i32 || code == ERROR_PIPE_NOT_CONNECTED as i32
    )
}

struct ActiveConnectionGuard(Arc<AtomicUsize>);

impl Drop for ActiveConnectionGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

fn create_server_instance(
    address: &str,
    first_instance: bool,
    descriptor: &PrivateSecurityDescriptor,
    identity: &ProcessIdentity,
) -> Result<NamedPipeServer, PipeError> {
    let mut attributes = descriptor.attributes();
    let mut options = ServerOptions::new();
    options
        .first_pipe_instance(first_instance)
        .reject_remote_clients(true)
        .out_buffer_size(PIPE_BUFFER_BYTES)
        .in_buffer_size(PIPE_BUFFER_BYTES);
    let server = unsafe {
        options.create_with_security_attributes_raw(
            address,
            std::ptr::from_mut(&mut attributes).cast::<c_void>(),
        )
    }
    .map_err(|error| {
        PipeError::os(
            PipeErrorCode::Io,
            "secure named pipe creation failed",
            error,
        )
    })?;
    verify_private_handle(server.as_raw_handle() as HANDLE, &identity.account_sid).map_err(
        |error| {
            PipeError::os(
                PipeErrorCode::Io,
                "named pipe DACL verification failed",
                error,
            )
        },
    )?;
    Ok(server)
}

async fn handle_server_connection(
    server: &mut NamedPipeServer,
    config: ServerConfig,
    handler: Arc<dyn InboundHandler>,
) -> Result<(), PipeError> {
    let request_deadline = Instant::now() + INBOUND_REQUEST_DEADLINE;
    let request = read_pipe_frame(
        server,
        MAX_PIPE_PAYLOAD,
        request_deadline,
        None,
        &config.force_shutdown,
    )
    .await?;
    if request.kind != REQUEST {
        return Err(PipeError::new(
            PipeErrorCode::AuthenticationFailed,
            "peer authentication failed",
        ));
    }
    let request = parse_request_payload(&request.payload).map_err(|_| {
        PipeError::new(
            PipeErrorCode::AuthenticationFailed,
            "peer authentication failed",
        )
    })?;

    verify_named_pipe_client(server.as_raw_handle() as HANDLE, &config.identity).map_err(
        |error| match error {
            ClientVerificationError::Identity(error) => PipeError::os(
                PipeErrorCode::IdentityUnverified,
                "peer client identity could not be verified",
                error,
            ),
            ClientVerificationError::Revert(error) => PipeError::os(
                PipeErrorCode::SecurityContextLost,
                "peer listener could not restore its process security context",
                error,
            ),
        },
    )?;
    if !constant_time_eq_43(&config.inbox_token, &request.inbox_token) {
        return Err(PipeError::new(
            PipeErrorCode::AuthenticationFailed,
            "peer authentication failed",
        ));
    }

    let response = tokio::task::spawn_blocking(move || {
        handler.handle_inbound(
            request.sender_instance_id,
            request.peer_frame,
            request_deadline,
        )
    })
    .await
    .map_err(|_| PipeError::new(PipeErrorCode::Io, "inbound handler stopped unexpectedly"))??;
    validate_business_frame(&response)?;
    write_pipe_frame(
        server,
        RESPONSE,
        &response,
        request_deadline,
        None,
        &config.force_shutdown,
    )
    .await?;
    let _ = server.disconnect();
    Ok(())
}

pub struct OutboundPipeRequest<'a> {
    pub address: &'a str,
    pub target_token: &'a [u8; INBOX_TOKEN_BYTES],
    pub sender_instance_id: &'a str,
    pub peer_frame: &'a [u8],
    pub identity: &'a ProcessIdentity,
    pub deadline: Instant,
    pub cancel: &'a Event,
    pub force_shutdown: &'a Event,
}

pub fn self_test(identity: &ProcessIdentity) -> Result<(), PipeError> {
    let descriptor =
        PrivateSecurityDescriptor::new(&identity.account_sid, false).map_err(|error| {
            PipeError::os(
                PipeErrorCode::Io,
                "pipe security descriptor self-test failed",
                error,
            )
        })?;
    let address = generate_pipe_name("012345abcdef")?;
    let runtime = Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| {
            PipeError::os(
                PipeErrorCode::Io,
                "pipe self-test runtime creation failed",
                error,
            )
        })?;
    runtime.block_on(async {
        let first = create_server_instance(&address, true, &descriptor, identity)?;
        let second = create_server_instance(&address, false, &descriptor, identity)?;
        drop((first, second));
        Ok(())
    })
}

pub async fn outbound_request_async(
    request: OutboundPipeRequest<'_>,
) -> Result<Vec<u8>, PipeError> {
    if !valid_pipe_name_shape(request.address, None)
        || !valid_instance_id(request.sender_instance_id)
        || request.peer_frame.is_empty()
        || request.peer_frame.len() > MAX_PEER_FRAME_BYTES
    {
        return Err(PipeError::new(
            PipeErrorCode::ProtocolMismatch,
            "outbound request is invalid",
        ));
    }
    let mut pipe = connect_client(
        request.address,
        request.deadline,
        request.cancel,
        request.force_shutdown,
    )
    .await?;
    verify_named_pipe_server(pipe.as_raw_handle() as HANDLE, request.identity).map_err(|_| {
        PipeError::new(
            PipeErrorCode::IdentityUnverified,
            "peer server identity could not be verified",
        )
    })?;

    let request_payload = encode_request_payload(
        request.sender_instance_id,
        request.target_token,
        request.peer_frame,
    )?;
    write_pipe_frame(
        &mut pipe,
        REQUEST,
        &request_payload,
        request.deadline,
        Some(request.cancel),
        request.force_shutdown,
    )
    .await?;
    let response = read_pipe_frame(
        &mut pipe,
        MAX_PEER_FRAME_BYTES,
        request.deadline,
        Some(request.cancel),
        request.force_shutdown,
    )
    .await?;
    if response.kind != RESPONSE {
        return Err(PipeError::new(
            PipeErrorCode::ProtocolMismatch,
            "peer response phase is invalid",
        ));
    }
    validate_business_frame(&response.payload)?;
    Ok(response.payload)
}

async fn connect_client(
    address: &str,
    deadline: Instant,
    cancel: &Event,
    force_shutdown: &Event,
) -> Result<NamedPipeClient, PipeError> {
    loop {
        check_request_controls(deadline, Some(cancel), force_shutdown)?;
        let mut options = ClientOptions::new();
        options.security_qos_flags(SECURITY_IDENTIFICATION);
        match options.open(address) {
            Ok(client) => return Ok(client),
            Err(error)
                if matches!(
                    error.raw_os_error(),
                    Some(code)
                        if code == ERROR_PIPE_BUSY as i32 || code == ERROR_FILE_NOT_FOUND as i32
                ) =>
            {
                wait_cancelable_delay(CLIENT_RETRY_INTERVAL, deadline, cancel, force_shutdown)
                    .await?;
            }
            Err(error) => {
                return Err(PipeError::os(
                    PipeErrorCode::TargetUnavailable,
                    "peer pipe connection failed",
                    error,
                ));
            }
        }
    }
}

async fn wait_cancelable_delay(
    delay: Duration,
    deadline: Instant,
    cancel: &Event,
    force_shutdown: &Event,
) -> Result<(), PipeError> {
    let wake_at = Instant::now() + delay;
    loop {
        check_request_controls(deadline, Some(cancel), force_shutdown)?;
        let remaining = wake_at.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Ok(());
        }
        sleep(CONTROL_POLL_INTERVAL.min(remaining)).await;
    }
}

#[derive(Debug, PartialEq, Eq)]
struct PipeFrame {
    kind: u8,
    payload: Vec<u8>,
}

fn encode_pipe_frame(kind: u8, payload: &[u8]) -> Result<Vec<u8>, PipeError> {
    if !matches!(kind, REQUEST | RESPONSE) || payload.len() > MAX_PIPE_PAYLOAD {
        return Err(PipeError::new(
            PipeErrorCode::ProtocolMismatch,
            "peer pipe frame is invalid",
        ));
    }
    let mut bytes = Vec::with_capacity(PIPE_HEADER_BYTES + payload.len());
    bytes.extend_from_slice(PIPE_MAGIC);
    bytes.push(PROTOCOL_VERSION);
    bytes.push(kind);
    bytes.extend_from_slice(&0u16.to_le_bytes());
    bytes.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    bytes.extend_from_slice(payload);
    Ok(bytes)
}

fn decode_pipe_header(header: &[u8], maximum: usize) -> Result<(u8, usize), PipeError> {
    if header.len() != PIPE_HEADER_BYTES
        || &header[..4] != PIPE_MAGIC
        || header[4] != PROTOCOL_VERSION
        || u16::from_le_bytes(header[6..8].try_into().expect("fixed pipe header")) != 0
    {
        return Err(PipeError::new(
            PipeErrorCode::ProtocolMismatch,
            "peer pipe header is invalid",
        ));
    }
    let kind = header[5];
    if !matches!(kind, REQUEST | RESPONSE) {
        return Err(PipeError::new(
            PipeErrorCode::ProtocolMismatch,
            "peer pipe kind is invalid",
        ));
    }
    let length = u32::from_le_bytes(header[8..12].try_into().expect("fixed pipe header")) as usize;
    if length > maximum || length > MAX_PIPE_PAYLOAD {
        return Err(PipeError::new(
            PipeErrorCode::ProtocolMismatch,
            "peer pipe payload exceeds limit",
        ));
    }
    Ok((kind, length))
}

async fn read_pipe_frame<R: AsyncRead + Unpin>(
    reader: &mut R,
    maximum: usize,
    deadline: Instant,
    cancel: Option<&Event>,
    force_shutdown: &Event,
) -> Result<PipeFrame, PipeError> {
    let mut header = [0u8; PIPE_HEADER_BYTES];
    controlled_io(
        reader.read_exact(&mut header),
        deadline,
        cancel,
        force_shutdown,
        "peer pipe read failed",
    )
    .await?;
    let (kind, length) = decode_pipe_header(&header, maximum)?;
    let mut payload = vec![0u8; length];
    controlled_io(
        reader.read_exact(&mut payload),
        deadline,
        cancel,
        force_shutdown,
        "peer pipe read failed",
    )
    .await?;
    Ok(PipeFrame { kind, payload })
}

async fn write_pipe_frame<W: AsyncWrite + Unpin>(
    writer: &mut W,
    kind: u8,
    payload: &[u8],
    deadline: Instant,
    cancel: Option<&Event>,
    force_shutdown: &Event,
) -> Result<(), PipeError> {
    let bytes = encode_pipe_frame(kind, payload)?;
    controlled_io(
        writer.write_all(&bytes),
        deadline,
        cancel,
        force_shutdown,
        "peer pipe write failed",
    )
    .await
}

async fn controlled_io<T, F>(
    operation: F,
    deadline: Instant,
    cancel: Option<&Event>,
    force_shutdown: &Event,
    message: &'static str,
) -> Result<T, PipeError>
where
    F: Future<Output = io::Result<T>>,
{
    let mut operation = std::pin::pin!(operation);
    loop {
        check_request_controls(deadline, cancel, force_shutdown)?;
        let remaining = deadline.saturating_duration_since(Instant::now());
        if let Ok(result) = timeout(CONTROL_POLL_INTERVAL.min(remaining), operation.as_mut()).await
        {
            return result.map_err(|error| PipeError::os(PipeErrorCode::Io, message, error));
        }
    }
}

fn check_request_controls(
    deadline: Instant,
    cancel: Option<&Event>,
    force_shutdown: &Event,
) -> Result<(), PipeError> {
    if Instant::now() >= deadline {
        return Err(PipeError::new(
            PipeErrorCode::Timeout,
            "peer request timed out",
        ));
    }
    if cancel.is_some_and(Event::is_signaled) {
        return Err(PipeError::new(
            PipeErrorCode::Canceled,
            "peer request was canceled",
        ));
    }
    if force_shutdown.is_signaled() {
        return Err(PipeError::new(
            PipeErrorCode::ShuttingDown,
            "peer broker is shutting down",
        ));
    }
    Ok(())
}

struct RequestPayload {
    sender_instance_id: String,
    inbox_token: [u8; INBOX_TOKEN_BYTES],
    peer_frame: Vec<u8>,
}

fn encode_request_payload(
    sender_instance_id: &str,
    inbox_token: &[u8; INBOX_TOKEN_BYTES],
    peer_frame: &[u8],
) -> Result<Vec<u8>, PipeError> {
    if !valid_instance_id(sender_instance_id)
        || !valid_inbox_token(std::str::from_utf8(inbox_token).unwrap_or(""))
    {
        return Err(PipeError::new(
            PipeErrorCode::ProtocolMismatch,
            "peer authentication payload is invalid",
        ));
    }
    validate_business_frame(peer_frame)?;
    let mut payload = Vec::with_capacity(REQUEST_PAYLOAD_OVERHEAD + peer_frame.len());
    payload.extend_from_slice(sender_instance_id.as_bytes());
    payload.extend_from_slice(inbox_token);
    payload.extend_from_slice(peer_frame);
    Ok(payload)
}

fn parse_request_payload(payload: &[u8]) -> Result<RequestPayload, PipeError> {
    if payload.len() <= REQUEST_PAYLOAD_OVERHEAD || payload.len() > MAX_PIPE_PAYLOAD {
        return Err(PipeError::new(
            PipeErrorCode::ProtocolMismatch,
            "peer authentication payload is invalid",
        ));
    }
    let sender_instance_id = std::str::from_utf8(&payload[..36])
        .map_err(|_| {
            PipeError::new(
                PipeErrorCode::ProtocolMismatch,
                "peer sender identity is invalid",
            )
        })?
        .to_owned();
    if !valid_instance_id(&sender_instance_id) {
        return Err(PipeError::new(
            PipeErrorCode::ProtocolMismatch,
            "peer sender identity is invalid",
        ));
    }
    let inbox_token = payload[36..REQUEST_PAYLOAD_OVERHEAD]
        .try_into()
        .expect("fixed request token");
    let peer_frame = payload[REQUEST_PAYLOAD_OVERHEAD..].to_vec();
    validate_business_frame(&peer_frame)?;
    Ok(RequestPayload {
        sender_instance_id,
        inbox_token,
        peer_frame,
    })
}

fn validate_business_frame(peer_frame: &[u8]) -> Result<(), PipeError> {
    if peer_frame.is_empty() || peer_frame.len() > MAX_PEER_FRAME_BYTES {
        return Err(PipeError::new(
            PipeErrorCode::ProtocolMismatch,
            "peer business frame length is invalid",
        ));
    }
    Ok(())
}

pub fn generate_pipe_name(namespace_id: &str) -> Result<String, PipeError> {
    if !valid_namespace_id(namespace_id) {
        return Err(PipeError::new(
            PipeErrorCode::ProtocolMismatch,
            "namespace id is invalid",
        ));
    }
    let mut random = [0u8; 24];
    random_bytes(&mut random)
        .map_err(|error| PipeError::os(PipeErrorCode::Io, "pipe name generation failed", error))?;
    let encoded = base64url_192(&random);
    let address = format!(r"\\.\pipe\x-code-peer-v2-{namespace_id}-{encoded}");
    if !valid_pipe_name_shape(&address, Some(namespace_id)) {
        return Err(PipeError::new(
            PipeErrorCode::ProtocolMismatch,
            "generated pipe name is invalid",
        ));
    }
    Ok(address)
}

fn base64url_192(bytes: &[u8; 24]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut output = [0u8; 32];
    for (chunk_index, chunk) in bytes.as_chunks::<3>().0.iter().enumerate() {
        let value = ((chunk[0] as u32) << 16) | ((chunk[1] as u32) << 8) | chunk[2] as u32;
        let offset = chunk_index * 4;
        output[offset] = ALPHABET[((value >> 18) & 0x3f) as usize];
        output[offset + 1] = ALPHABET[((value >> 12) & 0x3f) as usize];
        output[offset + 2] = ALPHABET[((value >> 6) & 0x3f) as usize];
        output[offset + 3] = ALPHABET[(value & 0x3f) as usize];
    }
    String::from_utf8(output.to_vec()).expect("base64url alphabet is UTF-8")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pipe_name_has_192_bit_random_shape() {
        let first = generate_pipe_name("012345abcdef").unwrap();
        let second = generate_pipe_name("012345abcdef").unwrap();
        assert!(valid_pipe_name_shape(&first, Some("012345abcdef")));
        assert_eq!(first.len(), r"\\.\pipe\x-code-peer-v2-".len() + 12 + 1 + 32);
        assert_ne!(first, second);
    }

    #[test]
    fn secure_server_supports_first_and_subsequent_instances() {
        let identity = crate::process_peer::current_process_identity().unwrap();
        self_test(&identity).unwrap();
    }

    #[test]
    fn disconnected_accept_instances_are_recoverable() {
        for code in [ERROR_NO_DATA, ERROR_PIPE_NOT_CONNECTED] {
            let error = PipeError::os(
                PipeErrorCode::Io,
                "named pipe accept failed",
                io::Error::from_raw_os_error(code as i32),
            );
            assert!(abandoned_accept(&error));
        }
        let fatal = PipeError::os(
            PipeErrorCode::Io,
            "named pipe accept failed",
            io::Error::from_raw_os_error(ERROR_FILE_NOT_FOUND as i32),
        );
        assert!(!abandoned_accept(&fatal));
    }

    #[test]
    fn pipe_codec_rejects_bad_flags_kind_length_and_business_bounds() {
        let encoded = encode_pipe_frame(REQUEST, b"test").unwrap();
        assert_eq!(
            decode_pipe_header(&encoded[..PIPE_HEADER_BYTES], 4).unwrap(),
            (REQUEST, 4)
        );

        let mut flags = encoded.clone();
        flags[6] = 1;
        assert!(decode_pipe_header(&flags[..PIPE_HEADER_BYTES], 4).is_err());
        let mut kind = encoded.clone();
        kind[5] = 99;
        assert!(decode_pipe_header(&kind[..PIPE_HEADER_BYTES], 4).is_err());
        assert!(decode_pipe_header(&encoded[..PIPE_HEADER_BYTES], 3).is_err());

        assert!(validate_business_frame(&vec![0; MAX_PEER_FRAME_BYTES]).is_ok());
        assert!(validate_business_frame(&vec![0; MAX_PEER_FRAME_BYTES + 1]).is_err());
    }

    #[test]
    fn request_codec_binds_sender_token_and_business_frame() {
        let token: [u8; INBOX_TOKEN_BYTES] = [b'A'; INBOX_TOKEN_BYTES];
        let sender = "550e8400-e29b-41d4-a716-446655440000";
        let encoded = encode_request_payload(sender, &token, b"frame").unwrap();
        assert_eq!(encoded.len(), REQUEST_PAYLOAD_OVERHEAD + 5);
        let decoded = parse_request_payload(&encoded).unwrap();
        assert_eq!(decoded.sender_instance_id, sender);
        assert_eq!(decoded.inbox_token, token);
        assert_eq!(decoded.peer_frame, b"frame");
        assert!(parse_request_payload(&encoded[..REQUEST_PAYLOAD_OVERHEAD]).is_err());
    }
}
