use std::collections::{HashMap, HashSet};
use std::io::{self, Write};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use tokio::runtime::Builder as RuntimeBuilder;

use crate::pipe::{
    InboundHandler, OutboundPipeRequest, PipeError, PipeErrorCode, PipeServer, ServerConfig,
    outbound_request_async,
};
use crate::process_peer::current_process_identity;
use crate::protocol::{
    CANCEL_OPERATION, Frame, INBOUND_REQUEST, INBOUND_RESPONSE, INBOX_TOKEN_BYTES,
    MAX_ACTIVE_OPERATIONS, OPERATION_ERROR, OUTBOUND_REQUEST, OUTBOUND_RESPONSE, SERVER_FATAL,
    SERVER_READY, SHUTDOWN, SHUTDOWN_COMPLETE, START_SERVER, encode_error, encode_inbound_request,
    encode_one_string, encode_peer_frame, parse_outbound_request, parse_peer_frame_payload,
    parse_start_server, valid_pipe_name_shape,
};
use crate::security::{Event, ProcessIdentity};

const OUTBOUND_RUNTIME_THREADS: usize = 4;

fn take_operation_id(next: &AtomicU32) -> Option<u32> {
    next.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
        current.checked_add(1)
    })
    .ok()
    .filter(|operation_id| *operation_id != 0)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegisterError {
    Duplicate,
    Capacity,
}

#[derive(Debug)]
pub struct OperationBook {
    active: HashSet<u32>,
    capacity: usize,
}

impl OperationBook {
    pub fn new(capacity: usize) -> Self {
        Self {
            active: HashSet::new(),
            capacity,
        }
    }

    pub fn register(&mut self, operation_id: u32) -> Result<(), RegisterError> {
        if self.active.contains(&operation_id) {
            return Err(RegisterError::Duplicate);
        }
        if operation_id == 0 || self.active.len() >= self.capacity {
            return Err(RegisterError::Capacity);
        }
        self.active.insert(operation_id);
        Ok(())
    }

    pub fn contains(&self, operation_id: u32) -> bool {
        self.active.contains(&operation_id)
    }

    pub fn complete(&mut self, operation_id: u32) -> bool {
        self.active.remove(&operation_id)
    }

    #[cfg(test)]
    pub fn active_len(&self) -> usize {
        self.active.len()
    }
}

pub struct ControlOutput {
    writer: Mutex<Box<dyn Write + Send>>,
}

impl ControlOutput {
    pub fn new<W: Write + Send + 'static>(writer: W) -> Self {
        Self {
            writer: Mutex::new(Box::new(writer)),
        }
    }

    pub fn send(&self, kind: u8, operation_id: u32, payload: Vec<u8>) -> io::Result<()> {
        let bytes = Frame {
            kind,
            operation_id,
            payload,
        }
        .encode()
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        let mut writer = self
            .writer
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        writer.write_all(&bytes)?;
        writer.flush()
    }
}

struct OutboundState {
    book: OperationBook,
    cancel_events: HashMap<u32, Event>,
}

struct InboundState {
    book: OperationBook,
    responders: HashMap<u32, mpsc::SyncSender<Vec<u8>>>,
}

struct BrokerInner {
    output: Arc<ControlOutput>,
    identity: ProcessIdentity,
    force_shutdown: Event,
    stopping: AtomicBool,
    fatal: AtomicBool,
    server: Mutex<Option<PipeServer>>,
    namespace_id: Mutex<Option<String>>,
    outbound: Mutex<OutboundState>,
    inbound: Mutex<InboundState>,
    next_inbound_id: AtomicU32,
    worker_count: AtomicUsize,
    outbound_runtime: tokio::runtime::Runtime,
}

#[derive(Clone)]
pub struct Broker {
    inner: Arc<BrokerInner>,
}

