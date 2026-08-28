use std::ffi::c_void;
use std::io;
use std::mem::{size_of, zeroed};
use std::ptr::{null, null_mut};
use std::sync::Arc;

use windows_sys::Win32::Foundation::{CloseHandle, GENERIC_ALL, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Security::Cryptography::{
    BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom,
};
use windows_sys::Win32::Security::{
    ACCESS_ALLOWED_ACE, ACL, ACL_REVISION, ACL_SIZE_INFORMATION, AddAccessAllowedAceEx, CopySid,
    CreateWellKnownSid, DACL_SECURITY_INFORMATION, EqualSid, GetAce, GetAclInformation,
    GetKernelObjectSecurity, GetLengthSid, GetSecurityDescriptorControl, GetSecurityDescriptorDacl,
    GetSecurityDescriptorOwner, GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation,
    INHERIT_ONLY_ACE, InitializeAcl, InitializeSecurityDescriptor, IsValidSid, OBJECT_INHERIT_ACE,
    OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
    SE_DACL_PROTECTED, SECURITY_ATTRIBUTES, SetKernelObjectSecurity, SetSecurityDescriptorControl,
    SetSecurityDescriptorDacl, SetSecurityDescriptorOwner, TOKEN_MANDATORY_LABEL, TOKEN_USER,
    TokenIntegrityLevel, TokenIsAppContainer, TokenUser, WELL_KNOWN_SID_TYPE,
};
use windows_sys::Win32::System::Threading::{CreateEventW, SetEvent, WaitForSingleObject};

const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
const ACCESS_DENIED_ACE_TYPE: u8 = 1;
const CONTAINER_INHERIT_ACE: u32 = 0x02;
const SECURITY_DESCRIPTOR_REVISION: u32 = 1;

#[derive(Debug)]
pub struct OwnedHandle(usize);

impl OwnedHandle {
    pub fn new(handle: HANDLE) -> io::Result<Self> {
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            Err(io::Error::last_os_error())
        } else {
            Ok(Self(handle as usize))
        }
    }

    pub fn raw(&self) -> HANDLE {
        self.0 as HANDLE
    }
}

unsafe impl Send for OwnedHandle {}
unsafe impl Sync for OwnedHandle {}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if self.0 != 0 {
            unsafe {
                CloseHandle(self.raw());
            }
        }
    }
}

#[derive(Clone, Debug)]
pub struct Event(Arc<OwnedHandle>);

impl Event {
    pub fn manual_reset() -> io::Result<Self> {
        let handle = unsafe { CreateEventW(null(), 1, 0, null()) };
        Ok(Self(Arc::new(OwnedHandle::new(handle)?)))
    }

    pub fn signal(&self) -> io::Result<()> {
        if unsafe { SetEvent(self.raw()) } == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    pub fn is_signaled(&self) -> bool {
        (unsafe { WaitForSingleObject(self.raw(), 0) }) == 0
    }

    pub fn raw(&self) -> HANDLE {
        self.0.raw()
    }
}

#[derive(Clone, Debug)]
pub struct Sid {
    storage: Arc<Vec<usize>>,
    length: usize,
}

impl Sid {
    unsafe fn copy_from(raw: PSID) -> io::Result<Self> {
        if raw.is_null() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "missing token SID",
            ));
        }
        let length = unsafe { GetLengthSid(raw) } as usize;
        if length == 0 || length > 68 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "token SID length is invalid",
            ));
        }
        let mut storage = vec![0usize; length.div_ceil(size_of::<usize>())];
        if unsafe { CopySid(length as u32, storage.as_mut_ptr().cast(), raw) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self {
            storage: Arc::new(storage),
            length,
        })
    }

    pub fn raw(&self) -> PSID {
        self.storage.as_ptr() as PSID
    }

    pub fn length(&self) -> usize {
        self.length
    }

    pub fn equals_raw(&self, other: PSID) -> bool {
        !other.is_null() && unsafe { EqualSid(self.raw(), other) } != 0
    }

    pub fn equals(&self, other: &Self) -> bool {
        self.equals_raw(other.raw())
    }

    fn from_subauthorities(
        identifier_authority: [u8; 6],
        subauthorities: &[u32],
    ) -> io::Result<Self> {
        if subauthorities.len() > 15 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "SID has too many subauthorities",
            ));
        }
        let length = 8 + std::mem::size_of_val(subauthorities);
        let mut storage = vec![0usize; length.div_ceil(size_of::<usize>())];
        let bytes =
            unsafe { std::slice::from_raw_parts_mut(storage.as_mut_ptr().cast::<u8>(), length) };
        bytes[0] = 1;
        bytes[1] = subauthorities.len() as u8;
        bytes[2..8].copy_from_slice(&identifier_authority);
        for (index, value) in subauthorities.iter().enumerate() {
            let offset = 8 + index * size_of::<u32>();
            bytes[offset..offset + size_of::<u32>()].copy_from_slice(&value.to_le_bytes());
        }
        if unsafe { IsValidSid(storage.as_ptr() as PSID) } == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "constructed SID is invalid",
            ));
        }
        Ok(Self {
            storage: Arc::new(storage),
            length,
        })
    }
}

