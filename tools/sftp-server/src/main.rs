use std::collections::HashMap;
use std::fs::{self, File as StdFile, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Component, Path, PathBuf};
use bytes::Bytes;
use russh_sftp::protocol::{
    Attrs, Data, File as SftpFile, FileAttributes, Handle, Init, Name, Open, OpenDir, OpenFlags,
    Packet, Read as SftpRead, RealPath, Status, StatusCode, Version, Write as SftpWrite,
};
use russh_sftp::server::{Handler, StatusReply};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Default)]
struct FilesystemSftp {
    next_handle: u64,
    handles: HashMap<String, HandleEntry>,
}

enum HandleEntry {
    File(StdFile),
    Dir { files: Vec<SftpFile>, sent: bool },
}

impl FilesystemSftp {
    fn alloc_handle(&mut self, entry: HandleEntry) -> String {
        self.next_handle += 1;
        let handle = format!("nyabase:{}", self.next_handle);
        self.handles.insert(handle.clone(), entry);
        handle
    }
}

impl russh_sftp::server::Handler for FilesystemSftp {
    type Error = StatusReply;

    fn unimplemented(&self) -> Self::Error {
        StatusReply::new(StatusCode::OpUnsupported)
    }

    async fn init(
        &mut self,
        _version: u32,
        _extensions: HashMap<String, String>,
    ) -> Result<Version, Self::Error> {
        Ok(Version::new())
    }

    async fn open(
        &mut self,
        id: u32,
        filename: String,
        pflags: OpenFlags,
        attrs: FileAttributes,
    ) -> Result<Handle, Self::Error> {
        let path = resolve_path(&filename)?;
        let options: OpenOptions = pflags.into();
        let file = options.open(&path).map_err(to_status)?;
        if let Some(mode) = attrs.permissions {
            chmod_path(&path, mode).map_err(to_status)?;
        }
        let handle = self.alloc_handle(HandleEntry::File(file));
        Ok(Handle { id, handle })
    }

    async fn close(&mut self, id: u32, handle: String) -> Result<Status, Self::Error> {
        self.handles.remove(&handle);
        Ok(ok(id))
    }

    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<Data, Self::Error> {
        let file = match self.handles.get_mut(&handle) {
            Some(HandleEntry::File(file)) => file,
            _ => return Err(StatusReply::new(StatusCode::Failure).with_message("invalid file handle")),
        };
        let max_len = len.min(1024 * 1024) as usize;
        let mut buf = vec![0; max_len];
        file.seek(SeekFrom::Start(offset)).map_err(to_status)?;
        let read = file.read(&mut buf).map_err(to_status)?;
        if read == 0 {
            return Err(StatusReply::new(StatusCode::Eof));
        }
        buf.truncate(read);
        Ok(Data { id, data: buf })
    }

    async fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<Status, Self::Error> {
        let file = match self.handles.get_mut(&handle) {
            Some(HandleEntry::File(file)) => file,
            _ => return Err(StatusReply::new(StatusCode::Failure).with_message("invalid file handle")),
        };
        file.seek(SeekFrom::Start(offset)).map_err(to_status)?;
        file.write_all(&data).map_err(to_status)?;
        Ok(ok(id))
    }

