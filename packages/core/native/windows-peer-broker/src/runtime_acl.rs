use std::io;
use std::mem::zeroed;
use std::path::{Component, Path, Prefix};
use std::ptr::{null, null_mut};

use sha2::{Digest, Sha256};
use windows_sys::Win32::Foundation::{ERROR_ALREADY_EXISTS, GetLastError};
use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, CreateDirectoryW, CreateFileW, FILE_ATTRIBUTE_DIRECTORY,
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_NAME_NORMALIZED, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ,
    FILE_SHARE_WRITE, GetDriveTypeW, GetFileInformationByHandle, GetFinalPathNameByHandleW,
    GetVolumeInformationW, GetVolumePathNameW, OPEN_EXISTING, READ_CONTROL, VOLUME_NAME_GUID,
    WRITE_DAC, WRITE_OWNER,
};

use crate::security::{
    OwnedHandle, PrivateSecurityDescriptor, ProcessIdentity, audit_parent_handle,
    verify_private_handle, wide,
};

const DRIVE_REMOTE: u32 = 4;
const DRIVE_UNKNOWN: u32 = 0;
const DRIVE_NO_ROOT_DIR: u32 = 1;
const FILE_PERSISTENT_ACLS: u32 = 0x0000_0008;
const MAX_WINDOWS_PATH_UNITS: usize = 32_767;

pub fn secure_runtime(root: &str, identity: &ProcessIdentity) -> io::Result<String> {
    let root_path = validate_root_shape(root)?;
    validate_local_acl_volume(root)?;

    let mut retained_handles = Vec::new();
    for (index, ancestor) in root_path
        .ancestors()
        .filter(|path| !path.as_os_str().is_empty())
        .enumerate()
    {
        let handle = open_directory(ancestor, false)?;
        audit_parent_handle(handle.raw(), &identity.account_sid, index == 0)?;
        retained_handles.push(handle);
    }

    let descriptor = PrivateSecurityDescriptor::new(&identity.account_sid, true)?;
    let runtime_path = root_path.join("runtime");
    let runtime = ensure_private_directory(&runtime_path, &descriptor, identity)?;
    let peers_path = runtime_path.join("peers");
    let peers = ensure_private_directory(&peers_path, &descriptor, identity)?;

    verify_private_handle(runtime.raw(), &identity.account_sid)?;
    verify_private_handle(peers.raw(), &identity.account_sid)?;
    let canonical = final_guid_path(peers.raw())?;
    drop(retained_handles);
    Ok(namespace_id_from_utf16(&canonical))
}

fn validate_root_shape(root: &str) -> io::Result<&Path> {
    if root.is_empty()
        || root.encode_utf16().count() > MAX_WINDOWS_PATH_UNITS
        || root.contains('\0')
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "runtime root length is invalid",
        ));
    }
    let path = Path::new(root);
    if !path.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "runtime root must be absolute",
        ));
    }
    match path.components().next() {
        Some(Component::Prefix(prefix))
            if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)) => {}
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "UNC and device runtime roots are unsupported",
            ));
        }
    }
    Ok(path)
}

fn validate_local_acl_volume(root: &str) -> io::Result<()> {
    let root_wide = wide(root)?;
    let mut volume_path = vec![0u16; MAX_WINDOWS_PATH_UNITS + 1];
    if unsafe {
        GetVolumePathNameW(
            root_wide.as_ptr(),
            volume_path.as_mut_ptr(),
            volume_path.len() as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let drive_type = unsafe { GetDriveTypeW(volume_path.as_ptr()) };
    if matches!(drive_type, DRIVE_UNKNOWN | DRIVE_NO_ROOT_DIR | DRIVE_REMOTE) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "runtime volume is not a supported local volume",
        ));
    }
    let mut filesystem_flags = 0u32;
    if unsafe {
        GetVolumeInformationW(
            volume_path.as_ptr(),
            null_mut(),
            0,
            null_mut(),
            null_mut(),
            &mut filesystem_flags,
            null_mut(),
            0,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    if filesystem_flags & FILE_PERSISTENT_ACLS == 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "runtime volume does not support persistent ACLs",
        ));
    }
    Ok(())
}

