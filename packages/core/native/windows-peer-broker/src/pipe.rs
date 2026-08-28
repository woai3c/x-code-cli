use std::fmt;
use std::io;
use std::mem::zeroed;
use std::ptr::{null, null_mut};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{
    ERROR_BROKEN_PIPE, ERROR_FILE_NOT_FOUND, ERROR_IO_PENDING, ERROR_NO_DATA, ERROR_NOT_FOUND,
    ERROR_OPERATION_ABORTED, ERROR_PIPE_BUSY, ERROR_PIPE_CONNECTED, ERROR_PIPE_NOT_CONNECTED,
    GENERIC_READ, GENERIC_WRITE, GetLastError, HANDLE, INVALID_HANDLE_VALUE, WAIT_FAILED,
    WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, OPEN_EXISTING,
    PIPE_ACCESS_DUPLEX, ReadFile, SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT, WriteFile,
};
use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_BYTE,
    PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};
use windows_sys::Win32::System::Threading::WaitForMultipleObjects;

use crate::process_peer::{verify_named_pipe_client, verify_named_pipe_server};
use crate::protocol::{
    INBOX_TOKEN_BYTES, MAX_PEER_FRAME_BYTES, PROTOCOL_VERSION, valid_inbox_token,
    valid_instance_id, valid_namespace_id, valid_pipe_name_shape,
};
use crate::security::{
    Event, OwnedHandle, PrivateSecurityDescriptor, ProcessIdentity, constant_time_eq_43,
    random_bytes, wide,
};