impl Broker {
    pub fn new(output: Arc<ControlOutput>) -> io::Result<Self> {
        let identity = current_process_identity()?;
        let force_shutdown = Event::manual_reset()?;
        let outbound_runtime = RuntimeBuilder::new_multi_thread()
            .worker_threads(OUTBOUND_RUNTIME_THREADS)
            .thread_name("xc-peer-outbound")
            .enable_all()
            .build()?;
        Ok(Self {
            inner: Arc::new(BrokerInner {
                output,
                identity,
                force_shutdown,
                stopping: AtomicBool::new(false),
                fatal: AtomicBool::new(false),
                server: Mutex::new(None),
                namespace_id: Mutex::new(None),
                outbound: Mutex::new(OutboundState {
                    book: OperationBook::new(MAX_ACTIVE_OPERATIONS),
                    cancel_events: HashMap::new(),
                }),
                inbound: Mutex::new(InboundState {
                    book: OperationBook::new(MAX_ACTIVE_OPERATIONS),
                    responders: HashMap::new(),
                }),
                next_inbound_id: AtomicU32::new(0x8000_0000),
                worker_count: AtomicUsize::new(0),
                outbound_runtime,
            }),
        })
    }

    pub fn handle_frame(&self, frame: Frame) -> Result<bool, &'static str> {
        if self.inner.stopping.load(Ordering::Acquire) && frame.kind != SHUTDOWN {
            return Err("request received while broker is stopping");
        }
        match frame.kind {
            START_SERVER => {
                self.start_server(frame.operation_id, &frame.payload)?;
                Ok(false)
            }
            OUTBOUND_REQUEST => {
                self.start_outbound(frame.operation_id, &frame.payload)?;
                Ok(false)
            }
            INBOUND_RESPONSE => {
                self.finish_inbound(frame.operation_id, &frame.payload)?;
                Ok(false)
            }
            CANCEL_OPERATION => {
                self.cancel_outbound(frame.operation_id);
                Ok(false)
            }
            SHUTDOWN => {
                self.shutdown(true);
                let _ = self.inner.output.send(SHUTDOWN_COMPLETE, 0, Vec::new());
                Ok(true)
            }
            _ => Err("unexpected control frame kind"),
        }
    }

    pub fn is_fatal(&self) -> bool {
        self.inner.fatal.load(Ordering::Acquire)
    }

    pub fn protocol_fatal(&self, message: &'static str) {
        self.inner
            .report_fatal("PEER_WINDOWS_HELPER_PROTOCOL_MISMATCH", message);
    }

    pub fn force_shutdown(&self) {
        self.shutdown(false);
    }

    fn start_server(&self, operation_id: u32, payload: &[u8]) -> Result<(), &'static str> {
        let request = parse_start_server(payload).map_err(|_| "START_SERVER payload is invalid")?;
        let mut server_slot = self
            .inner
            .server
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if server_slot.is_some() {
            return Err("server is already active");
        }
        let inbox_token: [u8; INBOX_TOKEN_BYTES] = request
            .inbox_token
            .as_bytes()
            .try_into()
            .map_err(|_| "inbox token length is invalid")?;
        let config = ServerConfig {
            namespace_id: request.namespace_id.clone(),
            inbox_token,
            identity: self.inner.identity.clone(),
            force_shutdown: self.inner.force_shutdown.clone(),
        };
        let handler: Arc<dyn InboundHandler> = self.inner.clone();
        match PipeServer::start(config, handler) {
            Ok(server) => {
                let address = server.address.clone();
                *self
                    .inner
                    .namespace_id
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(request.namespace_id);
                *server_slot = Some(server);
                let payload =
                    encode_one_string(&address).map_err(|_| "SERVER_READY encoding failed")?;
                self.inner
                    .output
                    .send(SERVER_READY, 0, payload)
                    .map_err(|_| "control output failed")?;
            }
            Err(error) => {
                self.send_operation_error(
                    operation_id,
                    "PEER_WINDOWS_PIPE_CREATE_FAILED",
                    &error.sanitized_message(),
                )?;
            }
        }
        Ok(())
    }

    fn start_outbound(&self, operation_id: u32, payload: &[u8]) -> Result<(), &'static str> {
        let request =
            parse_outbound_request(payload).map_err(|_| "OUTBOUND_REQUEST payload is invalid")?;
        let namespace = self
            .inner
            .namespace_id
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let Some(namespace) = namespace else {
            self.send_operation_error(
                operation_id,
                "PEER_WINDOWS_PIPE_CREATE_FAILED",
                "peer server is not active",
            )?;
            return Ok(());
        };
        if !valid_pipe_name_shape(&request.address, Some(&namespace)) {
            return Err("outbound pipe namespace is invalid");
        }

        let cancel = Event::manual_reset().map_err(|_| "cancel event creation failed")?;
        {
            let mut outbound = self
                .inner
                .outbound
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            match outbound.book.register(operation_id) {
                Ok(()) => {}
                Err(RegisterError::Duplicate) => return Err("duplicate active operation id"),
                Err(RegisterError::Capacity) => {
                    drop(outbound);
                    self.send_operation_error(
                        operation_id,
                        "PEER_WINDOWS_OPERATION_CAPACITY",
                        "peer broker operation capacity is exhausted",
                    )?;
                    return Ok(());
                }
            }
            outbound.cancel_events.insert(operation_id, cancel.clone());
        }

        let target_token: [u8; INBOX_TOKEN_BYTES] = request
            .target_token
            .as_bytes()
            .try_into()
            .map_err(|_| "target token length is invalid")?;
        let inner = self.inner.clone();
        let runtime = inner.outbound_runtime.handle().clone();
        let deadline = Instant::now() + Duration::from_millis(request.timeout_ms as u64);
        inner.worker_count.fetch_add(1, Ordering::AcqRel);
        runtime.spawn(async move {
            let _guard = WorkerGuard(inner.clone());
            let result = outbound_request_async(OutboundPipeRequest {
                address: &request.address,
                target_token: &target_token,
                sender_instance_id: &request.sender_instance_id,
                peer_frame: &request.peer_frame,
                identity: &inner.identity,
                deadline,
                cancel: &cancel,
                force_shutdown: &inner.force_shutdown,
            })
            .await;
            inner.finish_outbound(operation_id, result);
        });
        Ok(())
    }

    fn cancel_outbound(&self, operation_id: u32) {
        let outbound = self
            .inner
            .outbound
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if outbound.book.contains(operation_id)
            && let Some(cancel) = outbound.cancel_events.get(&operation_id)
        {
            let _ = cancel.signal();
        }
    }

    fn finish_inbound(&self, operation_id: u32, payload: &[u8]) -> Result<(), &'static str> {
        let peer_frame =
            parse_peer_frame_payload(payload).map_err(|_| "INBOUND_RESPONSE payload is invalid")?;
        let responder = {
            let mut inbound = self
                .inner
                .inbound
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let responder = inbound.responders.remove(&operation_id);
            inbound.book.complete(operation_id);
            responder
        };
        if let Some(responder) = responder {
            let _ = responder.send(peer_frame);
        }
        Ok(())
    }

    fn send_operation_error(
        &self,
        operation_id: u32,
        code: &str,
        message: &str,
    ) -> Result<(), &'static str> {
        let payload = encode_error(code, &sanitize_message(message))
            .map_err(|_| "operation error encoding failed")?;
        self.inner
            .output
            .send(OPERATION_ERROR, operation_id, payload)
            .map_err(|_| "control output failed")
    }

    fn shutdown(&self, graceful: bool) {
        if self.inner.stopping.swap(true, Ordering::AcqRel) && graceful {
            return;
        }
        let mut server = self
            .inner
            .server
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(server) = server.as_mut() {
            server.stop_accepting();
            server.release_listener();
        }
        if graceful {
            let deadline = Instant::now() + Duration::from_millis(500);
            while Instant::now() < deadline
                && (self.inner.worker_count.load(Ordering::Acquire) != 0
                    || server
                        .as_ref()
                        .is_some_and(|server| server.active_connections() != 0))
            {
                thread::sleep(Duration::from_millis(10));
            }
        }
        let _ = self.inner.force_shutdown.signal();
        drop(server);
        let deadline = Instant::now() + Duration::from_secs(2);
        while graceful
            && Instant::now() < deadline
            && self.inner.worker_count.load(Ordering::Acquire) != 0
        {
            thread::sleep(Duration::from_millis(10));
        }
    }
}

