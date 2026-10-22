//! Attach before resuming: children must never escape the kill-on-close job.
use super::Error;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use windows_sys::Win32::{
    Foundation::{HANDLE, INVALID_HANDLE_VALUE},
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
        },
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
        Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME},
    },
};

pub(super) struct Tree(OwnedHandle);
impl Tree {
    pub fn attach_and_resume(child: &tokio::process::Child) -> Result<Self, Error> {
        // SAFETY: every returned handle is checked and owned exactly once; all
        // pointers refer to initialized structures for the duration of the call.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err(Error::Spawn);
            }
            let tree = Self(OwnedHandle::from_raw_handle(job));
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            ) == 0
                || AssignProcessToJobObject(job, child.raw_handle().ok_or(Error::Spawn)? as HANDLE)
                    == 0
            {
                return Err(Error::Spawn);
            }
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
            if snapshot == INVALID_HANDLE_VALUE {
                return Err(Error::Spawn);
            }
            let snapshot = OwnedHandle::from_raw_handle(snapshot);
            let mut thread: THREADENTRY32 = std::mem::zeroed();
            thread.dwSize = std::mem::size_of_val(&thread) as u32;
            let pid = child.id().ok_or(Error::Spawn)?;
            let mut found = Thread32First(snapshot.as_raw_handle(), &mut thread);
            while found != 0 {
                if thread.th32OwnerProcessID == pid {
                    let handle = OpenThread(THREAD_SUSPEND_RESUME, 0, thread.th32ThreadID);
                    if handle.is_null() {
                        return Err(Error::Spawn);
                    }
                    let handle = OwnedHandle::from_raw_handle(handle);
                    if ResumeThread(handle.as_raw_handle()) == u32::MAX {
                        return Err(Error::Spawn);
                    }
                    return Ok(tree);
                }
                found = Thread32Next(snapshot.as_raw_handle(), &mut thread);
            }
            Err(Error::Spawn)
        }
    }

    pub fn finish(&self) -> Result<(), Error> {
        if unsafe { TerminateJobObject(self.0.as_raw_handle(), 1) } == 0 {
            Err(Error::TerminationFailed)
        } else {
            Ok(())
        }
    }
    pub async fn terminate(&self) -> Result<(), Error> {
        self.finish()
    }
}
