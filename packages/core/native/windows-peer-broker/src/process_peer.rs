use std::io;
use std::ptr::null_mut;

use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Security::{RevertToSelf, TOKEN_QUERY};
use windows_sys::Win32::System::Pipes::{GetNamedPipeServerProcessId, ImpersonateNamedPipeClient};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentThread, OpenProcess, OpenProcessToken, OpenThreadToken,
    PROCESS_QUERY_LIMITED_INFORMATION,
};

use crate::security::{OwnedHandle, ProcessIdentity, identities_match, token_identity};

pub enum ClientVerificationError {
    Identity(io::Error),
    Revert(io::Error),
}

pub fn current_process_identity() -> io::Result<ProcessIdentity> {
    let mut token = null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let token = OwnedHandle::new(token)?;
    let identity = token_identity(token.raw())?;
    if identity.is_app_container {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "AppContainer broker tokens are unsupported",
        ));
    }
    Ok(identity)
}

pub fn verify_named_pipe_server(pipe: HANDLE, current: &ProcessIdentity) -> io::Result<()> {
    let mut process_id = 0u32;
    if unsafe { GetNamedPipeServerProcessId(pipe, &mut process_id) } == 0 || process_id == 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "server process identity is unavailable",
        ));
    }
    let process =
        OwnedHandle::new(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id) })
            .map_err(|_| {
                io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "server process cannot be inspected",
                )
            })?;
    let mut token = null_mut();
    if unsafe { OpenProcessToken(process.raw(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "server token cannot be inspected",
        ));
    }
    let token = OwnedHandle::new(token)?;
    let peer = token_identity(token.raw()).map_err(|_| {
        io::Error::new(
            io::ErrorKind::PermissionDenied,
            "server token identity is invalid",
        )
    })?;
    if identities_match(current, &peer) {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "server process identity is incompatible",
        ))
    }
}

pub fn verify_named_pipe_client(
    pipe: HANDLE,
    current: &ProcessIdentity,
) -> Result<(), ClientVerificationError> {
    if unsafe { ImpersonateNamedPipeClient(pipe) } == 0 {
        return Err(ClientVerificationError::Identity(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "client impersonation failed",
        )));
    }
    let guard = ImpersonationGuard { active: true };
    let result = inspect_thread_identity(current);
    match guard.revert() {
        Ok(()) => result.map_err(ClientVerificationError::Identity),
        Err(error) => Err(ClientVerificationError::Revert(error)),
    }
}

fn inspect_thread_identity(current: &ProcessIdentity) -> io::Result<()> {
    let mut token = null_mut();
    if unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut token) } == 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "client token cannot be inspected",
        ));
    }
    let token = OwnedHandle::new(token)?;
    let peer = token_identity(token.raw()).map_err(|_| {
        io::Error::new(
            io::ErrorKind::PermissionDenied,
            "client token identity is invalid",
        )
    })?;
    if identities_match(current, &peer) {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "client process identity is incompatible",
        ))
    }
}

struct ImpersonationGuard {
    active: bool,
}

impl ImpersonationGuard {
    fn revert(mut self) -> io::Result<()> {
        if unsafe { RevertToSelf() } == 0 {
            let first_error = io::Error::last_os_error();
            if unsafe { RevertToSelf() } == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    format!("client impersonation revert failed: {first_error}"),
                ));
            }
        }
        self.active = false;
        Ok(())
    }
}

impl Drop for ImpersonationGuard {
    fn drop(&mut self) {
        if self.active {
            unsafe {
                RevertToSelf();
            }
        }
    }
}
