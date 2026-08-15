#![cfg_attr(not(windows), allow(dead_code, unused_imports))]

#[cfg(not(windows))]
fn main() {
    eprintln!("xc-shell-supervisor is only supported on Windows");
    std::process::exit(1);
}

#[cfg(windows)]
mod windows_supervisor {
    use std::ffi::{OsStr, c_void};
    use std::fs::{File, OpenOptions};
    use std::io::{self, Read, Write};
    use std::mem::{size_of, zeroed};
    use std::os::windows::io::{FromRawHandle, RawHandle};
    use std::path::Path;
    use std::ptr::{null, null_mut};
    use std::sync::{Arc, Mutex, mpsc};
    use std::thread;
    use std::time::Duration;

    use windows_sys::Win32::Foundation::{
        CloseHandle, HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE, SetHandleInformation,
        WAIT_OBJECT_0,
    };
    use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
    use windows_sys::Win32::System::Console::{
        CTRL_BREAK_EVENT, GenerateConsoleCtrlEvent, SetConsoleCtrlHandler,
    };
    use windows_sys::Win32::System::IO::{CreateIoCompletionPort, GetQueuedCompletionStatus};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_ASSOCIATE_COMPLETION_PORT, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JobObjectAssociateCompletionPortInformation, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject,
    };
    use windows_sys::Win32::System::Pipes::CreatePipe;
    use windows_sys::Win32::System::SystemServices::JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO;
    use windows_sys::Win32::System::Threading::{
        CREATE_NEW_PROCESS_GROUP, CREATE_SUSPENDED, CreateProcessW, GetExitCodeProcess, INFINITE,
        PROCESS_INFORMATION, ResumeThread, STARTF_USESTDHANDLES, STARTUPINFOW, TerminateProcess,
        WaitForSingleObject,
    };

    const MAGIC: &[u8; 4] = b"XCSH";
    const VERSION: u8 = 2;
    const HEADER_BYTES: usize = 12;
    const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;

    const LAUNCH: u8 = 0x01;
    const GRACEFUL: u8 = 0x02;
    const FORCE: u8 = 0x03;
    const CLOSE: u8 = 0x04;

    const READY: u8 = 0x81;
    const STDOUT: u8 = 0x82;
    const STDERR: u8 = 0x83;
    const ROOT_EXIT: u8 = 0x84;
    const TREE_EMPTY: u8 = 0x85;
    const SPAWN_ERROR: u8 = 0x86;
    const TERMINATION_ERROR: u8 = 0x87;
    const STDOUT_EOF: u8 = 0x88;
    const STDERR_EOF: u8 = 0x89;

    unsafe extern "system" fn supervisor_ctrl_handler(_ctrl_type: u32) -> i32 {
        1
    }

    struct OwnedHandle(usize);

    impl OwnedHandle {
        fn new(handle: HANDLE) -> io::Result<Self> {
            if handle.is_null() || handle == INVALID_HANDLE_VALUE {
                Err(io::Error::last_os_error())
            } else {
                Ok(Self(handle as usize))
            }
        }

        fn raw(&self) -> HANDLE {
            self.0 as HANDLE
        }

        fn into_raw(mut self) -> HANDLE {
            let handle = self.raw();
            self.0 = 0;
            handle
        }
    }

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            if self.0 != 0 {
                unsafe {
                    CloseHandle(self.raw());
                }
            }
        }
    }

    struct LaunchRequest {
        cwd: String,
        application: String,
        command_line: String,
    }

    struct PayloadCursor<'a> {
        bytes: &'a [u8],
        offset: usize,
    }

    impl<'a> PayloadCursor<'a> {
        fn string(&mut self) -> io::Result<String> {
            if self.offset + 4 > self.bytes.len() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "truncated launch payload",
                ));
            }
            let length = u32::from_le_bytes(
                self.bytes[self.offset..self.offset + 4]
                    .try_into()
                    .expect("slice length checked"),
            ) as usize;
            self.offset += 4;
            if self.offset + length > self.bytes.len() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "truncated launch string",
                ));
            }
            let value = String::from_utf8(self.bytes[self.offset..self.offset + length].to_vec())
                .map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidData, "launch string is not UTF-8")
            })?;
            self.offset += length;
            Ok(value)
        }
    }

    type SharedOutput = Arc<Mutex<Box<dyn Write + Send>>>;

    fn shared_output<W: Write + Send + 'static>(writer: W) -> SharedOutput {
        Arc::new(Mutex::new(Box::new(writer)))
    }

    fn read_frame<R: Read>(reader: &mut R) -> io::Result<(u8, Vec<u8>)> {
        let mut header = [0u8; HEADER_BYTES];
        reader.read_exact(&mut header)?;
        if &header[0..4] != MAGIC || header[4] != VERSION {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid protocol header",
            ));
        }
        let length = u32::from_le_bytes(header[8..12].try_into().expect("fixed header")) as usize;
        if length > MAX_FRAME_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "protocol frame exceeds limit",
            ));
        }
        let mut payload = vec![0u8; length];
        reader.read_exact(&mut payload)?;
        Ok((header[5], payload))
    }

    fn send_frame(output: &SharedOutput, kind: u8, payload: &[u8]) -> io::Result<()> {
        let mut writer = output
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut header = [0u8; HEADER_BYTES];
        header[0..4].copy_from_slice(MAGIC);
        header[4] = VERSION;
        header[5] = kind;
        header[8..12].copy_from_slice(&(payload.len() as u32).to_le_bytes());
        writer.write_all(&header)?;
        writer.write_all(payload)?;
        writer.flush()
    }

    fn send_error(output: &SharedOutput, kind: u8, context: &str, error: &dyn std::fmt::Display) {
        let message = format!("{context}: {error}");
        let _ = send_frame(output, kind, message.as_bytes());
    }

    fn report_spawn_failure(output: &SharedOutput, context: &str, error: &dyn std::fmt::Display) {
        send_error(output, SPAWN_ERROR, context, error);
        let _ = send_frame(output, TREE_EMPTY, &[]);
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn create_pipe_pair(parent_reads: bool) -> io::Result<(OwnedHandle, OwnedHandle)> {
        let mut attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: null_mut(),
            bInheritHandle: 1,
        };
        let mut read: HANDLE = null_mut();
        let mut write: HANDLE = null_mut();
        let created = unsafe { CreatePipe(&mut read, &mut write, &mut attributes, 0) };
        if created == 0 {
            return Err(io::Error::last_os_error());
        }
        let read = OwnedHandle::new(read)?;
        let write = OwnedHandle::new(write)?;
        let parent = if parent_reads {
            read.raw()
        } else {
            write.raw()
        };
        if unsafe { SetHandleInformation(parent, HANDLE_FLAG_INHERIT, 0) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok((read, write))
    }

    fn configure_job(job: HANDLE, completion_port: HANDLE) -> io::Result<()> {
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const c_void,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }

        let association = JOBOBJECT_ASSOCIATE_COMPLETION_PORT {
            CompletionKey: job,
            CompletionPort: completion_port,
        };
        if unsafe {
            SetInformationJobObject(
                job,
                JobObjectAssociateCompletionPortInformation,
                &association as *const _ as *const c_void,
                size_of::<JOBOBJECT_ASSOCIATE_COMPLETION_PORT>() as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    fn create_job() -> io::Result<(OwnedHandle, OwnedHandle)> {
        let job = OwnedHandle::new(unsafe { CreateJobObjectW(null(), null()) })?;
        let completion_port = OwnedHandle::new(unsafe {
            CreateIoCompletionPort(INVALID_HANDLE_VALUE, null_mut(), 0, 1)
        })?;
        configure_job(job.raw(), completion_port.raw())?;
        Ok((job, completion_port))
    }

    fn spawn_pipe_reader(
        handle: OwnedHandle,
        kind: u8,
        eof_kind: u8,
        output: SharedOutput,
    ) -> thread::JoinHandle<()> {
        thread::spawn(move || {
            let raw = handle.into_raw();
            let mut file = unsafe { std::fs::File::from_raw_handle(raw as RawHandle) };
            let mut buffer = vec![0u8; 16 * 1024];
            loop {
                match file.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => {
                        if send_frame(&output, kind, &buffer[..read]).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
            let _ = send_frame(&output, eof_kind, &[]);
        })
    }

    fn parse_launch(payload: &[u8]) -> io::Result<LaunchRequest> {
        let mut cursor = PayloadCursor {
            bytes: payload,
            offset: 0,
        };
        let request = LaunchRequest {
            cwd: cursor.string()?,
            application: cursor.string()?,
            command_line: cursor.string()?,
        };
        if cursor.offset != payload.len() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "unexpected launch payload suffix",
            ));
        }
        Ok(request)
    }

    fn read_launch<R: Read>(input: &mut R) -> io::Result<LaunchRequest> {
        let (kind, payload) = read_frame(input)?;
        if kind != LAUNCH {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "first frame must be launch",
            ));
        }
        parse_launch(&payload)
    }

    fn spawn_root_waiter(
        process_handle: OwnedHandle,
        output: SharedOutput,
    ) -> thread::JoinHandle<()> {
        let process_raw = process_handle.into_raw() as usize;
        thread::spawn(move || {
            let process = process_raw as HANDLE;
            if unsafe { WaitForSingleObject(process, INFINITE) } == WAIT_OBJECT_0 {
                let mut exit_code = 1u32;
                unsafe {
                    GetExitCodeProcess(process, &mut exit_code);
                }
                let _ = send_frame(&output, ROOT_EXIT, &exit_code.to_le_bytes());
            }
            unsafe {
                CloseHandle(process);
            }
        })
    }

    fn spawn_completion_waiter(
        completion_port: HANDLE,
        job: HANDLE,
    ) -> (thread::JoinHandle<()>, mpsc::Receiver<Result<(), String>>) {
        let (tree_tx, tree_rx) = mpsc::channel::<Result<(), String>>();
        let completion_raw = completion_port as usize;
        let job_raw = job as usize;
        let completion_thread = thread::spawn(move || {
            loop {
                let mut message = 0u32;
                let mut key = 0usize;
                let mut overlapped = null_mut();
                let ok = unsafe {
                    GetQueuedCompletionStatus(
                        completion_raw as HANDLE,
                        &mut message,
                        &mut key,
                        &mut overlapped,
                        INFINITE,
                    )
                };
                if ok == 0 {
                    let _ = tree_tx.send(Err(format!(
                        "completion port failed: {}",
                        io::Error::last_os_error()
                    )));
                    return;
                }
                if key == job_raw && message == JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO {
                    let _ = tree_tx.send(Ok(()));
                    return;
                }
            }
        });
        (completion_thread, tree_rx)
    }

    fn spawn_control_reader<R: Read + Send + 'static>(
        mut input: R,
        job: HANDLE,
        root_pid: u32,
        output: SharedOutput,
    ) -> thread::JoinHandle<()> {
        let control_job = job as usize;
        thread::spawn(move || {
            loop {
                match read_frame(&mut input) {
                    Ok((GRACEFUL, _)) => {
                        if unsafe { GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, root_pid) } == 0 {
                            send_error(
                                &output,
                                TERMINATION_ERROR,
                                "GenerateConsoleCtrlEvent failed",
                                &io::Error::last_os_error(),
                            );
                        }
                    }
                    Ok((FORCE | CLOSE, _)) | Err(_) => {
                        unsafe {
                            TerminateJobObject(control_job as HANDLE, 1);
                        }
                        return;
                    }
                    Ok(_) => {}
                }
            }
        })
    }

    fn finish_tree(
        job: OwnedHandle,
        completion_port: OwnedHandle,
        completion_thread: thread::JoinHandle<()>,
        tree_rx: mpsc::Receiver<Result<(), String>>,
        root_thread: thread::JoinHandle<()>,
        output: &SharedOutput,
    ) {
        let tree_result = tree_rx
            .recv()
            .unwrap_or_else(|_| Err("completion thread ended".to_string()));
        if tree_result.is_err() {
            unsafe {
                TerminateJobObject(job.raw(), 1);
            }
        }
        let _ = root_thread.join();
        match tree_result {
            Ok(()) => {
                let _ = send_frame(output, TREE_EMPTY, &[]);
            }
            Err(message) => {
                let _ = send_frame(output, TERMINATION_ERROR, message.as_bytes());
            }
        }

        drop(job);
        drop(completion_port);
        let _ = completion_thread.join();
    }

    pub fn run_pipe() -> io::Result<()> {
        let output = shared_output(io::stdout());
        let stdin = io::stdin();
        let mut input = stdin.lock();
        let request = read_launch(&mut input)?;
        drop(input);

        unsafe {
            SetConsoleCtrlHandler(Some(supervisor_ctrl_handler), 1);
        }

        let (job, completion_port) = create_job()?;
        let (stdout_read, stdout_write) = create_pipe_pair(true)?;
        let (stderr_read, stderr_write) = create_pipe_pair(true)?;
        let (stdin_read, stdin_write) = create_pipe_pair(false)?;

        let mut startup = STARTUPINFOW::default();
        startup.cb = size_of::<STARTUPINFOW>() as u32;
        startup.dwFlags = STARTF_USESTDHANDLES;
        startup.hStdInput = stdin_read.raw();
        startup.hStdOutput = stdout_write.raw();
        startup.hStdError = stderr_write.raw();

        let application = wide(&request.application);
        let mut command_line = wide(&request.command_line);
        let cwd = wide(&request.cwd);
        let mut process_info: PROCESS_INFORMATION = unsafe { zeroed() };
        let created = unsafe {
            CreateProcessW(
                application.as_ptr(),
                command_line.as_mut_ptr(),
                null(),
                null(),
                1,
                CREATE_SUSPENDED | CREATE_NEW_PROCESS_GROUP,
                null(),
                cwd.as_ptr(),
                &startup,
                &mut process_info,
            )
        };
        if created == 0 {
            let error = io::Error::last_os_error();
            report_spawn_failure(&output, "CreateProcessW failed", &error);
            return Err(error);
        }

        let process_handle = OwnedHandle::new(process_info.hProcess)?;
        let thread_handle = OwnedHandle::new(process_info.hThread)?;
        drop(stdout_write);
        drop(stderr_write);
        drop(stdin_read);
        drop(stdin_write);

        if unsafe { AssignProcessToJobObject(job.raw(), process_handle.raw()) } == 0 {
            let error = io::Error::last_os_error();
            unsafe {
                TerminateProcess(process_handle.raw(), 1);
                WaitForSingleObject(process_handle.raw(), INFINITE);
            }
            report_spawn_failure(&output, "AssignProcessToJobObject failed", &error);
            return Err(error);
        }
        if unsafe { ResumeThread(thread_handle.raw()) } == u32::MAX {
            let error = io::Error::last_os_error();
            unsafe {
                TerminateJobObject(job.raw(), 1);
                WaitForSingleObject(process_handle.raw(), INFINITE);
            }
            report_spawn_failure(&output, "ResumeThread failed", &error);
            return Err(error);
        }
        drop(thread_handle);

        send_frame(&output, READY, &process_info.dwProcessId.to_le_bytes())?;

        let stdout_thread = spawn_pipe_reader(stdout_read, STDOUT, STDOUT_EOF, output.clone());
        let stderr_thread = spawn_pipe_reader(stderr_read, STDERR, STDERR_EOF, output.clone());
        let root_thread = spawn_root_waiter(process_handle, output.clone());
        let (completion_thread, tree_rx) =
            spawn_completion_waiter(completion_port.raw(), job.raw());
        let _control_thread = spawn_control_reader(
            io::stdin(),
            job.raw(),
            process_info.dwProcessId,
            output.clone(),
        );

        let tree_result = tree_rx
            .recv()
            .unwrap_or_else(|_| Err("completion thread ended".to_string()));
        if tree_result.is_err() {
            unsafe {
                TerminateJobObject(job.raw(), 1);
            }
        }
        let _ = root_thread.join();
        let _ = stdout_thread.join();
        let _ = stderr_thread.join();
        match tree_result {
            Ok(()) => {
                let _ = send_frame(&output, TREE_EMPTY, &[]);
            }
            Err(message) => {
                let _ = send_frame(&output, TERMINATION_ERROR, message.as_bytes());
            }
        }

        drop(job);
        drop(completion_port);
        let _ = completion_thread.join();
        Ok(())
    }

    fn connect_pipe(pipe_name: &OsStr, read: bool, write: bool) -> io::Result<File> {
        let mut last_error = None;
        for _ in 0..200 {
            match OpenOptions::new()
                .read(read)
                .write(write)
                .open(Path::new(pipe_name))
            {
                Ok(file) => return Ok(file),
                Err(error) => last_error = Some(error),
            }
            thread::sleep(Duration::from_millis(10));
        }
        Err(last_error.unwrap_or_else(|| io::Error::other("could not connect PTY pipe")))
    }

    pub fn run_pty(event_pipe_name: &OsStr, control_pipe_name: &OsStr) -> io::Result<()> {
        let output = shared_output(connect_pipe(event_pipe_name, false, true)?);
        let mut input = connect_pipe(control_pipe_name, true, false)?;
        let request = read_launch(&mut input)?;

        unsafe {
            SetConsoleCtrlHandler(Some(supervisor_ctrl_handler), 1);
        }

        let (job, completion_port) = create_job()?;
        let mut startup = STARTUPINFOW::default();
        startup.cb = size_of::<STARTUPINFOW>() as u32;

        let application = wide(&request.application);
        let mut command_line = wide(&request.command_line);
        let cwd = wide(&request.cwd);
        let mut process_info: PROCESS_INFORMATION = unsafe { zeroed() };
        // The supervisor is node-pty's ConPTY client. Its child implicitly inherits
        // that pseudoconsole, while CREATE_SUSPENDED closes the Job assignment race.
        let created = unsafe {
            CreateProcessW(
                application.as_ptr(),
                command_line.as_mut_ptr(),
                null(),
                null(),
                0,
                CREATE_SUSPENDED,
                null(),
                cwd.as_ptr(),
                &startup,
                &mut process_info,
            )
        };
        if created == 0 {
            let error = io::Error::last_os_error();
            report_spawn_failure(&output, "CreateProcessW PTY root failed", &error);
            return Err(error);
        }

        let process_handle = OwnedHandle::new(process_info.hProcess)?;
        let thread_handle = OwnedHandle::new(process_info.hThread)?;
        if unsafe { AssignProcessToJobObject(job.raw(), process_handle.raw()) } == 0 {
            let error = io::Error::last_os_error();
            unsafe {
                TerminateProcess(process_handle.raw(), 1);
                WaitForSingleObject(process_handle.raw(), INFINITE);
            }
            report_spawn_failure(&output, "AssignProcessToJobObject PTY root failed", &error);
            return Err(error);
        }
        if unsafe { ResumeThread(thread_handle.raw()) } == u32::MAX {
            let error = io::Error::last_os_error();
            unsafe {
                TerminateJobObject(job.raw(), 1);
                WaitForSingleObject(process_handle.raw(), INFINITE);
            }
            report_spawn_failure(&output, "ResumeThread PTY root failed", &error);
            return Err(error);
        }
        drop(thread_handle);

        send_frame(&output, READY, &process_info.dwProcessId.to_le_bytes())?;

        let root_thread = spawn_root_waiter(process_handle, output.clone());
        let (completion_thread, tree_rx) =
            spawn_completion_waiter(completion_port.raw(), job.raw());
        let _control_thread = spawn_control_reader(input, job.raw(), 0, output.clone());

        finish_tree(
            job,
            completion_port,
            completion_thread,
            tree_rx,
            root_thread,
            &output,
        );
        Ok(())
    }
}

#[cfg(windows)]
fn main() {
    let mut args = std::env::args_os().skip(1);
    let result = match args.next() {
        Some(mode) if mode == "--pty" => match (args.next(), args.next()) {
            (Some(event_pipe_name), Some(control_pipe_name)) if args.next().is_none() => {
                windows_supervisor::run_pty(&event_pipe_name, &control_pipe_name)
            }
            _ => Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "--pty requires event and control pipe names",
            )),
        },
        Some(_) => Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "unknown supervisor mode",
        )),
        None => windows_supervisor::run_pipe(),
    };
    if let Err(error) = result {
        eprintln!("xc-shell-supervisor: {error}");
        std::process::exit(1);
    }
}