const PIPE_MAGIC: &[u8; 4] = b"XCPP";
const PIPE_HEADER_BYTES: usize = 12;
const AUTH: u8 = 0x01;
const AUTH_OK: u8 = 0x02;
const BUSINESS_REQUEST: u8 = 0x03;
const BUSINESS_RESPONSE: u8 = 0x04;
const BUSINESS_ACK: u8 = 0x05;
const AUTH_PAYLOAD_BYTES: usize = 1 + 2 + 36 + INBOX_TOKEN_BYTES + 32;
const AUTH_OK_PAYLOAD_BYTES: usize = 64;
const MAX_PIPE_PAYLOAD: usize = MAX_PEER_FRAME_BYTES + 36;
const AUTH_DEADLINE: Duration = Duration::from_secs(5);
const INBOUND_REQUEST_DEADLINE: Duration = Duration::from_secs(30);
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
        let first = create_server_instance(&address, true, &descriptor)?;
        let stop_accepting = Event::manual_reset().map_err(|error| {
            PipeError::os(
                PipeErrorCode::Io,
                "listener stop event creation failed",
                error,
            )
        })?;
        let active_connections = Arc::new(AtomicUsize::new(0));
        let listener_stop = stop_accepting.clone();
        let listener_active = active_connections.clone();
        let listener_address = address.clone();
        let listener_config = config.clone();
        let listener = thread::Builder::new()
            .name("xc-peer-pipe-listener".to_owned())
            .spawn(move || {
                run_listener(
                    first,
                    &listener_address,
                    descriptor,
                    listener_config,
                    listener_stop,
                    listener_active,
                    handler,
                );
            })
            .map_err(|error| {
                PipeError::os(PipeErrorCode::Io, "listener thread creation failed", error)
            })?;
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
    first: OwnedHandle,
    address: &str,
    descriptor: Arc<PrivateSecurityDescriptor>,
    config: ServerConfig,
    stop_accepting: Event,
    active_connections: Arc<AtomicUsize>,
    handler: Arc<dyn InboundHandler>,
) {
    let mut pending = Some(first);
    loop {
        if stop_accepting.is_signaled() || config.force_shutdown.is_signaled() {
            return;
        }
        let instance = match pending.take() {
            Some(instance) => instance,
            None => match create_server_instance(address, false, &descriptor) {
                Ok(instance) => instance,
                Err(error) => {
                    handler.server_fatal(error);
                    return;
                }
            },
        };
        match connect_server_instance(&instance, &stop_accepting, &config.force_shutdown) {
            Ok(()) => {}
            Err(error)
                if matches!(
                    error.code,
                    PipeErrorCode::Canceled | PipeErrorCode::ShuttingDown
                ) =>
            {
                return;
            }
            Err(error) if abandoned_accept(&error) => continue,
            Err(error) => {
                handler.server_fatal(error);
                return;
            }
        }

        if active_connections
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |active| {
                (active < MAX_CONNECTIONS).then_some(active + 1)
            })
            .is_err()
        {
            unsafe {
                DisconnectNamedPipe(instance.raw());
            }
            continue;
        }
        let connection_config = config.clone();
        let connection_active = active_connections.clone();
        let connection_handler = handler.clone();
        if thread::Builder::new()
            .name("xc-peer-pipe-connection".to_owned())
            .spawn(move || {
                let _guard = ActiveConnectionGuard(connection_active);
                if let Err(error) = handle_server_connection(
                    instance,
                    &connection_config,
                    connection_handler.as_ref(),
                ) {
                    eprintln!("xc-peer-broker: inbound {:?}: {error}", error.code);
                }
            })
            .is_err()
        {
            active_connections.fetch_sub(1, Ordering::AcqRel);
            handler.server_fatal(PipeError::new(
                PipeErrorCode::Capacity,
                "connection worker creation failed",
            ));
            return;
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
) -> Result<OwnedHandle, PipeError> {
    let address_wide = wide(address).map_err(|error| {
        PipeError::os(
            PipeErrorCode::ProtocolMismatch,
            "pipe name is invalid",
            error,
        )
    })?;
    let attributes = descriptor.attributes();
    let handle = unsafe {
        CreateNamedPipeW(
            address_wide.as_ptr(),
            server_open_mode(first_instance),
            server_pipe_mode(),
            PIPE_UNLIMITED_INSTANCES,
            PIPE_BUFFER_BYTES,
            PIPE_BUFFER_BYTES,
            0,
            &attributes,
        )
    };
    OwnedHandle::new(handle).map_err(|error| {
        PipeError::os(
            PipeErrorCode::Io,
            "secure named pipe creation failed",
            error,
        )
    })
}

fn server_open_mode(first_instance: bool) -> u32 {
    PIPE_ACCESS_DUPLEX
        | FILE_FLAG_OVERLAPPED
        | if first_instance {
            FILE_FLAG_FIRST_PIPE_INSTANCE
        } else {
            0
        }
}

fn server_pipe_mode() -> u32 {
    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS
}

fn connect_server_instance(
    pipe: &OwnedHandle,
    stop_accepting: &Event,
    force_shutdown: &Event,
) -> Result<(), PipeError> {
    let event = Event::manual_reset().map_err(|error| {
        PipeError::os(PipeErrorCode::Io, "connect event creation failed", error)
    })?;
    let mut overlapped: OVERLAPPED = unsafe { zeroed() };
    overlapped.hEvent = event.raw();
    let connected = unsafe { ConnectNamedPipe(pipe.raw(), &mut overlapped) };
    if connected != 0 {
        return Ok(());
    }
    let error = unsafe { GetLastError() };
    if error == ERROR_PIPE_CONNECTED {
        return Ok(());
    }
    if error != ERROR_IO_PENDING {
        return Err(PipeError::os(
            PipeErrorCode::Io,
            "named pipe accept failed",
            io::Error::from_raw_os_error(error as i32),
        ));
    }
    wait_overlapped(
        pipe.raw(),
        &mut overlapped,
        event.raw(),
        &[stop_accepting.raw(), force_shutdown.raw()],
        None,
    )
    .map(|_| ())
}

fn handle_server_connection(
    pipe: OwnedHandle,
    config: &ServerConfig,
    handler: &dyn InboundHandler,
) -> Result<(), PipeError> {
    let auth_deadline = Instant::now() + AUTH_DEADLINE;
    let auth_frame = read_pipe_frame(
        pipe.raw(),
        AUTH_PAYLOAD_BYTES,
        auth_deadline,
        &[],
        &config.force_shutdown,
    )?;
    if auth_frame.kind != AUTH {
        return Err(PipeError::new(
            PipeErrorCode::AuthenticationFailed,
            "peer authentication failed",
        ));
    }
    let auth = parse_auth_payload(&auth_frame.payload).map_err(|_| {
        PipeError::new(
            PipeErrorCode::AuthenticationFailed,
            "peer authentication failed",
        )
    })?;

    verify_named_pipe_client(pipe.raw(), &config.identity).map_err(|_| {
        PipeError::new(
            PipeErrorCode::IdentityUnverified,
            "peer client identity could not be verified",
        )
    })?;
    if !constant_time_eq_43(&config.inbox_token, &auth.inbox_token) {
        return Err(PipeError::new(
            PipeErrorCode::AuthenticationFailed,
            "peer authentication failed",
        ));
    }

    let mut server_nonce = [0u8; 32];
    random_bytes(&mut server_nonce)
        .map_err(|error| PipeError::os(PipeErrorCode::Io, "nonce generation failed", error))?;
    let mut auth_ok = Vec::with_capacity(AUTH_OK_PAYLOAD_BYTES);
    auth_ok.extend_from_slice(&auth.client_nonce);
    auth_ok.extend_from_slice(&server_nonce);
    write_pipe_frame(
        pipe.raw(),
        AUTH_OK,
        &auth_ok,
        auth_deadline,
        &[],
        &config.force_shutdown,
    )?;

    let request_deadline = Instant::now() + INBOUND_REQUEST_DEADLINE;
    let request = read_pipe_frame(
        pipe.raw(),
        MAX_PIPE_PAYLOAD,
        request_deadline,
        &[],
        &config.force_shutdown,
    )?;
    if request.kind != BUSINESS_REQUEST {
        return Err(PipeError::new(
            PipeErrorCode::ProtocolMismatch,
            "peer business phase is invalid",
        ));
    }
    let peer_frame = parse_business_request_payload(&request.payload, &server_nonce)?;
    let response = handler.handle_inbound(auth.sender_instance_id, peer_frame, request_deadline)?;
    let response_payload = encode_business_payload(&response)?;
    write_pipe_frame(
        pipe.raw(),
        BUSINESS_RESPONSE,
        &response_payload,
        request_deadline,
        &[],
        &config.force_shutdown,
    )?;
    let acknowledgement =
        read_pipe_frame(pipe.raw(), 0, request_deadline, &[], &config.force_shutdown)?;
    if acknowledgement.kind != BUSINESS_ACK || !acknowledgement.payload.is_empty() {
        return Err(PipeError::new(
            PipeErrorCode::ProtocolMismatch,
            "peer response acknowledgement is invalid",
        ));
    }
    unsafe {
        DisconnectNamedPipe(pipe.raw());
    }
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
    let first = create_server_instance(&address, true, &descriptor)?;
    let second = create_server_instance(&address, false, &descriptor)?;
    crate::security::verify_private_handle(first.raw(), &identity.account_sid)
        .and_then(|()| crate::security::verify_private_handle(second.raw(), &identity.account_sid))
        .map_err(|error| PipeError::os(PipeErrorCode::Io, "pipe DACL self-test failed", error))
}

pub fn outbound_request(request: OutboundPipeRequest<'_>) -> Result<Vec<u8>, PipeError> {
    let OutboundPipeRequest {
        address,
        target_token,
        sender_instance_id,
        peer_frame,
        identity,
        deadline,
        cancel,
        force_shutdown,
    } = request;
    if !valid_pipe_name_shape(address, None)
        || !valid_instance_id(sender_instance_id)
        || peer_frame.is_empty()
        || peer_frame.len() > MAX_PEER_FRAME_BYTES
    {
        return Err(PipeError::new(
            PipeErrorCode::ProtocolMismatch,
            "outbound request is invalid",
        ));
    }
    let pipe = connect_client(address, deadline, cancel, force_shutdown)?;
    verify_named_pipe_server(pipe.raw(), identity).map_err(|_| {
        PipeError::new(
            PipeErrorCode::IdentityUnverified,
            "peer server identity could not be verified",
        )
    })?;

    let mut client_nonce = [0u8; 32];
    random_bytes(&mut client_nonce)
        .map_err(|error| PipeError::os(PipeErrorCode::Io, "nonce generation failed", error))?;
    let auth_payload = encode_auth_payload(sender_instance_id, target_token, &client_nonce)?;
    let auth_deadline = deadline.min(Instant::now() + AUTH_DEADLINE);
    write_pipe_frame(
        pipe.raw(),
        AUTH,
        &auth_payload,
        auth_deadline,
        &[cancel.raw()],
        force_shutdown,
    )?;
    let auth_ok = read_pipe_frame(
        pipe.raw(),
        AUTH_OK_PAYLOAD_BYTES,
        auth_deadline,
        &[cancel.raw()],
        force_shutdown,
    )?;
    if auth_ok.kind != AUTH_OK || auth_ok.payload.len() != AUTH_OK_PAYLOAD_BYTES {
        return Err(PipeError::new(
            PipeErrorCode::AuthenticationFailed,
            "peer authentication failed",
        ));
    }
    if !constant_time_equal(&auth_ok.payload[..32], &client_nonce) {
        return Err(PipeError::new(
            PipeErrorCode::AuthenticationFailed,
            "peer authentication failed",
        ));
    }

    let server_nonce: [u8; 32] = auth_ok.payload[32..]
        .try_into()
        .expect("fixed server nonce");
    let request_payload = encode_business_request_payload(&server_nonce, peer_frame)?;
    write_pipe_frame(
        pipe.raw(),
        BUSINESS_REQUEST,
        &request_payload,
        deadline,
        &[cancel.raw()],
        force_shutdown,
    )?;
    let response = read_pipe_frame(
        pipe.raw(),
        MAX_PIPE_PAYLOAD,
        deadline,
        &[cancel.raw()],
        force_shutdown,
    )?;
    if response.kind != BUSINESS_RESPONSE {
        return Err(PipeError::new(
            PipeErrorCode::ProtocolMismatch,
            "peer response phase is invalid",
        ));
    }
    write_pipe_frame(
        pipe.raw(),
        BUSINESS_ACK,
        &[],
        deadline,
        &[cancel.raw()],
        force_shutdown,
    )?;
    parse_business_payload(&response.payload)
}

fn connect_client(
    address: &str,
    deadline: Instant,
    cancel: &Event,
    force_shutdown: &Event,
) -> Result<OwnedHandle, PipeError> {
    let address_wide = wide(address).map_err(|error| {
        PipeError::os(
            PipeErrorCode::ProtocolMismatch,
            "pipe name is invalid",
            error,
        )
    })?;
    loop {
        check_deadline_and_cancel(deadline, &[cancel.raw()], force_shutdown)?;
        let handle = unsafe {
            CreateFileW(
                address_wide.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                null_mut(),
            )
        };
        if handle != INVALID_HANDLE_VALUE {
            return OwnedHandle::new(handle).map_err(|error| {
                PipeError::os(
                    PipeErrorCode::TargetUnavailable,
                    "peer pipe connection failed",
                    error,
                )
            });
        }
        let error = unsafe { GetLastError() };
        if !matches!(error, ERROR_PIPE_BUSY | ERROR_FILE_NOT_FOUND) {
            return Err(PipeError::os(
                PipeErrorCode::TargetUnavailable,
                "peer pipe connection failed",
                io::Error::from_raw_os_error(error as i32),
            ));
        }
        wait_cancelable_delay(Duration::from_millis(20), deadline, cancel, force_shutdown)?;
    }
}

fn wait_cancelable_delay(
    delay: Duration,
    deadline: Instant,
    cancel: &Event,
    force_shutdown: &Event,
) -> Result<(), PipeError> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(PipeError::new(
            PipeErrorCode::Timeout,
            "peer request timed out",
        ));
    }
    let timeout = duration_millis(delay.min(remaining));
    let handles = [cancel.raw(), force_shutdown.raw()];
    match unsafe { WaitForMultipleObjects(handles.len() as u32, handles.as_ptr(), 0, timeout) } {
        WAIT_OBJECT_0 => Err(PipeError::new(
            PipeErrorCode::Canceled,
            "peer request was canceled",
        )),
        value if value == WAIT_OBJECT_0 + 1 => Err(PipeError::new(
            PipeErrorCode::ShuttingDown,
            "peer broker is shutting down",
        )),
        WAIT_TIMEOUT => Ok(()),
        _ => Err(PipeError::os(
            PipeErrorCode::Io,
            "peer wait failed",
            io::Error::last_os_error(),
        )),
    }
}

