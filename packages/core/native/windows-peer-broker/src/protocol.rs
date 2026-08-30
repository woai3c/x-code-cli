use std::fmt;

pub const PROTOCOL_VERSION: u8 = 2;
pub const HEADER_BYTES: usize = 16;
pub const MAX_CONTROL_PAYLOAD: usize = 139_264;
pub const MAX_PEER_FRAME_BYTES: usize = 131_072;
pub const MAX_ACTIVE_OPERATIONS: usize = 256;
pub const MAX_RUNTIME_ROOT_BYTES: usize = u16::MAX as usize;
pub const MAX_TIMEOUT_MS: u32 = 120_000;
pub const INBOX_TOKEN_BYTES: usize = 43;

const MAGIC: &[u8; 4] = b"XCPB";

pub const SECURE_RUNTIME: u8 = 0x01;
pub const START_SERVER: u8 = 0x02;
pub const OUTBOUND_REQUEST: u8 = 0x03;
pub const INBOUND_RESPONSE: u8 = 0x04;
pub const CANCEL_OPERATION: u8 = 0x05;
pub const SHUTDOWN: u8 = 0x06;

pub const SECURE_RUNTIME_RESULT: u8 = 0x81;
pub const SERVER_READY: u8 = 0x82;
pub const INBOUND_REQUEST: u8 = 0x83;
pub const OUTBOUND_RESPONSE: u8 = 0x84;
pub const OPERATION_ERROR: u8 = 0x86;
pub const SERVER_FATAL: u8 = 0x87;
pub const SHUTDOWN_COMPLETE: u8 = 0x88;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtocolError(&'static str);

impl ProtocolError {
    pub const fn new(message: &'static str) -> Self {
        Self(message)
    }
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.0)
    }
}

impl std::error::Error for ProtocolError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub kind: u8,
    pub operation_id: u32,
    pub payload: Vec<u8>,
}

impl Frame {
    pub fn encode(&self) -> Result<Vec<u8>, ProtocolError> {
        if !is_known_kind(self.kind) {
            return Err(ProtocolError::new("unknown frame kind"));
        }
        if self.payload.len() > MAX_CONTROL_PAYLOAD {
            return Err(ProtocolError::new("control payload exceeds limit"));
        }
        let mut bytes = Vec::with_capacity(HEADER_BYTES + self.payload.len());
        bytes.extend_from_slice(MAGIC);
        bytes.push(PROTOCOL_VERSION);
        bytes.push(self.kind);
        bytes.extend_from_slice(&0u16.to_le_bytes());
        bytes.extend_from_slice(&self.operation_id.to_le_bytes());
        bytes.extend_from_slice(&(self.payload.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&self.payload);
        Ok(bytes)
    }
}

pub struct FrameDecoder {
    buffer: Vec<u8>,
    expected: Option<usize>,
}

impl FrameDecoder {
    pub fn new() -> Self {
        Self {
            buffer: Vec::with_capacity(HEADER_BYTES),
            expected: None,
        }
    }

    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Frame>, ProtocolError> {
        let mut frames = Vec::new();
        for &byte in chunk {
            self.buffer.push(byte);
            if self.buffer.len() == HEADER_BYTES {
                self.expected = Some(parse_header(&self.buffer)?);
            }
            if self.expected == Some(self.buffer.len()) {
                frames.push(decode_complete_frame(&self.buffer)?);
                self.buffer.clear();
                self.expected = None;
            }
        }
        Ok(frames)
    }