#[derive(Clone, Debug)]
pub struct ProcessIdentity {
    pub account_sid: Sid,
    pub integrity_rid: u32,
    pub is_app_container: bool,
}

pub fn token_identity(token: HANDLE) -> io::Result<ProcessIdentity> {
    let user = query_token_information(token, TokenUser)?;
    let token_user = unsafe { &*(user.as_ptr().cast::<TOKEN_USER>()) };
    let account_sid = unsafe { Sid::copy_from(token_user.User.Sid) }?;

    let integrity = query_token_information(token, TokenIntegrityLevel)?;
    let label = unsafe { &*(integrity.as_ptr().cast::<TOKEN_MANDATORY_LABEL>()) };
    let integrity_sid = label.Label.Sid;
    if integrity_sid.is_null() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "missing integrity SID",
        ));
    }
    let count = unsafe { *GetSidSubAuthorityCount(integrity_sid) } as u32;
    if count == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "integrity SID is invalid",
        ));
    }
    let integrity_rid = unsafe { *GetSidSubAuthority(integrity_sid, count - 1) };

    let app_container = query_token_information(token, TokenIsAppContainer)?;
    if app_container.len() * size_of::<usize>() < size_of::<u32>() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "app-container token field is truncated",
        ));
    }
    let is_app_container = unsafe { app_container.as_ptr().cast::<u32>().read_unaligned() != 0 };

    Ok(ProcessIdentity {
        account_sid,
        integrity_rid,
        is_app_container,
    })
}

pub fn identities_match(current: &ProcessIdentity, peer: &ProcessIdentity) -> bool {
    !current.is_app_container
        && !peer.is_app_container
        && current.integrity_rid == peer.integrity_rid
        && current.account_sid.equals(&peer.account_sid)
}