#[derive(Debug, PartialEq, Eq)]
struct PipeFrame {
    kind: u8,
    payload: Vec<u8>,
}

fn encode_pipe_frame(kind: u8, payload: &[u8]) -> Result<Vec<u8>, PipeError> {
    if !matches!(
        kind,
        AUTH | AUTH_OK | BUSINESS_REQUEST | BUSINESS_RESPONSE | BUSINESS_ACK
    ) || payload.len() > MAX_PIPE_PAYLOAD
    {
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
    if !matches!(
        kind,
        AUTH | AUTH_OK | BUSINESS_REQUEST | BUSINESS_RESPONSE | BUSINESS_ACK
    ) {
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

fn read_pipe_frame(
    pipe: HANDLE,
    maximum: usize,
    deadline: Instant,
    cancel_handles: &[HANDLE],
    force_shutdown: &Event,
) -> Result<PipeFrame, PipeError> {
    let mut header = [0u8; PIPE_HEADER_BYTES];
    read_exact_overlapped(pipe, &mut header, deadline, cancel_handles, force_shutdown)?;
    let (kind, length) = decode_pipe_header(&header, maximum)?;
    let mut payload = vec![0u8; length];
    read_exact_overlapped(pipe, &mut payload, deadline, cancel_handles, force_shutdown)?;
    Ok(PipeFrame { kind, payload })
}

fn write_pipe_frame(
    pipe: HANDLE,
    kind: u8,
    payload: &[u8],
    deadline: Instant,
    cancel_handles: &[HANDLE],
    force_shutdown: &Event,
) -> Result<(), PipeError> {
    let bytes = encode_pipe_frame(kind, payload)?;
    write_all_overlapped(pipe, &bytes, deadline, cancel_handles, force_shutdown)
}

fn read_exact_overlapped(
    pipe: HANDLE,
    mut buffer: &mut [u8],
    deadline: Instant,
    cancel_handles: &[HANDLE],
    force_shutdown: &Event,
) -> Result<(), PipeError> {
    while !buffer.is_empty() {
        check_deadline_and_cancel(deadline, cancel_handles, force_shutdown)?;
        let event = Event::manual_reset().map_err(|error| {
            PipeError::os(PipeErrorCode::Io, "read event creation failed", error)
        })?;
        let mut overlapped: OVERLAPPED = unsafe { zeroed() };
        overlapped.hEvent = event.raw();
        let requested = buffer.len().min(u32::MAX as usize) as u32;
        let started = unsafe {
            ReadFile(
                pipe,
                buffer.as_mut_ptr(),
                requested,
                null_mut(),
                &mut overlapped,
            )
        };
        let transferred = if started != 0 {
            overlapped_result(pipe, &mut overlapped)?
        } else {
            let error = unsafe { GetLastError() };
            if error == ERROR_BROKEN_PIPE {
                return Err(PipeError::new(PipeErrorCode::Io, "peer pipe closed early"));
            }
            if error != ERROR_IO_PENDING {
                return Err(PipeError::os(
                    PipeErrorCode::Io,
                    "peer pipe read failed",
                    io::Error::from_raw_os_error(error as i32),
                ));
            }
            wait_overlapped(
                pipe,
                &mut overlapped,
                event.raw(),
                cancel_handles,
                Some((deadline, force_shutdown)),
            )?
        };
        if transferred == 0 {
            return Err(PipeError::new(PipeErrorCode::Io, "peer pipe closed early"));
        }
        buffer = &mut buffer[transferred as usize..];
    }
    Ok(())
}

fn write_all_overlapped(
    pipe: HANDLE,
    mut buffer: &[u8],
    deadline: Instant,
    cancel_handles: &[HANDLE],
    force_shutdown: &Event,
) -> Result<(), PipeError> {
    while !buffer.is_empty() {
        check_deadline_and_cancel(deadline, cancel_handles, force_shutdown)?;
        let event = Event::manual_reset().map_err(|error| {
            PipeError::os(PipeErrorCode::Io, "write event creation failed", error)
        })?;
        let mut overlapped: OVERLAPPED = unsafe { zeroed() };
        overlapped.hEvent = event.raw();
        let requested = buffer.len().min(u32::MAX as usize) as u32;
        let started = unsafe {
            WriteFile(
                pipe,
                buffer.as_ptr(),
                requested,
                null_mut(),
                &mut overlapped,
            )
        };
        let transferred = if started != 0 {
            overlapped_result(pipe, &mut overlapped)?
        } else {
            let error = unsafe { GetLastError() };
            if error != ERROR_IO_PENDING {
                return Err(PipeError::os(
                    PipeErrorCode::Io,
                    "peer pipe write failed",
                    io::Error::from_raw_os_error(error as i32),
                ));
            }
            wait_overlapped(
                pipe,
                &mut overlapped,
                event.raw(),
                cancel_handles,
                Some((deadline, force_shutdown)),
            )?
        };
        if transferred == 0 {
            return Err(PipeError::new(
                PipeErrorCode::Io,
                "peer pipe write made no progress",
            ));
        }
        buffer = &buffer[transferred as usize..];
    }
    Ok(())
}

fn wait_overlapped(
    pipe: HANDLE,
    overlapped: &mut OVERLAPPED,
    io_event: HANDLE,
    cancel_handles: &[HANDLE],
    timed: Option<(Instant, &Event)>,
) -> Result<u32, PipeError> {
    let mut handles = Vec::with_capacity(2 + cancel_handles.len());
    handles.push(io_event);
    handles.extend_from_slice(cancel_handles);
    if let Some((_, force_shutdown)) = timed {
        handles.push(force_shutdown.raw());
    }
    let timeout = timed
        .map(|(deadline, _)| duration_millis(deadline.saturating_duration_since(Instant::now())))
        .unwrap_or(u32::MAX);
    let wait =
        unsafe { WaitForMultipleObjects(handles.len() as u32, handles.as_ptr(), 0, timeout) };
    if wait == WAIT_OBJECT_0 {
        return overlapped_result(pipe, overlapped);
    }

    if unsafe { CancelIoEx(pipe, overlapped) } == 0 {
        let error = unsafe { GetLastError() };
        if error != ERROR_NOT_FOUND {
            return Err(PipeError::os(
                PipeErrorCode::Io,
                "peer I/O cancellation failed",
                io::Error::from_raw_os_error(error as i32),
            ));
        }
    }
    let _ = overlapped_result(pipe, overlapped);
    if wait == WAIT_TIMEOUT {
        return Err(PipeError::new(
            PipeErrorCode::Timeout,
            "peer request timed out",
        ));
    }
    if wait == WAIT_FAILED {
        return Err(PipeError::os(
            PipeErrorCode::Io,
            "peer wait failed",
            io::Error::last_os_error(),
        ));
    }
    let selected = (wait - WAIT_OBJECT_0) as usize;
    if selected > 0 && selected <= cancel_handles.len() {
        return Err(PipeError::new(
            PipeErrorCode::Canceled,
            "peer request was canceled",
        ));
    }
    Err(PipeError::new(
        PipeErrorCode::ShuttingDown,
        "peer broker is shutting down",
    ))
}

fn overlapped_result(pipe: HANDLE, overlapped: &mut OVERLAPPED) -> Result<u32, PipeError> {
    let mut transferred = 0u32;
    if unsafe { GetOverlappedResult(pipe, overlapped, &mut transferred, 1) } == 0 {
        let error = unsafe { GetLastError() };
        let code = if error == ERROR_OPERATION_ABORTED {
            PipeErrorCode::Canceled
        } else {
            PipeErrorCode::Io
        };
        Err(PipeError::os(
            code,
            "peer overlapped operation failed",
            io::Error::from_raw_os_error(error as i32),
        ))
    } else {
        Ok(transferred)
    }
}

fn check_deadline_and_cancel(
    deadline: Instant,
    cancel_handles: &[HANDLE],
    force_shutdown: &Event,
) -> Result<(), PipeError> {
    if Instant::now() >= deadline {
        return Err(PipeError::new(
            PipeErrorCode::Timeout,
            "peer request timed out",
        ));
    }
    for handle in cancel_handles {
        let handles = [*handle];
        if unsafe { WaitForMultipleObjects(1, handles.as_ptr(), 0, 0) } == WAIT_OBJECT_0 {
            return Err(PipeError::new(
                PipeErrorCode::Canceled,
                "peer request was canceled",
            ));
        }
    }
    if force_shutdown.is_signaled() {
        return Err(PipeError::new(
            PipeErrorCode::ShuttingDown,
            "peer broker is shutting down",
        ));
    }
    Ok(())
}

fn duration_millis(duration: Duration) -> u32 {
    duration.as_millis().min((u32::MAX - 1) as u128) as u32
}

struct AuthPayload {
    sender_instance_id: String,
    inbox_token: [u8; INBOX_TOKEN_BYTES],
    client_nonce: [u8; 32],
}

fn encode_auth_payload(
    sender_instance_id: &str,
    inbox_token: &[u8; INBOX_TOKEN_BYTES],
    client_nonce: &[u8; 32],
) -> Result<Vec<u8>, PipeError> {
    if !valid_instance_id(sender_instance_id)
        || !valid_inbox_token(std::str::from_utf8(inbox_token).unwrap_or(""))
    {
        return Err(PipeError::new(
            PipeErrorCode::ProtocolMismatch,
            "peer authentication payload is invalid",
        ));
    }
    let mut payload = Vec::with_capacity(AUTH_PAYLOAD_BYTES);
    payload.push(PROTOCOL_VERSION);
    payload.extend_from_slice(&(sender_instance_id.len() as u16).to_le_bytes());
    payload.extend_from_slice(sender_instance_id.as_bytes());
    payload.extend_from_slice(inbox_token);
    payload.extend_from_slice(client_nonce);
    Ok(payload)
}

fn parse_auth_payload(payload: &[u8]) -> Result<AuthPayload, PipeError> {
    if payload.len() != AUTH_PAYLOAD_BYTES || payload[0] != PROTOCOL_VERSION {
        return Err(PipeError::new(
            PipeErrorCode::ProtocolMismatch,
            "peer authentication payload is invalid",
        ));
    }
    let sender_length = u16::from_le_bytes(payload[1..3].try_into().expect("auth prefix")) as usize;
    if sender_length != 36 {
        return Err(PipeError::new(
            PipeErrorCode::ProtocolMismatch,
            "peer sender identity is invalid",
        ));
    }
    let sender_instance_id = std::str::from_utf8(&payload[3..39])
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
    let inbox_token = payload[39..82].try_into().expect("fixed auth token");
    let client_nonce = payload[82..114].try_into().expect("fixed auth nonce");
    Ok(AuthPayload {
        sender_instance_id,
        inbox_token,
        client_nonce,
    })
}

fn encode_business_request_payload(
    server_nonce: &[u8; 32],
    peer_frame: &[u8],
) -> Result<Vec<u8>, PipeError> {
    let business = encode_business_payload(peer_frame)?;
    let mut payload = Vec::with_capacity(server_nonce.len() + business.len());
    payload.extend_from_slice(server_nonce);
    payload.extend_from_slice(&business);
    Ok(payload)
}

fn parse_business_request_payload(
    payload: &[u8],
    expected_server_nonce: &[u8; 32],
) -> Result<Vec<u8>, PipeError> {
    if payload.len() < 36 || !constant_time_equal(&payload[..32], expected_server_nonce) {
        return Err(PipeError::new(
            PipeErrorCode::AuthenticationFailed,
            "peer business challenge is invalid",
        ));
    }
    parse_business_payload(&payload[32..])
}

fn encode_business_payload(peer_frame: &[u8]) -> Result<Vec<u8>, PipeError> {
    if peer_frame.is_empty() || peer_frame.len() > MAX_PEER_FRAME_BYTES {
        return Err(PipeError::new(
            PipeErrorCode::ProtocolMismatch,
            "peer business frame length is invalid",
        ));
    }
    let mut payload = Vec::with_capacity(4 + peer_frame.len());
    payload.extend_from_slice(&(peer_frame.len() as u32).to_le_bytes());
    payload.extend_from_slice(peer_frame);
    Ok(payload)
}

fn parse_business_payload(payload: &[u8]) -> Result<Vec<u8>, PipeError> {
    if payload.len() < 4 {
        return Err(PipeError::new(
            PipeErrorCode::ProtocolMismatch,
            "peer business frame is truncated",
        ));
    }
    let length = u32::from_le_bytes(payload[..4].try_into().expect("business prefix")) as usize;
    if length == 0 || length > MAX_PEER_FRAME_BYTES || payload.len() != length + 4 {
        return Err(PipeError::new(
            PipeErrorCode::ProtocolMismatch,
            "peer business frame length is invalid",
        ));
    }
    Ok(payload[4..].to_vec())
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0u8;
    for (&left_byte, &right_byte) in left.iter().zip(right) {
        difference |= left_byte ^ right_byte;
    }
    difference == 0
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
    let address = format!(r"\\.\pipe\x-code-peer-v1-{namespace_id}-{encoded}");
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
        assert_eq!(first.len(), r"\\.\pipe\x-code-peer-v1-".len() + 12 + 1 + 32);
        assert_ne!(first, second);
    }

    #[test]
    fn every_server_instance_rejects_remote_and_only_first_has_first_flag() {
        assert_ne!(server_pipe_mode() & PIPE_REJECT_REMOTE_CLIENTS, 0);
        assert_ne!(server_open_mode(true) & FILE_FLAG_FIRST_PIPE_INSTANCE, 0);
        assert_eq!(server_open_mode(false) & FILE_FLAG_FIRST_PIPE_INSTANCE, 0);
        assert_ne!(server_open_mode(true) & FILE_FLAG_OVERLAPPED, 0);
        assert_eq!(server_pipe_mode() & PIPE_TYPE_BYTE, PIPE_TYPE_BYTE);

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
        let encoded = encode_pipe_frame(BUSINESS_REQUEST, b"test").unwrap();
        assert_eq!(
            decode_pipe_header(&encoded[..PIPE_HEADER_BYTES], 4).unwrap(),
            (BUSINESS_REQUEST, 4)
        );

        let mut flags = encoded.clone();
        flags[6] = 1;
        assert!(decode_pipe_header(&flags[..PIPE_HEADER_BYTES], 4).is_err());
        let mut kind = encoded.clone();
        kind[5] = 99;
        assert!(decode_pipe_header(&kind[..PIPE_HEADER_BYTES], 4).is_err());
        assert!(decode_pipe_header(&encoded[..PIPE_HEADER_BYTES], 3).is_err());

        assert!(encode_business_payload(&vec![0; MAX_PEER_FRAME_BYTES]).is_ok());
        assert!(encode_business_payload(&vec![0; MAX_PEER_FRAME_BYTES + 1]).is_err());
    }

    #[test]
    fn auth_and_nonce_codecs_are_fixed_and_nonce_bound() {
        let token: [u8; INBOX_TOKEN_BYTES] = [b'A'; INBOX_TOKEN_BYTES];
        let nonce = [7u8; 32];
        let sender = "550e8400-e29b-41d4-a716-446655440000";
        let encoded = encode_auth_payload(sender, &token, &nonce).unwrap();
        assert_eq!(encoded.len(), AUTH_PAYLOAD_BYTES);
        let decoded = parse_auth_payload(&encoded).unwrap();
        assert_eq!(decoded.sender_instance_id, sender);
        assert_eq!(decoded.inbox_token, token);
        assert_eq!(decoded.client_nonce, nonce);
        assert!(constant_time_equal(&nonce, &nonce));
        assert!(!constant_time_equal(&nonce, &[8u8; 32]));

        let request = encode_business_request_payload(&nonce, b"frame").unwrap();
        assert_eq!(
            parse_business_request_payload(&request, &nonce).unwrap(),
            b"frame"
        );
        assert!(parse_business_request_payload(&request, &[8u8; 32]).is_err());
    }
}