impl BrokerInner {
    fn finish_outbound(&self, operation_id: u32, result: Result<Vec<u8>, PipeError>) {
        let send_result = match result {
            Ok(peer_frame) => encode_peer_frame(&peer_frame)
                .map_err(|_| io::Error::other("response encoding failed"))
                .and_then(|payload| self.output.send(OUTBOUND_RESPONSE, operation_id, payload)),
            Err(error) => {
                let (code, message) = pipe_operation_error(&error);
                encode_error(code, &sanitize_message(&message))
                    .map_err(|_| io::Error::other("error encoding failed"))
                    .and_then(|payload| self.output.send(OPERATION_ERROR, operation_id, payload))
            }
        };
        let mut outbound = self
            .outbound
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        outbound.cancel_events.remove(&operation_id);
        if !outbound.book.complete(operation_id) {
            drop(outbound);
            self.report_fatal(
                "PEER_WINDOWS_HELPER_PROTOCOL_MISMATCH",
                "outbound operation ownership was lost",
            );
            return;
        }
        drop(outbound);
        if send_result.is_err() {
            self.fatal.store(true, Ordering::Release);
            let _ = self.force_shutdown.signal();
        }
    }

    fn report_fatal(&self, code: &str, message: &str) {
        if self.fatal.swap(true, Ordering::AcqRel) {
            return;
        }
        self.stopping.store(true, Ordering::Release);
        let payload = encode_error(code, &sanitize_message(message)).unwrap_or_default();
        let _ = self.output.send(SERVER_FATAL, 0, payload);
        let _ = self.force_shutdown.signal();
    }