fn query_token_information(token: HANDLE, class: i32) -> io::Result<Vec<usize>> {
    let mut needed = 0u32;
    unsafe {
        GetTokenInformation(token, class, null_mut(), 0, &mut needed);
    }
    if needed == 0 || needed > 64 * 1024 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "token field length is invalid",
        ));
    }
    let mut buffer = vec![0usize; (needed as usize).div_ceil(size_of::<usize>())];
    if unsafe {
        GetTokenInformation(
            token,
            class,
            buffer.as_mut_ptr().cast(),
            needed,
            &mut needed,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(buffer)
}

pub fn random_bytes(bytes: &mut [u8]) -> io::Result<()> {
    let length = u32::try_from(bytes.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "random request is too large"))?;
    let status = unsafe {
        BCryptGenRandom(
            null_mut(),
            bytes.as_mut_ptr(),
            length,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status < 0 {
        Err(io::Error::other(format!(
            "system random generator failed ({status:#x})"
        )))
    } else {
        Ok(())
    }
}

pub fn constant_time_eq_43(left: &[u8], right: &[u8]) -> bool {
    if left.len() != 43 || right.len() != 43 {
        return false;
    }
    let mut difference = 0u8;
    for index in 0..43 {
        difference |= left[index] ^ right[index];
    }
    difference == 0
}

pub struct PrivateSecurityDescriptor {
    descriptor: Vec<usize>,
    _acl: Vec<usize>,
    _owner: Sid,
}

impl PrivateSecurityDescriptor {
    pub fn new(account_sid: &Sid, inheritable: bool) -> io::Result<Self> {
        let ace_bytes = size_of::<ACCESS_ALLOWED_ACE>() - size_of::<u32>() + account_sid.length();
        let acl_bytes = size_of::<ACL>() + ace_bytes;
        let mut acl = vec![0usize; acl_bytes.div_ceil(size_of::<usize>())];
        let acl_pointer = acl.as_mut_ptr().cast::<ACL>();
        if unsafe { InitializeAcl(acl_pointer, acl_bytes as u32, ACL_REVISION) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let flags = if inheritable {
            OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE
        } else {
            0
        };
        if unsafe {
            AddAccessAllowedAceEx(
                acl_pointer,
                ACL_REVISION,
                flags,
                GENERIC_ALL,
                account_sid.raw(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }

        let descriptor_bytes = 64usize;
        let mut descriptor = vec![0usize; descriptor_bytes.div_ceil(size_of::<usize>())];
        let descriptor_pointer = descriptor.as_mut_ptr().cast::<c_void>();
        if unsafe { InitializeSecurityDescriptor(descriptor_pointer, SECURITY_DESCRIPTOR_REVISION) }
            == 0
        {
            return Err(io::Error::last_os_error());
        }
        if unsafe { SetSecurityDescriptorDacl(descriptor_pointer, 1, acl_pointer, 0) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let owner = account_sid.clone();
        if unsafe { SetSecurityDescriptorOwner(descriptor_pointer, owner.raw(), 0) } == 0 {
            return Err(io::Error::last_os_error());
        }
        if unsafe {
            SetSecurityDescriptorControl(descriptor_pointer, SE_DACL_PROTECTED, SE_DACL_PROTECTED)
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self {
            descriptor,
            _acl: acl,
            _owner: owner,
        })
    }

    pub fn attributes(&self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.descriptor.as_ptr() as *mut c_void,
            bInheritHandle: 0,
        }
    }

    pub fn apply_to_handle(&self, handle: HANDLE) -> io::Result<()> {
        if unsafe {
            SetKernelObjectSecurity(
                handle,
                DACL_SECURITY_INFORMATION
                    | OWNER_SECURITY_INFORMATION
                    | PROTECTED_DACL_SECURITY_INFORMATION,
                self.descriptor.as_ptr() as PSECURITY_DESCRIPTOR,
            )
        } == 0
        {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
}

pub fn verify_private_handle(handle: HANDLE, account_sid: &Sid) -> io::Result<()> {
    let descriptor = object_security_descriptor(handle)?;
    let descriptor_pointer = descriptor.as_ptr() as PSECURITY_DESCRIPTOR;

    let mut control = 0u16;
    let mut revision = 0u32;
    if unsafe { GetSecurityDescriptorControl(descriptor_pointer, &mut control, &mut revision) } == 0
    {
        return Err(io::Error::last_os_error());
    }
    if control & SE_DACL_PROTECTED == 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "directory DACL is inherited",
        ));
    }

    let mut owner = null_mut();
    let mut owner_defaulted = 0;
    if unsafe { GetSecurityDescriptorOwner(descriptor_pointer, &mut owner, &mut owner_defaulted) }
        == 0
    {
        return Err(io::Error::last_os_error());
    }
    if !account_sid.equals_raw(owner) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "directory owner is unsafe",
        ));
    }

    let mut present = 0;
    let mut defaulted = 0;
    let mut acl = null_mut();
    if unsafe {
        GetSecurityDescriptorDacl(descriptor_pointer, &mut present, &mut acl, &mut defaulted)
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    if present == 0 || acl.is_null() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "directory DACL is missing",
        ));
    }
    let information = acl_information(acl)?;
    if information.AceCount != 1 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "directory DACL is not private",
        ));
    }
    let DaclAce::Allow { mask, sid, .. } = parse_dacl_ace(acl, 0)? else {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "directory DACL allowlist is unsafe",
        ));
    };
    const FILE_ALL_ACCESS_MASK: u32 = 0x001f_01ff;
    if (mask & GENERIC_ALL == 0 && mask & FILE_ALL_ACCESS_MASK != FILE_ALL_ACCESS_MASK)
        || !account_sid.equals_raw(sid)
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "directory DACL allowlist is unsafe",
        ));
    }
    Ok(())
}

