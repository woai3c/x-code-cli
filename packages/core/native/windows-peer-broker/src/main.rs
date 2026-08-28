#![cfg_attr(not(windows), allow(dead_code, unused_imports))]

#[cfg(windows)]
mod lifecycle;
#[cfg(windows)]
mod pipe;
#[cfg(windows)]
mod process_peer;
#[cfg(windows)]
mod protocol;
#[cfg(windows)]
mod runtime_acl;
#[cfg(windows)]
mod security;

#[cfg(not(windows))]
fn main() {
    eprintln!("xc-peer-broker is only supported on Windows");
    std::process::exit(1);
}

#[cfg(windows)]
mod windows_broker {
    use std::io::{self, Read};
    use std::sync::{Arc, mpsc};
    use std::thread;
    use std::time::Duration;

    use crate::lifecycle::{Broker, ControlOutput, sanitize_message};
    use crate::process_peer::current_process_identity;
    use crate::protocol::{
        Frame, FrameDecoder, OPERATION_ERROR, SECURE_RUNTIME_RESULT, encode_error,
        encode_one_string, parse_secure_runtime, validate_node_frame,
    };
    use crate::runtime_acl::secure_runtime;

    pub fn run() -> io::Result<()> {
        let mut arguments = std::env::args().skip(1);
        let mode = arguments.next().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "broker mode is required")
        })?;
        if arguments.next().as_deref() != Some("--protocol")
            || arguments.next().as_deref() != Some("1")
            || arguments.next().is_some()
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "expected --protocol 1",
            ));
        }
        match mode.as_str() {
            "secure-runtime" => run_secure_runtime(),
            "broker" => run_broker(),
            "self-test" => run_self_test(),
            _ => Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "unknown broker mode",
            )),
        }
    }

    fn run_secure_runtime() -> io::Result<()> {
        let frame = read_one_frame()?;
        validate_node_frame(&frame, true)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        let output = ControlOutput::new(io::stdout());
        let result = parse_secure_runtime(&frame.payload)
            .map_err(|_| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    "secure-runtime payload is invalid",
                )
            })
            .and_then(|request| {
                let identity = current_process_identity()?;
                secure_runtime(&request.root, &identity)
            });
        match result {
            Ok(namespace_id) => {
                let payload = encode_one_string(&namespace_id)
                    .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
                output.send(SECURE_RUNTIME_RESULT, frame.operation_id, payload)
            }
            Err(error) => {
                let message = sanitize_message(&format!(
                    "Windows peer runtime security check failed: {error}{}",
                    error
                        .raw_os_error()
                        .map(|code| format!(" (Windows error {code})"))
                        .unwrap_or_default()
                ));
                let payload = encode_error("PEER_WINDOWS_RUNTIME_UNSAFE", &message)
                    .map_err(|codec| io::Error::new(io::ErrorKind::InvalidData, codec))?;
                output.send(OPERATION_ERROR, frame.operation_id, payload)?;
                Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "Windows peer runtime is unsafe",
                ))
            }
        }
    }

    fn read_one_frame() -> io::Result<Frame> {
        let mut decoder = FrameDecoder::new();
        let mut input = io::stdin().lock();
        let mut buffer = [0u8; 8192];
        loop {
            let read = input.read(&mut buffer)?;
            if read == 0 {
                decoder
                    .finish()
                    .map_err(|error| io::Error::new(io::ErrorKind::UnexpectedEof, error))?;
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "stdin closed before a request frame",
                ));
            }
            let frames = decoder
                .push(&buffer[..read])
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
            if frames.len() > 1 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "secure-runtime accepts exactly one frame",
                ));
            }
            if let Some(frame) = frames.into_iter().next() {
                decoder
                    .finish()
                    .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
                return Ok(frame);
            }
        }
    }

    enum InputEvent {
        Frame(Frame),
        Eof,
        ProtocolError,
    }

    fn spawn_control_reader() -> io::Result<mpsc::Receiver<InputEvent>> {
        let (sender, receiver) = mpsc::sync_channel(32);
        thread::Builder::new()
            .name("xc-peer-control-reader".to_owned())
            .spawn(move || {
                let mut decoder = FrameDecoder::new();
                let mut input = io::stdin().lock();
                let mut buffer = [0u8; 8192];
                loop {
                    match input.read(&mut buffer) {
                        Ok(0) => {
                            let event = if decoder.finish().is_ok() {
                                InputEvent::Eof
                            } else {
                                InputEvent::ProtocolError
                            };
                            let _ = sender.send(event);
                            return;
                        }
                        Ok(read) => match decoder.push(&buffer[..read]) {
                            Ok(frames) => {
                                for frame in frames {
                                    if sender.send(InputEvent::Frame(frame)).is_err() {
                                        return;
                                    }
                                }
                            }
                            Err(_) => {
                                let _ = sender.send(InputEvent::ProtocolError);
                                return;
                            }
                        },
                        Err(_) => {
                            let _ = sender.send(InputEvent::Eof);
                            return;
                        }
                    }
                }
            })
            .map(|_| receiver)
    }

    fn run_self_test() -> io::Result<()> {
        let identity = current_process_identity()?;
        crate::pipe::self_test(&identity).map_err(io::Error::other)
    }

    fn run_broker() -> io::Result<()> {
        let output = Arc::new(ControlOutput::new(io::stdout()));
        let broker = Broker::new(output)?;
        let input = spawn_control_reader()?;
        loop {
            if broker.is_fatal() {
                broker.force_shutdown();
                return Err(io::Error::other("peer broker entered a fatal state"));
            }
            match input.recv_timeout(Duration::from_millis(50)) {
                Ok(InputEvent::Frame(frame)) => {
                    if validate_node_frame(&frame, false).is_err() {
                        broker.protocol_fatal("invalid Node control frame");
                        continue;
                    }
                    match broker.handle_frame(frame) {
                        Ok(true) => return Ok(()),
                        Ok(false) => {}
                        Err(message) => broker.protocol_fatal(message),
                    }
                }
                Ok(InputEvent::Eof) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                    broker.force_shutdown();
                    return Ok(());
                }
                Ok(InputEvent::ProtocolError) => {
                    broker.protocol_fatal("malformed or truncated Node control frame");
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        }
    }
}

#[cfg(windows)]
fn main() {
    if let Err(error) = windows_broker::run() {
        let message: String = error
            .to_string()
            .chars()
            .filter(|character| !character.is_control())
            .take(512)
            .collect();
        eprintln!("xc-peer-broker: {message}");
        std::process::exit(1);
    }
}
