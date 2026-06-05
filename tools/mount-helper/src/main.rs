/// nyabase-mount-helper
///
/// Subcommands:
///   mount  --pid <pid> --src <path> --dst <path>
///   umount --pid <pid> --dst <path> [--lazy]
///   list   --pid <pid>
///
/// Must run as root / CAP_SYS_ADMIN.
use std::path::PathBuf;
use std::process;

use std::os::unix::io::{OwnedFd, FromRawFd};
use nix::fcntl::{open, OFlag};
use nix::sched::{setns, CloneFlags};
use nix::sys::stat::Mode;
use serde::Serialize;

// Linux syscall numbers (x86-64)
const SYS_OPEN_TREE: libc::c_long = 428;
const SYS_MOVE_MOUNT: libc::c_long = 429;

const AT_FDCWD_VAL: libc::c_long = -100;
const OPEN_TREE_CLONE: libc::c_ulong = 1;
const OPEN_TREE_CLOEXEC: libc::c_ulong = 0o2000000;
const MOVE_MOUNT_F_EMPTY_PATH: libc::c_ulong = 0x00000004;
const MNT_DETACH: libc::c_int = 2;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        usage();
        process::exit(1);
    }

    let result = match args[1].as_str() {
        "mount"            => cmd_mount(&args[2..]),
        "umount" | "unmount" => cmd_umount(&args[2..]),
        "list"             => cmd_list(&args[2..]),
        "--version" | "-V" => { println!("nyabase-mount-helper 0.1.0"); Ok(()) }
        _                  => { usage(); process::exit(1); }
    };

    if let Err(e) = result {
        eprintln!("Error: {e}");
        process::exit(1);
    }
}

fn usage() {
    eprintln!("Usage:");
    eprintln!("  nyabase-mount-helper mount  --pid <pid> --src <path> --dst <path>");
    eprintln!("  nyabase-mount-helper umount --pid <pid> --dst <path> [--lazy]");
    eprintln!("  nyabase-mount-helper list   --pid <pid>");
}

// ---------------------------------------------------------------------------
// mount
// ---------------------------------------------------------------------------

fn cmd_mount(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let (pid, src, dst) = parse_mount_args(args)?;

    // 1. open_tree in host ns — clone the source mount tree
    let c_src = std::ffi::CString::new(src.as_os_str().as_encoded_bytes())?;
    let tree_fd: libc::c_long = unsafe {
        libc::syscall(
            SYS_OPEN_TREE,
            AT_FDCWD_VAL,
            c_src.as_ptr(),
            (OPEN_TREE_CLONE | OPEN_TREE_CLOEXEC) as libc::c_long,
        )
    };
    if tree_fd < 0 {
        let err = std::io::Error::last_os_error();
        return Err(format!("open_tree({src:?}): {err}").into());
    }

    // 2. setns into container mount namespace
    let ns_path = format!("/proc/{pid}/ns/mnt");
    let raw_fd = open(ns_path.as_str(), OFlag::O_RDONLY | OFlag::O_CLOEXEC, Mode::empty())
        .map_err(|e| format!("open {ns_path}: {e}"))?;
    let ns_fd: OwnedFd = unsafe { OwnedFd::from_raw_fd(raw_fd) };
    setns(&ns_fd, CloneFlags::CLONE_NEWNS)
        .map_err(|e| format!("setns: {e}"))?;

    // 3. Ensure dst exists inside the container namespace, then move_mount.
    std::fs::create_dir_all(&dst)
        .map_err(|e| format!("create_dir_all({dst:?}): {e}"))?;

    let c_dst = std::ffi::CString::new(dst.as_os_str().as_encoded_bytes())?;
    let c_empty = std::ffi::CString::new("")?;
    let ret: libc::c_long = unsafe {
        libc::syscall(
            SYS_MOVE_MOUNT,
            tree_fd,
            c_empty.as_ptr(),
            AT_FDCWD_VAL,
            c_dst.as_ptr(),
            MOVE_MOUNT_F_EMPTY_PATH as libc::c_long,
        )
    };
    if ret < 0 {
        let err = std::io::Error::last_os_error();
        return Err(format!("move_mount({dst:?}): {err}").into());
    }

    Ok(())
}