pub fn audit_parent_handle(
    handle: HANDLE,
    current_sid: &Sid,
    protects_runtime_contents: bool,
) -> io::Result<()> {
    let descriptor = object_security_descriptor(handle)?;
    let descriptor_pointer = descriptor.as_ptr() as PSECURITY_DESCRIPTOR;
    let mut owner = null_mut();
    let mut owner_defaulted = 0;
    if unsafe { GetSecurityDescriptorOwner(descriptor_pointer, &mut owner, &mut owner_defaulted) }
        == 0
    {
        return Err(io::Error::last_os_error());
    }

    let system = well_known_sid(22)?;
    let administrators = well_known_sid(26)?;
    let creator_owner = well_known_sid(3)?;
    let trusted_installer = trusted_installer_sid()?;
    if owner.is_null()
        || !(current_sid.equals_raw(owner)
            || system.equals_raw(owner)
            || administrators.equals_raw(owner)
            || trusted_installer.equals_raw(owner))
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "parent directory owner is unsafe",
        ));
    }
    let mut present = 0;
    let mut defaulted = 0;
    let mut acl = null_mut();
    if unsafe {
        GetSecurityDescriptorDacl(descriptor_pointer, &mut present, &mut acl, &mut defaulted)
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    if present == 0 || acl.is_null() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "parent DACL is missing",
        ));
    }
    let information = acl_information(acl)?;
    const REPLACEMENT_RIGHTS: u32 =
        0x0000_0040 | 0x0001_0000 | 0x0004_0000 | 0x0008_0000 | 0x1000_0000;
    const CONTENT_WRITE_RIGHTS: u32 = 0x0000_0002 | 0x0000_0004 | 0x4000_0000;
    let dangerous = REPLACEMENT_RIGHTS
        | if protects_runtime_contents {
            CONTENT_WRITE_RIGHTS
        } else {
            0
        };
    for index in 0..information.AceCount {
        let DaclAce::Allow { flags, mask, sid } = parse_dacl_ace(acl, index)? else {
            continue;
        };
        if flags & INHERIT_ONLY_ACE as u8 != 0 || mask & dangerous == 0 {
            continue;
        }
        let allowed = current_sid.equals_raw(sid)
            || system.equals_raw(sid)
            || administrators.equals_raw(sid)
            || (creator_owner.equals_raw(sid) && current_sid.equals_raw(owner));
        if !allowed {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "parent grants replacement rights to another principal",
            ));
        }
    }
    Ok(())
}

fn object_security_descriptor(handle: HANDLE) -> io::Result<Vec<usize>> {
    let requested = DACL_SECURITY_INFORMATION | OWNER_SECURITY_INFORMATION;
    let mut needed = 0u32;
    unsafe {
        GetKernelObjectSecurity(handle, requested, null_mut(), 0, &mut needed);
    }
    if needed == 0 || needed > 64 * 1024 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "security descriptor length is invalid",
        ));
    }
    let mut descriptor = vec![0usize; (needed as usize).div_ceil(size_of::<usize>())];
    if unsafe {
        GetKernelObjectSecurity(
            handle,
            requested,
            descriptor.as_mut_ptr().cast(),
            needed,
            &mut needed,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(descriptor)
}

fn acl_information(acl: *mut ACL) -> io::Result<ACL_SIZE_INFORMATION> {
    let mut information: ACL_SIZE_INFORMATION = unsafe { zeroed() };
    if unsafe {
        GetAclInformation(
            acl,
            (&mut information as *mut ACL_SIZE_INFORMATION).cast(),
            size_of::<ACL_SIZE_INFORMATION>() as u32,
            2,
        )
    } == 0
    {
        Err(io::Error::last_os_error())
    } else {
        Ok(information)
    }
}

enum DaclAce {
    Allow { flags: u8, mask: u32, sid: PSID },
    Deny,
}

fn parse_dacl_ace(acl: *mut ACL, index: u32) -> io::Result<DaclAce> {
    let information = acl_information(acl)?;
    let mut raw_ace = null_mut();
    if unsafe { GetAce(acl, index, &mut raw_ace) } == 0 || raw_ace.is_null() {
        return Err(io::Error::last_os_error());
    }
    let acl_start = acl as usize;
    let acl_end = acl_start
        .checked_add(information.AclBytesInUse as usize)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "ACL length overflow"))?;
    let ace_start = raw_ace as usize;
    if ace_start < acl_start || ace_start.checked_add(4).is_none_or(|end| end > acl_end) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "ACE header is outside its ACL",
        ));
    }
    let bytes = unsafe { std::slice::from_raw_parts(raw_ace.cast::<u8>(), acl_end - ace_start) };
    let kind = bytes[0];
    let flags = bytes[1];
    let ace_size = u16::from_le_bytes([bytes[2], bytes[3]]) as usize;
    if ace_size < 4 || ace_size > bytes.len() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "ACE size is invalid",
        ));
    }
    if kind == ACCESS_DENIED_ACE_TYPE {
        return Ok(DaclAce::Deny);
    }
    if kind != ACCESS_ALLOWED_ACE_TYPE {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "unsupported ACE type in directory DACL",
        ));
    }
    if ace_size < 16 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "allow ACE is truncated",
        ));
    }
    let mask = u32::from_le_bytes(bytes[4..8].try_into().expect("checked allow ACE mask"));
    let sid_bytes = &bytes[8..ace_size];
    let subauthority_count = sid_bytes[1] as usize;
    let sid_length =
        8usize
            .checked_add(subauthority_count.checked_mul(4).ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, "ACE SID length overflow")
            })?)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "ACE SID length overflow"))?;
    if sid_bytes[0] != 1 || sid_length > sid_bytes.len() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "allow ACE SID is invalid",
        ));
    }
    let sid = sid_bytes.as_ptr().cast_mut().cast();
    if unsafe { IsValidSid(sid) } == 0 || unsafe { GetLengthSid(sid) } as usize != sid_length {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "allow ACE SID is invalid",
        ));
    }
    Ok(DaclAce::Allow { flags, mask, sid })
}