    pub fn finish(&self) -> Result<(), ProtocolError> {
        if self.buffer.is_empty() {
            Ok(())
        } else {
            Err(ProtocolError::new("truncated control frame"))
        }
    }
}

fn parse_header(header: &[u8]) -> Result<usize, ProtocolError> {
    if header.len() != HEADER_BYTES || &header[0..4] != MAGIC {
        return Err(ProtocolError::new("invalid control magic"));
    }
    if header[4] != PROTOCOL_VERSION {
        return Err(ProtocolError::new("unsupported control version"));
    }
    if !is_known_kind(header[5]) {
        return Err(ProtocolError::new("unknown frame kind"));
    }
    if u16::from_le_bytes(header[6..8].try_into().expect("fixed header")) != 0 {
        return Err(ProtocolError::new("unsupported control flags"));
    }
    let payload_length =
        u32::from_le_bytes(header[12..16].try_into().expect("fixed header")) as usize;
    if payload_length > MAX_CONTROL_PAYLOAD {
        return Err(ProtocolError::new("control payload exceeds limit"));
    }
    Ok(HEADER_BYTES + payload_length)
}

fn decode_complete_frame(bytes: &[u8]) -> Result<Frame, ProtocolError> {
    let expected = parse_header(&bytes[..HEADER_BYTES])?;
    if expected != bytes.len() {
        return Err(ProtocolError::new("invalid complete frame length"));
    }
    Ok(Frame {
        kind: bytes[5],
        operation_id: u32::from_le_bytes(bytes[8..12].try_into().expect("fixed header")),
        payload: bytes[HEADER_BYTES..].to_vec(),
    })
}

fn is_known_kind(kind: u8) -> bool {
    matches!(
        kind,
        SECURE_RUNTIME
            | START_SERVER
            | OUTBOUND_REQUEST
            | INBOUND_RESPONSE
            | CANCEL_OPERATION
            | SHUTDOWN
            | SECURE_RUNTIME_RESULT
            | SERVER_READY
            | INBOUND_REQUEST
            | OUTBOUND_RESPONSE
            | OPERATION_ERROR
            | SERVER_FATAL
            | SHUTDOWN_COMPLETE
    )
}

pub fn validate_node_frame(frame: &Frame, secure_runtime_mode: bool) -> Result<(), ProtocolError> {
    if frame.operation_id == 0 {
        return Err(ProtocolError::new("request operation id must be nonzero"));
    }
    let allowed = if secure_runtime_mode {
        frame.kind == SECURE_RUNTIME
    } else {
        matches!(
            frame.kind,
            START_SERVER | OUTBOUND_REQUEST | INBOUND_RESPONSE | CANCEL_OPERATION | SHUTDOWN
        )
    };
    if !allowed {
        return Err(ProtocolError::new("frame kind is invalid in this mode"));
    }
    if matches!(frame.kind, CANCEL_OPERATION | SHUTDOWN) && !frame.payload.is_empty() {
        return Err(ProtocolError::new("control request payload must be empty"));
    }
    Ok(())
}

struct PayloadCursor<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> PayloadCursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8], ProtocolError> {
        let end = self
            .offset
            .checked_add(length)
            .ok_or_else(|| ProtocolError::new("payload length overflow"))?;
        if end > self.bytes.len() {
            return Err(ProtocolError::new("truncated control payload"));
        }
        let value = &self.bytes[self.offset..end];
        self.offset = end;
        Ok(value)
    }

    fn string(&mut self) -> Result<String, ProtocolError> {
        let length = u16::from_le_bytes(
            self.take(2)?
                .try_into()
                .expect("u16 prefix has fixed length"),
        ) as usize;
        let bytes = self.take(length)?;
        std::str::from_utf8(bytes)
            .map(str::to_owned)
            .map_err(|_| ProtocolError::new("control string is not UTF-8"))
    }

    fn bytes(&mut self, maximum: usize) -> Result<Vec<u8>, ProtocolError> {
        let length = u32::from_le_bytes(
            self.take(4)?
                .try_into()
                .expect("u32 prefix has fixed length"),
        ) as usize;
        if length > maximum {
            return Err(ProtocolError::new("control byte array exceeds limit"));
        }
        Ok(self.take(length)?.to_vec())
    }

    fn u32(&mut self) -> Result<u32, ProtocolError> {
        Ok(u32::from_le_bytes(
            self.take(4)?.try_into().expect("u32 has fixed length"),
        ))
    }

    fn finish(self) -> Result<(), ProtocolError> {
        if self.offset == self.bytes.len() {
            Ok(())
        } else {
            Err(ProtocolError::new("unexpected control payload suffix"))
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecureRuntimeRequest {
    pub root: String,
}

pub fn parse_secure_runtime(payload: &[u8]) -> Result<SecureRuntimeRequest, ProtocolError> {
    let mut cursor = PayloadCursor::new(payload);
    let root = cursor.string()?;
    if root.is_empty() || root.len() > MAX_RUNTIME_ROOT_BYTES {
        return Err(ProtocolError::new("runtime root length is invalid"));
    }
    cursor.finish()?;
    Ok(SecureRuntimeRequest { root })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartServerRequest {
    pub namespace_id: String,
    pub instance_id: String,
    pub inbox_token: String,
}

pub fn parse_start_server(payload: &[u8]) -> Result<StartServerRequest, ProtocolError> {
    let mut cursor = PayloadCursor::new(payload);
    let request = StartServerRequest {
        namespace_id: cursor.string()?,
        instance_id: cursor.string()?,
        inbox_token: cursor.string()?,
    };
    cursor.finish()?;
    if !valid_namespace_id(&request.namespace_id) {
        return Err(ProtocolError::new("namespace id is invalid"));
    }
    if !valid_instance_id(&request.instance_id) {
        return Err(ProtocolError::new("instance id is invalid"));
    }
    if !valid_inbox_token(&request.inbox_token) {
        return Err(ProtocolError::new("inbox token is invalid"));
    }
    Ok(request)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutboundRequest {
    pub address: String,
    pub target_token: String,
    pub sender_instance_id: String,
    pub timeout_ms: u32,
    pub peer_frame: Vec<u8>,
}

pub fn parse_outbound_request(payload: &[u8]) -> Result<OutboundRequest, ProtocolError> {
    let mut cursor = PayloadCursor::new(payload);
    let request = OutboundRequest {
        address: cursor.string()?,
        target_token: cursor.string()?,
        sender_instance_id: cursor.string()?,
        timeout_ms: cursor.u32()?,
        peer_frame: cursor.bytes(MAX_PEER_FRAME_BYTES)?,
    };
    cursor.finish()?;
    if !valid_pipe_name_shape(&request.address, None) {
        return Err(ProtocolError::new("pipe address is invalid"));
    }
    if !valid_inbox_token(&request.target_token) {
        return Err(ProtocolError::new("target token is invalid"));
    }
    if !valid_instance_id(&request.sender_instance_id) {
        return Err(ProtocolError::new("sender instance id is invalid"));
    }
    if request.timeout_ms == 0 || request.timeout_ms > MAX_TIMEOUT_MS {
        return Err(ProtocolError::new("outbound timeout is invalid"));
    }
    if request.peer_frame.is_empty() {
        return Err(ProtocolError::new("peer frame is empty"));
    }
    Ok(request)
}

pub fn parse_peer_frame_payload(payload: &[u8]) -> Result<Vec<u8>, ProtocolError> {
    let mut cursor = PayloadCursor::new(payload);
    let frame = cursor.bytes(MAX_PEER_FRAME_BYTES)?;
    cursor.finish()?;
    if frame.is_empty() {
        return Err(ProtocolError::new("peer frame is empty"));
    }
    Ok(frame)
}

fn push_string(output: &mut Vec<u8>, value: &str) -> Result<(), ProtocolError> {
    let length = u16::try_from(value.len())
        .map_err(|_| ProtocolError::new("control string exceeds u16 limit"))?;
    output.extend_from_slice(&length.to_le_bytes());
    output.extend_from_slice(value.as_bytes());
    Ok(())
}

fn push_bytes(output: &mut Vec<u8>, value: &[u8]) -> Result<(), ProtocolError> {
    if value.len() > MAX_PEER_FRAME_BYTES {
        return Err(ProtocolError::new("peer frame exceeds limit"));
    }
    output.extend_from_slice(&(value.len() as u32).to_le_bytes());
    output.extend_from_slice(value);
    Ok(())
}

pub fn encode_one_string(value: &str) -> Result<Vec<u8>, ProtocolError> {
    let mut output = Vec::with_capacity(2 + value.len());
    push_string(&mut output, value)?;
    Ok(output)
}

pub fn encode_peer_frame(value: &[u8]) -> Result<Vec<u8>, ProtocolError> {
    let mut output = Vec::with_capacity(4 + value.len());
    push_bytes(&mut output, value)?;
    Ok(output)
}

pub fn encode_inbound_request(
    sender_instance_id: &str,
    peer_frame: &[u8],
) -> Result<Vec<u8>, ProtocolError> {
    if !valid_instance_id(sender_instance_id) {
        return Err(ProtocolError::new("sender instance id is invalid"));
    }
    let mut output = Vec::with_capacity(2 + sender_instance_id.len() + 4 + peer_frame.len());
    push_string(&mut output, sender_instance_id)?;
    push_bytes(&mut output, peer_frame)?;
    Ok(output)
}

pub fn encode_error(code: &str, message: &str) -> Result<Vec<u8>, ProtocolError> {
    if code.is_empty()
        || code.len() > 64
        || !code
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte == b'_')
    {
        return Err(ProtocolError::new("error code is invalid"));
    }
    if message.len() > 512 {
        return Err(ProtocolError::new("error message exceeds limit"));
    }
    let mut output = Vec::with_capacity(4 + code.len() + message.len());
    push_string(&mut output, code)?;
    push_string(&mut output, message)?;
    Ok(output)
}

pub fn valid_namespace_id(value: &str) -> bool {
    value.len() == 12
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub fn valid_instance_id(value: &str) -> bool {
    if value.len() != 36 {
        return false;
    }
    value.bytes().enumerate().all(|(index, byte)| {
        if matches!(index, 8 | 13 | 18 | 23) {
            byte == b'-'
        } else {
            byte.is_ascii_hexdigit()
        }
    })
}

pub fn valid_inbox_token(value: &str) -> bool {
    value.len() == INBOX_TOKEN_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

pub fn valid_pipe_name_shape(value: &str, expected_namespace: Option<&str>) -> bool {
    const PREFIX: &str = r"\\.\pipe\x-code-peer-v2-";
    let Some(suffix) = value.strip_prefix(PREFIX) else {
        return false;
    };
    let Some((namespace, random)) = suffix.split_once('-') else {
        return false;
    };
    valid_namespace_id(namespace)
        && expected_namespace.is_none_or(|expected| expected == namespace)
        && random.len() == 32
        && random
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(kind: u8, operation_id: u32, payload: &[u8]) -> Vec<u8> {
        Frame {
            kind,
            operation_id,
            payload: payload.to_vec(),
        }
        .encode()
        .unwrap()
    }

    #[test]
    fn decoder_handles_every_chunk_boundary_and_merged_frames() {
        let first = frame(START_SERVER, 7, b"alpha");
        let second = frame(SHUTDOWN, 9, &[]);
        let joined = [first.as_slice(), second.as_slice()].concat();

        for split in 0..=joined.len() {
            let mut decoder = FrameDecoder::new();
            let mut decoded = decoder.push(&joined[..split]).unwrap();
            decoded.extend(decoder.push(&joined[split..]).unwrap());
            decoder.finish().unwrap();
            assert_eq!(decoded.len(), 2);
            assert_eq!(decoded[0].operation_id, 7);
            assert_eq!(decoded[1].kind, SHUTDOWN);
        }
    }

    #[test]
    fn decoder_rejects_truncation_unknown_flags_and_oversize_before_payload() {
        let bytes = frame(SHUTDOWN, 1, &[]);
        let mut truncated = FrameDecoder::new();
        truncated.push(&bytes[..HEADER_BYTES - 1]).unwrap();
        assert_eq!(
            truncated.finish().unwrap_err().to_string(),
            "truncated control frame"
        );

        let mut flags = bytes.clone();
        flags[6] = 1;
        assert!(FrameDecoder::new().push(&flags).is_err());

        let mut oversized = bytes;
        oversized[12..16].copy_from_slice(&((MAX_CONTROL_PAYLOAD + 1) as u32).to_le_bytes());
        assert!(FrameDecoder::new().push(&oversized).is_err());
    }

    #[test]
    fn payload_cursor_rejects_bad_utf8_truncation_suffix_and_peer_bounds() {
        assert!(parse_secure_runtime(&[1, 0, 0xff]).is_err());
        assert!(parse_secure_runtime(&[4, 0, b'a']).is_err());
        assert!(parse_secure_runtime(&[1, 0, b'a', 0]).is_err());

        let mut oversized = Vec::new();
        oversized.extend_from_slice(&((MAX_PEER_FRAME_BYTES + 1) as u32).to_le_bytes());
        assert!(parse_peer_frame_payload(&oversized).is_err());
    }

    #[test]
    fn validators_lock_pipe_token_and_instance_shapes() {
        let namespace = "012345abcdef";
        let random = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
        let name = format!(r"\\.\pipe\x-code-peer-v2-{namespace}-{random}");
        assert!(valid_pipe_name_shape(&name, Some(namespace)));
        assert!(!valid_pipe_name_shape(&name, Some("fedcba543210")));
        assert!(!valid_pipe_name_shape(
            r"\\.\pipe\x-code-peer-v2-012345abcdef-../../bad",
            None
        ));
        assert!(valid_inbox_token(&"A".repeat(INBOX_TOKEN_BYTES)));
        assert!(!valid_inbox_token(&"A".repeat(INBOX_TOKEN_BYTES - 1)));
        assert!(valid_instance_id("550e8400-e29b-41d4-a716-446655440000"));
        assert!(!valid_instance_id("550e8400/e29b/41d4/a716/446655440000"));
    }

    #[test]
    fn control_payload_maximum_is_exact() {
        assert_eq!(MAX_CONTROL_PAYLOAD, 139_264);
        assert_eq!(MAX_PEER_FRAME_BYTES, 131_072);
        let maximum = Frame {
            kind: OPERATION_ERROR,
            operation_id: 1,
            payload: vec![0; MAX_CONTROL_PAYLOAD],
        };
        assert_eq!(
            maximum.encode().unwrap().len(),
            HEADER_BYTES + MAX_CONTROL_PAYLOAD
        );
        let too_large = Frame {
            payload: vec![0; MAX_CONTROL_PAYLOAD + 1],
            ..maximum
        };
        assert!(too_large.encode().is_err());
    }
}