fn parse_mount_args(args: &[String]) -> Result<(u32, PathBuf, PathBuf), Box<dyn std::error::Error>> {
    let mut pid: Option<u32> = None;
    let mut src: Option<PathBuf> = None;
    let mut dst: Option<PathBuf> = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--pid" => { i += 1; pid = Some(args[i].parse()?); }
            "--src" => { i += 1; src = Some(PathBuf::from(&args[i])); }
            "--dst" => { i += 1; dst = Some(PathBuf::from(&args[i])); }
            _ => {}
        }
        i += 1;
    }
    Ok((
        pid.ok_or("missing --pid")?,
        src.ok_or("missing --src")?,
        dst.ok_or("missing --dst")?,
    ))
}

// ---------------------------------------------------------------------------
// umount
// ---------------------------------------------------------------------------

fn cmd_umount(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let mut pid: Option<u32> = None;
    let mut dst: Option<PathBuf> = None;
    let mut lazy = false;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--pid" => { i += 1; pid = Some(args[i].parse()?); }
            "--dst" => { i += 1; dst = Some(PathBuf::from(&args[i])); }
            "--lazy" => { lazy = true; }
            _ => {}
        }
        i += 1;
    }
    let pid = pid.ok_or("missing --pid")?;
    let dst = dst.ok_or("missing --dst")?;

    // setns into container mount namespace
    let ns_path = format!("/proc/{pid}/ns/mnt");
    let raw_fd2 = open(ns_path.as_str(), OFlag::O_RDONLY | OFlag::O_CLOEXEC, Mode::empty())
        .map_err(|e| format!("open {ns_path}: {e}"))?;
    let ns_fd: OwnedFd = unsafe { OwnedFd::from_raw_fd(raw_fd2) };
    setns(&ns_fd, CloneFlags::CLONE_NEWNS)
        .map_err(|e| format!("setns: {e}"))?;

    let c_dst = std::ffi::CString::new(dst.as_os_str().as_encoded_bytes())?;
    let flags: libc::c_int = if lazy { MNT_DETACH } else { 0 };
    let ret = unsafe { libc::umount2(c_dst.as_ptr(), flags) };
    if ret < 0 {
        let err = std::io::Error::last_os_error();
        return Err(format!("umount2({dst:?}): {err}").into());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct MountEntry {
    dst: String,
    src: String,
    #[serde(rename = "fsType")]
    fs_type: String,
    options: String,
}

fn cmd_list(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let mut pid: Option<u32> = None;
    let mut i = 0;
    while i < args.len() {
        if args[i] == "--pid" { i += 1; pid = Some(args[i].parse()?); }
        i += 1;
    }
    let pid = pid.ok_or("missing --pid")?;

    let path = format!("/proc/{pid}/mountinfo");
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("read {path}: {e}"))?;

    let mut entries: Vec<MountEntry> = Vec::new();
    for line in content.lines() {
        // mountinfo: id parent major:minor root mountpoint mountopts [opt-fields] - fstype source super-opts
        let parts: Vec<&str> = line.split(' ').collect();
        if parts.len() < 10 { continue; }
        let mount_point = unescape_mountinfo(parts[4]);
        let mount_opts = parts[5].to_string();

        // find separator ' - '
        let sep_idx = parts.iter().position(|&p| p == "-");
        if sep_idx.is_none() || sep_idx.unwrap() + 2 >= parts.len() { continue; }
        let sep = sep_idx.unwrap();
        let fs_type = parts[sep + 1].to_string();
        let source = unescape_mountinfo(parts[sep + 2]);

        entries.push(MountEntry {
            dst: mount_point,
            src: source,
            fs_type,
            options: mount_opts,
        });
    }

    println!("{}", serde_json::to_string(&entries)?);
    Ok(())
}

fn unescape_mountinfo(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 3 < bytes.len() {
            if let Ok(n) = u8::from_str_radix(&s[i+1..i+4], 8) {
                result.push(n as char);
                i += 4;
                continue;
            }
        }
        result.push(bytes[i] as char);
        i += 1;
    }
    result
}