fn trusted_installer_sid() -> io::Result<Sid> {
    Sid::from_subauthorities(
        [0, 0, 0, 0, 0, 5],
        &[
            80, 956008885, 3418522649, 1831038044, 1853292631, 2271478464,
        ],
    )
}

fn well_known_sid(kind: WELL_KNOWN_SID_TYPE) -> io::Result<Sid> {
    let mut needed = 0u32;
    unsafe {
        CreateWellKnownSid(kind, null_mut(), null_mut(), &mut needed);
    }
    if needed == 0 || needed > 68 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "well-known SID length is invalid",
        ));
    }
    let mut storage = vec![0usize; (needed as usize).div_ceil(size_of::<usize>())];
    if unsafe { CreateWellKnownSid(kind, null_mut(), storage.as_mut_ptr().cast(), &mut needed) }
        == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(Sid {
        storage: Arc::new(storage),
        length: needed as usize,
    })
}

pub fn wide(value: &str) -> io::Result<Vec<u16>> {
    if value.encode_utf16().any(|unit| unit == 0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "string contains NUL",
        ));
    }
    Ok(value.encode_utf16().chain(std::iter::once(0)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_comparison_requires_exact_fixed_length_and_checks_all_bytes() {
        let token = b"abcdefghijklmnopqrstuvwxyzABCDEFGH012345678";
        assert_eq!(token.len(), 43);
        assert!(constant_time_eq_43(token, token));
        let mut first_changed = *token;
        first_changed[0] ^= 1;
        assert!(!constant_time_eq_43(token, &first_changed));
        let mut last_changed = *token;
        last_changed[42] ^= 1;
        assert!(!constant_time_eq_43(token, &last_changed));
        assert!(!constant_time_eq_43(token, &token[..42]));
    }

    #[test]
    fn random_generator_fills_requested_bytes() {
        let mut bytes = [0u8; 32];
        random_bytes(&mut bytes).unwrap();
        assert_ne!(bytes, [0u8; 32]);
    }

    #[test]
    fn private_descriptor_pins_the_account_as_owner() {
        let identity = crate::process_peer::current_process_identity().unwrap();
        let descriptor = PrivateSecurityDescriptor::new(&identity.account_sid, true).unwrap();
        let descriptor_pointer = descriptor.descriptor.as_ptr() as PSECURITY_DESCRIPTOR;
        let mut owner = null_mut();
        let mut owner_defaulted = 0;
        assert_ne!(
            unsafe {
                GetSecurityDescriptorOwner(descriptor_pointer, &mut owner, &mut owner_defaulted)
            },
            0
        );
        assert!(identity.account_sid.equals_raw(owner));
        assert_eq!(owner_defaulted, 0);
    }
}