fn ensure_private_directory(
    path: &Path,
    descriptor: &PrivateSecurityDescriptor,
    identity: &ProcessIdentity,
) -> io::Result<OwnedHandle> {
    let path_text = path.to_str().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "runtime path is not Unicode")
    })?;
    let path_wide = wide(path_text)?;
    let attributes = descriptor.attributes();
    if unsafe { CreateDirectoryW(path_wide.as_ptr(), &attributes) } == 0 {
        let error = unsafe { GetLastError() };
        if error != ERROR_ALREADY_EXISTS {
            return Err(io::Error::from_raw_os_error(error as i32));
        }
    }
    let handle = open_directory_with_access(
        path,
        READ_CONTROL | WRITE_DAC | WRITE_OWNER | FILE_READ_ATTRIBUTES,
    )?;
    descriptor.apply_to_handle(handle.raw())?;
    verify_private_handle(handle.raw(), &identity.account_sid)?;
    Ok(handle)
}

fn open_directory(path: &Path, writable_dacl: bool) -> io::Result<OwnedHandle> {
    let mut access = READ_CONTROL | FILE_READ_ATTRIBUTES;
    if writable_dacl {
        access |= WRITE_DAC;
    }
    open_directory_with_access(path, access)
}

fn open_directory_with_access(path: &Path, access: u32) -> io::Result<OwnedHandle> {
    let path_text = path.to_str().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "runtime path is not Unicode")
    })?;
    let path_wide = wide(path_text)?;
    let handle = OwnedHandle::new(unsafe {
        CreateFileW(
            path_wide.as_ptr(),
            access,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    })?;
    let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { zeroed() };
    if unsafe { GetFileInformationByHandle(handle.raw(), &mut information) } == 0 {
        return Err(io::Error::last_os_error());
    }
    if information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "runtime path is not a directory",
        ));
    }
    if information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "runtime path contains a reparse point",
        ));
    }
    Ok(handle)
}

fn final_guid_path(handle: windows_sys::Win32::Foundation::HANDLE) -> io::Result<Vec<u16>> {
    let flags = FILE_NAME_NORMALIZED | VOLUME_NAME_GUID;
    let required = unsafe { GetFinalPathNameByHandleW(handle, null_mut(), 0, flags) } as usize;
    if required == 0 || required > MAX_WINDOWS_PATH_UNITS {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "canonical runtime path length is invalid",
        ));
    }
    let mut buffer = vec![0u16; required + 1];
    let written = unsafe {
        GetFinalPathNameByHandleW(handle, buffer.as_mut_ptr(), buffer.len() as u32, flags)
    } as usize;
    if written == 0 || written > required {
        return Err(io::Error::last_os_error());
    }
    buffer.truncate(written);
    Ok(buffer)
}

fn namespace_id_from_utf16(canonical_path: &[u16]) -> String {
    let mut hasher = Sha256::new();
    for unit in canonical_path {
        hasher.update(unit.to_le_bytes());
    }
    let digest = hasher.finalize();
    let mut namespace = String::with_capacity(12);
    for byte in &digest[..6] {
        use std::fmt::Write as _;
        write!(namespace, "{byte:02x}").expect("writing to String cannot fail");
    }
    namespace
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn namespace_hash_uses_normalized_utf16le_bytes() {
        let path: Vec<u16> = r"\\?\Volume{01234567-89ab-cdef-0123-456789abcdef}\x\runtime\peers"
            .encode_utf16()
            .collect();
        assert_eq!(namespace_id_from_utf16(&path), "b7ba38534afc");
        assert_eq!(namespace_id_from_utf16(&path).len(), 12);
    }

    #[test]
    fn runtime_root_shape_rejects_relative_and_unc_paths() {
        assert!(validate_root_shape(r"relative\x").is_err());
        assert!(validate_root_shape(r"\\server\share\x").is_err());
        assert!(validate_root_shape(r"C:\x-code").is_ok());
    }

    #[test]
    fn secures_and_verifies_a_real_local_runtime_tree() {
        let identity = crate::process_peer::current_process_identity().unwrap();
        let descriptor = PrivateSecurityDescriptor::new(&identity.account_sid, true).unwrap();
        let mut random = [0u8; 8];
        crate::security::random_bytes(&mut random).unwrap();
        let suffix = random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let root = Path::new(&std::env::var("USERPROFILE").unwrap())
            .join(format!(".x-code-peer-native-test-{suffix}"));
        let result = (|| {
            let handle = ensure_private_directory(&root, &descriptor, &identity)?;
            drop(handle);
            let namespace = secure_runtime(root.to_str().unwrap(), &identity)?;
            if namespace.len() != 12 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "namespace length mismatch",
                ));
            }
            Ok(())
        })();
        let _ = std::fs::remove_dir_all(&root);
        result.unwrap();
    }
}