    fn allocate_inbound(&self, responder: mpsc::SyncSender<Vec<u8>>) -> Result<u32, PipeError> {
        for _ in 0..MAX_ACTIVE_OPERATIONS * 2 {
            let Some(operation_id) = take_operation_id(&self.next_inbound_id) else {
                self.report_fatal(
                    "PEER_WINDOWS_OPERATION_CAPACITY",
                    "inbound operation ids are exhausted",
                );
                return Err(PipeError::new(
                    PipeErrorCode::Capacity,
                    "inbound operation ids are exhausted",
                ));
            };
            let mut inbound = self
                .inbound
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            match inbound.book.register(operation_id) {
                Ok(()) => {
                    inbound.responders.insert(operation_id, responder);
                    return Ok(operation_id);
                }
                Err(RegisterError::Duplicate) => continue,
                Err(RegisterError::Capacity) => {
                    return Err(PipeError::new(
                        PipeErrorCode::Capacity,
                        "inbound operation capacity is exhausted",
                    ));
                }
            }
        }
        Err(PipeError::new(
            PipeErrorCode::Capacity,
            "inbound operation id allocation failed",
        ))
    }

    fn expire_inbound(&self, operation_id: u32) {
        let mut inbound = self
            .inbound
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        inbound.responders.remove(&operation_id);
        inbound.book.complete(operation_id);
    }
}