    async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        let path = resolve_path(&path)?;
        let metadata = fs::symlink_metadata(path).map_err(to_status)?;
        Ok(Attrs { id, attrs: FileAttributes::from(&metadata) })
    }

    async fn fstat(&mut self, id: u32, handle: String) -> Result<Attrs, Self::Error> {
        let file = match self.handles.get_mut(&handle) {
            Some(HandleEntry::File(file)) => file,
            _ => return Err(StatusReply::new(StatusCode::Failure).with_message("invalid file handle")),
        };
        let metadata = file.metadata().map_err(to_status)?;
        Ok(Attrs { id, attrs: FileAttributes::from(&metadata) })
    }

    async fn setstat(
        &mut self,
        id: u32,
        path: String,
        attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        let path = resolve_path(&path)?;
        apply_path_attrs(&path, &attrs).map_err(to_status)?;
        Ok(ok(id))
    }

    async fn fsetstat(
        &mut self,
        id: u32,
        handle: String,
        attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        let file = match self.handles.get_mut(&handle) {
            Some(HandleEntry::File(file)) => file,
            _ => return Err(StatusReply::new(StatusCode::Failure).with_message("invalid file handle")),
        };
        if let Some(size) = attrs.size {
            file.set_len(size).map_err(to_status)?;
        }
        if let Some(mode) = attrs.permissions {
            let mut perms = file.metadata().map_err(to_status)?.permissions();
            perms.set_mode(mode & 0o7777);
            file.set_permissions(perms).map_err(to_status)?;
        }
        Ok(ok(id))
    }

    async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, Self::Error> {
        let path = resolve_path(&path)?;
        let mut files = Vec::new();
        for entry in fs::read_dir(path).map_err(to_status)? {
            let entry = entry.map_err(to_status)?;
            let metadata = entry.metadata().map_err(to_status)?;
            files.push(SftpFile::new(
                entry.file_name().to_string_lossy().into_owned(),
                FileAttributes::from(&metadata),
            ));
        }
        let handle = self.alloc_handle(HandleEntry::Dir { files, sent: false });
        Ok(Handle { id, handle })
    }

    async fn readdir(&mut self, id: u32, handle: String) -> Result<Name, Self::Error> {
        match self.handles.get_mut(&handle) {
            Some(HandleEntry::Dir { files, sent }) if !*sent => {
                *sent = true;
                Ok(Name { id, files: files.clone() })
            }
            Some(HandleEntry::Dir { .. }) => Err(StatusReply::new(StatusCode::Eof)),
            _ => Err(StatusReply::new(StatusCode::Failure).with_message("invalid directory handle")),
        }
    }

    async fn remove(&mut self, id: u32, filename: String) -> Result<Status, Self::Error> {
        let path = resolve_path(&filename)?;
        fs::remove_file(path).map_err(to_status)?;
        Ok(ok(id))
    }

    async fn mkdir(
        &mut self,
        id: u32,
        path: String,
        attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        let path = resolve_path(&path)?;
        fs::create_dir(&path).map_err(to_status)?;
        if let Some(mode) = attrs.permissions {
            chmod_path(&path, mode).map_err(to_status)?;
        }
        Ok(ok(id))
    }

    async fn rmdir(&mut self, id: u32, path: String) -> Result<Status, Self::Error> {
        let path = resolve_path(&path)?;
        fs::remove_dir(path).map_err(to_status)?;
        Ok(ok(id))
    }

    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, Self::Error> {
        let path = resolve_path(&path)?;
        Ok(Name {
            id,
            files: vec![SftpFile::dummy(path.to_string_lossy().into_owned())],
        })
    }

    async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        let path = resolve_path(&path)?;
        let metadata = fs::metadata(path).map_err(to_status)?;
        Ok(Attrs { id, attrs: FileAttributes::from(&metadata) })
    }

    async fn rename(
        &mut self,
        id: u32,
        oldpath: String,
        newpath: String,
    ) -> Result<Status, Self::Error> {
        let oldpath = resolve_path(&oldpath)?;
        let newpath = resolve_path(&newpath)?;
        fs::rename(oldpath, newpath).map_err(to_status)?;
        Ok(ok(id))
    }

    async fn readlink(&mut self, id: u32, path: String) -> Result<Name, Self::Error> {
        let path = resolve_path(&path)?;
        let target = fs::read_link(path).map_err(to_status)?;
        Ok(Name {
            id,
            files: vec![SftpFile::dummy(target.to_string_lossy().into_owned())],
        })
    }

    async fn symlink(
        &mut self,
        id: u32,
        linkpath: String,
        targetpath: String,
    ) -> Result<Status, Self::Error> {
        let linkpath = resolve_path(&linkpath)?;
        symlink(targetpath, linkpath).map_err(to_status)?;
        Ok(ok(id))
    }

    async fn extended(
        &mut self,
        id: u32,
        request: String,
        data: Vec<u8>,
    ) -> Result<Packet, Self::Error> {
        match request.as_str() {
            "fsync@openssh.com" => {
                if let Some(handle) = read_sftp_string(&data).and_then(|(value, _)| String::from_utf8(value).ok()) {
                    if let Some(HandleEntry::File(file)) = self.handles.get_mut(&handle) {
                        file.sync_all().map_err(to_status)?;
                    }
                }
                Ok(Packet::Status(ok(id)))
            }
            "posix-rename@openssh.com" => {
                let Some((old, rest)) = read_sftp_string(&data) else {
                    return Err(StatusReply::new(StatusCode::BadMessage));
                };
                let Some((new, _)) = read_sftp_string(rest) else {
                    return Err(StatusReply::new(StatusCode::BadMessage));
                };
                let old = String::from_utf8(old).map_err(|_| StatusReply::new(StatusCode::BadMessage))?;
                let new = String::from_utf8(new).map_err(|_| StatusReply::new(StatusCode::BadMessage))?;
                fs::rename(resolve_path(&old)?, resolve_path(&new)?).map_err(to_status)?;
                Ok(Packet::Status(ok(id)))
            }
            _ => Err(StatusReply::new(StatusCode::OpUnsupported)),
        }
    }
}

