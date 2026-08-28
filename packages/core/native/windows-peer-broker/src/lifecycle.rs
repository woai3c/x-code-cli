use std::collections::{HashMap, VecDeque};
use std::io::{self, Write};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use crate::pipe::{
    InboundHandler, OutboundPipeRequest, PipeError, PipeErrorCode, PipeServer, ServerConfig,
    outbound_request,
};
use crate::process_peer::current_process_identity;
use crate::protocol::{
    CANCEL_ACK, CANCEL_OPERATION, Frame, INBOUND_REQUEST, INBOUND_RESPONSE, INBOX_TOKEN_BYTES,
    MAX_ACTIVE_OPERATIONS, OPERATION_ERROR, OUTBOUND_REQUEST, OUTBOUND_RESPONSE, SERVER_FATAL,
    SERVER_READY, SHUTDOWN, SHUTDOWN_COMPLETE, START_SERVER, encode_error, encode_inbound_request,
    encode_one_string, encode_peer_frame, parse_outbound_request, parse_peer_frame_payload,
    parse_start_server, valid_pipe_name_shape,
};
use crate::security::{Event, ProcessIdentity};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegisterError {
    Duplicate,
    Capacity,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CancelDecision {
    Canceled,
    TooLate,
    Unknown,
}

#[derive(Debug)]
struct ActiveOperation {
    cancel_acknowledged: bool,
}

#[derive(Debug)]
pub struct OperationBook {
    active: HashMap<u32, ActiveOperation>,
    tombstones: VecDeque<(u32, Instant)>,
    capacity: usize,
    tombstone_ttl: Duration,
}

impl OperationBook {
    pub fn new(capacity: usize, tombstone_ttl: Duration) -> Self {
        Self {
            active: HashMap::new(),
            tombstones: VecDeque::new(),
            capacity,
            tombstone_ttl,
        }
    }

    pub fn register(&mut self, operation_id: u32, now: Instant) -> Result<(), RegisterError> {
        self.purge(now);
        if self.active.contains_key(&operation_id)
            || self
                .tombstones
                .iter()
                .any(|(existing, _)| *existing == operation_id)
        {
            return Err(RegisterError::Duplicate);
        }
        if operation_id == 0 || self.active.len() + self.tombstones.len() >= self.capacity {
            return Err(RegisterError::Capacity);
        }
        self.active.insert(
            operation_id,
            ActiveOperation {
                cancel_acknowledged: false,
            },
        );
        Ok(())
    }

    pub fn cancel(&mut self, operation_id: u32, now: Instant) -> CancelDecision {
        self.purge(now);
        if let Some(operation) = self.active.get_mut(&operation_id) {
            operation.cancel_acknowledged = true;
            CancelDecision::Canceled
        } else if self
            .tombstones
            .iter()
            .any(|(existing, _)| *existing == operation_id)
        {
            CancelDecision::TooLate
        } else {
            CancelDecision::Unknown
        }
    }

    pub fn complete(&mut self, operation_id: u32, now: Instant) -> bool {
        self.purge(now);
        if self.active.remove(&operation_id).is_none() {
            return false;
        }
        self.tombstones.push_back((operation_id, now));
        true
    }

    #[cfg(test)]
    pub fn is_cancel_acknowledged(&self, operation_id: u32) -> bool {
        self.active
            .get(&operation_id)
            .is_some_and(|operation| operation.cancel_acknowledged)
    }

    pub fn is_tombstone(&mut self, operation_id: u32, now: Instant) -> bool {
        self.purge(now);
        self.tombstones
            .iter()
            .any(|(existing, _)| *existing == operation_id)
    }

    #[cfg(test)]
    pub fn active_len(&self) -> usize {
        self.active.len()
    }

    fn purge(&mut self, now: Instant) {
        while self.tombstones.front().is_some_and(|(_, completed)| {
            now.saturating_duration_since(*completed) >= self.tombstone_ttl
        }) {
            self.tombstones.pop_front();
        }
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
    completion_order: Mutex<()>,
    next_inbound_id: AtomicU32,
    worker_count: AtomicUsize,
}

#[derive(Clone)]
pub struct Broker {
    inner: Arc<BrokerInner>,
}

impl Broker {
    pub fn new(output: Arc<ControlOutput>) -> io::Result<Self> {
        let identity = current_process_identity()?;
        let force_shutdown = Event::manual_reset()?;
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
                    book: OperationBook::new(MAX_ACTIVE_OPERATIONS, Duration::from_secs(5)),
                    cancel_events: HashMap::new(),
                }),
                inbound: Mutex::new(InboundState {
                    book: OperationBook::new(MAX_ACTIVE_OPERATIONS, Duration::from_secs(5)),
                    responders: HashMap::new(),
                }),
                completion_order: Mutex::new(()),
                next_inbound_id: AtomicU32::new(0x8000_0000),
                worker_count: AtomicUsize::new(0),
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
                self.cancel_outbound(frame.operation_id)?;
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
            match outbound.book.register(operation_id, Instant::now()) {
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
        inner.worker_count.fetch_add(1, Ordering::AcqRel);
        let spawn_result = thread::Builder::new()
            .name("xc-peer-outbound".to_owned())
            .spawn(move || {
                let _guard = WorkerGuard(inner.clone());
                let deadline = Instant::now() + Duration::from_millis(request.timeout_ms as u64);
                let result = outbound_request(OutboundPipeRequest {
                    address: &request.address,
                    target_token: &target_token,
                    sender_instance_id: &request.sender_instance_id,
                    peer_frame: &request.peer_frame,
                    identity: &inner.identity,
                    deadline,
                    cancel: &cancel,
                    force_shutdown: &inner.force_shutdown,
                });
                inner.finish_outbound(operation_id, result);
            });
        if spawn_result.is_err() {
            self.inner.worker_count.fetch_sub(1, Ordering::AcqRel);
            let mut outbound = self
                .inner
                .outbound
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            outbound.cancel_events.remove(&operation_id);
            outbound.book.complete(operation_id, Instant::now());
            drop(outbound);
            self.send_operation_error(
                operation_id,
                "PEER_WINDOWS_OPERATION_CAPACITY",
                "peer broker could not create an outbound worker",
            )?;
        }
        Ok(())
    }

    fn cancel_outbound(&self, operation_id: u32) -> Result<(), &'static str> {
        let _order = self
            .inner
            .completion_order
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let decision = {
            let mut outbound = self
                .inner
                .outbound
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let decision = outbound.book.cancel(operation_id, Instant::now());
            if decision == CancelDecision::Canceled
                && let Some(cancel) = outbound.cancel_events.get(&operation_id)
            {
                let _ = cancel.signal();
            }
            decision
        };
        let status = match decision {
            CancelDecision::Canceled => 0,
            CancelDecision::TooLate | CancelDecision::Unknown => 1,
        };
        self.inner
            .output
            .send(CANCEL_ACK, operation_id, vec![status])
            .map_err(|_| "control output failed")
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
            if let Some(responder) = inbound.responders.remove(&operation_id) {
                if !inbound.book.complete(operation_id, Instant::now()) {
                    return Err("inbound operation ownership is invalid");
                }
                Some(responder)
            } else if inbound.book.is_tombstone(operation_id, Instant::now()) {
                None
            } else {
                return Err("response references an unknown operation id");
            }
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
        let _order = self
            .completion_order
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
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
        if !outbound.book.complete(operation_id, Instant::now()) {
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
            let operation_id = self.next_inbound_id.fetch_add(1, Ordering::Relaxed);
            if operation_id == 0 {
                continue;
            }
            let mut inbound = self
                .inbound
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            match inbound.book.register(operation_id, Instant::now()) {
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
        inbound.book.complete(operation_id, Instant::now());
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
        self.report_fatal(
            "PEER_WINDOWS_PIPE_CREATE_FAILED",
            &error.sanitized_message(),
        );
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
    fn cancel_ack_precedes_terminal_ownership_release() {
        let now = Instant::now();
        let mut book = OperationBook::new(4, Duration::from_secs(30));
        book.register(7, now).unwrap();
        assert_eq!(book.cancel(7, now), CancelDecision::Canceled);
        assert!(book.is_cancel_acknowledged(7));
        assert_eq!(book.active_len(), 1);
        assert!(book.complete(7, now));
        assert_eq!(book.active_len(), 0);
        assert_eq!(book.cancel(7, now), CancelDecision::TooLate);
    }

    #[test]
    fn duplicate_capacity_unknown_and_ttl_are_bounded() {
        let now = Instant::now();
        let mut book = OperationBook::new(2, Duration::from_secs(1));
        book.register(1, now).unwrap();
        assert_eq!(book.register(1, now), Err(RegisterError::Duplicate));
        book.register(2, now).unwrap();
        assert_eq!(book.register(3, now), Err(RegisterError::Capacity));
        assert!(book.complete(1, now));
        assert_eq!(book.register(3, now), Err(RegisterError::Capacity));
        assert_eq!(book.cancel(99, now), CancelDecision::Unknown);

        let later = now + Duration::from_secs(2);
        book.register(3, later).unwrap();
        assert_eq!(book.cancel(1, later), CancelDecision::Unknown);
    }
}