impl InboundHandler for BrokerInner {
    fn handle_inbound(
        &self,
        sender_instance_id: String,
        peer_frame: Vec<u8>,
        deadline: Instant,
    ) -> Result<Vec<u8>, PipeError> {
        if self.stopping.load(Ordering::Acquire) {
            return Err(PipeError::new(
                PipeErrorCode::ShuttingDown,
                "peer broker is shutting down",
            ));
        }
        let (response_sender, response_receiver) = mpsc::sync_channel(1);
        let operation_id = self.allocate_inbound(response_sender)?;
        let payload = encode_inbound_request(&sender_instance_id, &peer_frame).map_err(|_| {
            PipeError::new(
                PipeErrorCode::ProtocolMismatch,
                "inbound request encoding failed",
            )
        })?;
        if self
            .output
            .send(INBOUND_REQUEST, operation_id, payload)
            .is_err()
        {
            self.expire_inbound(operation_id);
            return Err(PipeError::new(PipeErrorCode::Io, "control output failed"));
        }

        loop {
            if self.force_shutdown.is_signaled() {
                self.expire_inbound(operation_id);
                return Err(PipeError::new(
                    PipeErrorCode::ShuttingDown,
                    "peer broker is shutting down",
                ));
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                self.expire_inbound(operation_id);
                return Err(PipeError::new(
                    PipeErrorCode::Timeout,
                    "inbound peer request timed out",
                ));
            }
            match response_receiver.recv_timeout(remaining.min(Duration::from_millis(50))) {
                Ok(response) => return Ok(response),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    self.expire_inbound(operation_id);
                    return Err(PipeError::new(
                        PipeErrorCode::Io,
                        "inbound response channel closed",
                    ));
                }
            }
        }
    }

    fn server_fatal(&self, error: PipeError) {
        let code = if error.code == PipeErrorCode::SecurityContextLost {
            "PEER_WINDOWS_BROKER_SECURITY_STATE"
        } else {
            "PEER_WINDOWS_PIPE_CREATE_FAILED"
        };
        self.report_fatal(code, &error.sanitized_message());
    }
}

struct WorkerGuard(Arc<BrokerInner>);

impl Drop for WorkerGuard {
    fn drop(&mut self) {
        self.0.worker_count.fetch_sub(1, Ordering::AcqRel);
    }
}

fn pipe_operation_error(error: &PipeError) -> (&'static str, String) {
    let code = match error.code {
        PipeErrorCode::Timeout => "PEER_WINDOWS_REQUEST_TIMEOUT",
        PipeErrorCode::Canceled => "PEER_WINDOWS_OPERATION_CANCELED",
        PipeErrorCode::TargetUnavailable => "PEER_WINDOWS_TARGET_UNAVAILABLE",
        PipeErrorCode::IdentityUnverified => "PEER_WINDOWS_PEER_IDENTITY_UNVERIFIED",
        PipeErrorCode::AuthenticationFailed => "PEER_WINDOWS_AUTHENTICATION_FAILED",
        PipeErrorCode::ProtocolMismatch => "PEER_WINDOWS_HELPER_PROTOCOL_MISMATCH",
        PipeErrorCode::Capacity => "PEER_WINDOWS_OPERATION_CAPACITY",
        PipeErrorCode::ShuttingDown => "PEER_WINDOWS_BROKER_EXITED",
        PipeErrorCode::SecurityContextLost => "PEER_WINDOWS_BROKER_SECURITY_STATE",
        PipeErrorCode::Io => "PEER_WINDOWS_PIPE_IO_FAILED",
    };
    (code, error.sanitized_message())
}

pub fn sanitize_message(message: &str) -> String {
    message
        .chars()
        .filter(|character| !character.is_control())
        .take(512)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_capacity_is_released_on_completion() {
        let mut book = OperationBook::new(2);
        book.register(1).unwrap();
        assert_eq!(book.register(1), Err(RegisterError::Duplicate));
        book.register(2).unwrap();
        assert_eq!(book.register(3), Err(RegisterError::Capacity));
        assert!(book.contains(1));
        assert!(book.complete(1));
        book.register(3).unwrap();
        assert!(!book.complete(1));
        assert!(book.complete(2));
        assert!(book.complete(3));
        assert_eq!(book.active_len(), 0);
    }

    #[test]
    fn rapid_successes_do_not_exhaust_active_capacity() {
        let mut book = OperationBook::new(256);
        for operation_id in 1..=300 {
            book.register(operation_id).unwrap();
            assert!(book.complete(operation_id));
        }
        assert_eq!(book.active_len(), 0);
    }

    #[test]
    fn operation_ids_stop_before_wrapping() {
        let next = AtomicU32::new(u32::MAX - 1);
        assert_eq!(take_operation_id(&next), Some(u32::MAX - 1));
        assert_eq!(take_operation_id(&next), None);
        assert_eq!(take_operation_id(&next), None);
    }
}