#[tokio::main]
async fn main() -> io::Result<()> {
    let mut stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();
    let mut handler = FilesystemSftp::default();

    loop {
        let mut len = [0; 4];
        if stdin.read_exact(&mut len).await.is_err() {
            break;
        }
        let len = u32::from_be_bytes(len);
        if len == 0 || len > 16 * 1024 * 1024 {
            break;
        }
        let mut payload = vec![0; len as usize];
        stdin.read_exact(&mut payload).await?;
        let mut bytes = Bytes::from(payload);
        let response = match Packet::try_from(&mut bytes) {
            Ok(packet) => process_packet(packet, &mut handler).await,
            Err(_) => Packet::error(0, StatusCode::BadMessage),
        };
        let packet = Bytes::try_from(response).map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;
        stdout.write_all(&packet).await?;
        stdout.flush().await?;
    }

    Ok(())
}

async fn process_packet(packet: Packet, handler: &mut FilesystemSftp) -> Packet {
    match packet {
        Packet::Init(Init { version, extensions }) => handler
            .init(version, extensions)
            .await
            .map(Packet::Version)
            .unwrap_or_else(|reply| Packet::Status(status_from_reply(0, reply))),
        Packet::Open(Open { id, filename, pflags, attrs }) => handler
            .open(id, filename, pflags, attrs)
            .await
            .map(Packet::Handle)
            .unwrap_or_else(|reply| Packet::Status(status_from_reply(id, reply))),
        Packet::Close(close) => handler
            .close(close.id, close.handle)
            .await
            .map(Packet::Status)
            .unwrap_or_else(|reply| Packet::Status(status_from_reply(close.id, reply))),
        Packet::Read(SftpRead { id, handle, offset, len }) => handler
            .read(id, handle, offset, len)
            .await
            .map(Packet::Data)
            .unwrap_or_else(|reply| Packet::Status(status_from_reply(id, reply))),
        Packet::Write(SftpWrite { id, handle, offset, data }) => handler
            .write(id, handle, offset, data)
            .await
            .map(Packet::Status)
            .unwrap_or_else(|reply| Packet::Status(status_from_reply(id, reply))),
        Packet::Lstat(lstat) => handler
            .lstat(lstat.id, lstat.path)
            .await
            .map(Packet::Attrs)
            .unwrap_or_else(|reply| Packet::Status(status_from_reply(lstat.id, reply))),
        Packet::Fstat(fstat) => handler
            .fstat(fstat.id, fstat.handle)
            .await
            .map(Packet::Attrs)
            .unwrap_or_else(|reply| Packet::Status(status_from_reply(fstat.id, reply))),
        Packet::SetStat(setstat) => handler
            .setstat(setstat.id, setstat.path, setstat.attrs)
            .await
            .map(Packet::Status)
            .unwrap_or_else(|reply| Packet::Status(status_from_reply(setstat.id, reply))),
        Packet::FSetStat(fsetstat) => handler
            .fsetstat(fsetstat.id, fsetstat.handle, fsetstat.attrs)
            .await
            .map(Packet::Status)
            .unwrap_or_else(|reply| Packet::Status(status_from_reply(fsetstat.id, reply))),
        Packet::OpenDir(OpenDir { id, path }) => handler
            .opendir(id, path)
            .await
            .map(Packet::Handle)
            .unwrap_or_else(|reply| Packet::Status(status_from_reply(id, reply))),
        Packet::ReadDir(readdir) => handler
            .readdir(readdir.id, readdir.handle)
            .await
            .map(Packet::Name)
            .unwrap_or_else(|reply| Packet::Status(status_from_reply(readdir.id, reply))),
        Packet::Remove(remove) => handler
            .remove(remove.id, remove.filename)
            .await
            .map(Packet::Status)
            .unwrap_or_else(|reply| Packet::Status(status_from_reply(remove.id, reply))),
        Packet::MkDir(mkdir) => handler
            .mkdir(mkdir.id, mkdir.path, mkdir.attrs)
            .await
            .map(Packet::Status)
            .unwrap_or_else(|reply| Packet::Status(status_from_reply(mkdir.id, reply))),
        Packet::RmDir(rmdir) => handler
            .rmdir(rmdir.id, rmdir.path)
            .await
            .map(Packet::Status)
            .unwrap_or_else(|reply| Packet::Status(status_from_reply(rmdir.id, reply))),
        Packet::RealPath(RealPath { id, path }) => handler
            .realpath(id, path)
            .await
            .map(Packet::Name)
            .unwrap_or_else(|reply| Packet::Status(status_from_reply(id, reply))),
        Packet::Stat(stat) => handler
            .stat(stat.id, stat.path)
            .await
            .map(Packet::Attrs)
            .unwrap_or_else(|reply| Packet::Status(status_from_reply(stat.id, reply))),
        Packet::Rename(rename) => handler
            .rename(rename.id, rename.oldpath, rename.newpath)
            .await
            .map(Packet::Status)
            .unwrap_or_else(|reply| Packet::Status(status_from_reply(rename.id, reply))),
        Packet::ReadLink(readlink) => handler
            .readlink(readlink.id, readlink.path)
            .await
            .map(Packet::Name)
            .unwrap_or_else(|reply| Packet::Status(status_from_reply(readlink.id, reply))),
        Packet::Symlink(symlink_packet) => handler
            .symlink(symlink_packet.id, symlink_packet.linkpath, symlink_packet.targetpath)
            .await
            .map(Packet::Status)
            .unwrap_or_else(|reply| Packet::Status(status_from_reply(symlink_packet.id, reply))),
        Packet::Extended(extended) => handler
            .extended(extended.id, extended.request, extended.data)
            .await
            .unwrap_or_else(|reply| Packet::Status(status_from_reply(extended.id, reply))),
        _ => Packet::error(packet.get_request_id(), StatusCode::BadMessage),
    }
}

fn status_from_reply(id: u32, reply: StatusReply) -> Status {
    Status {
        id,
        status_code: reply.status_code,
        error_message: reply.error_message.unwrap_or_else(|| reply.status_code.to_string()),
        language_tag: reply.language_tag.unwrap_or_else(|| "en-US".to_string()),
    }
}

fn ok(id: u32) -> Status {
    Status {
        id,
        status_code: StatusCode::Ok,
        error_message: "Ok".to_string(),
        language_tag: "en-US".to_string(),
    }
}

fn resolve_path(path: &str) -> Result<PathBuf, StatusReply> {
    let raw = if path.trim().is_empty() { "." } else { path };
    let base = if Path::new(raw).is_absolute() {
        PathBuf::new()
    } else {
        std::env::current_dir().map_err(to_status)?
    };
    Ok(normalize_path(base.join(raw)))
}

fn normalize_path(path: PathBuf) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::RootDir | Component::Prefix(_) | Component::Normal(_) => {
                normalized.push(component.as_os_str());
            }
        }
    }
    if normalized.as_os_str().is_empty() {
        PathBuf::from("/")
    } else {
        normalized
    }
}

fn apply_path_attrs(path: &Path, attrs: &FileAttributes) -> io::Result<()> {
    if let Some(size) = attrs.size {
        OpenOptions::new().write(true).open(path)?.set_len(size)?;
    }
    if let Some(mode) = attrs.permissions {
        chmod_path(path, mode)?;
    }
    Ok(())
}

fn chmod_path(path: &Path, mode: u32) -> io::Result<()> {
    let mut perms = fs::metadata(path)?.permissions();
    perms.set_mode(mode & 0o7777);
    fs::set_permissions(path, perms)
}

fn to_status(error: io::Error) -> StatusReply {
    let code = match error.kind() {
        io::ErrorKind::NotFound => StatusCode::NoSuchFile,
        io::ErrorKind::PermissionDenied => StatusCode::PermissionDenied,
        io::ErrorKind::UnexpectedEof => StatusCode::Eof,
        _ => StatusCode::Failure,
    };
    StatusReply::new(code).with_message(error.to_string())
}

fn read_sftp_string(input: &[u8]) -> Option<(Vec<u8>, &[u8])> {
    let len = u32::from_be_bytes(input.get(0..4)?.try_into().ok()?) as usize;
    let value = input.get(4..4 + len)?.to_vec();
    Some((value, &input[4 + len..]))
}
