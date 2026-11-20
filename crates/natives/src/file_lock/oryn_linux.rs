//! Oryn: Linux lock backend selected by `PI_FILE_LOCK_BACKEND` (see ORYN.md).
//!
//! The default is the upstream abstract-socket lock (`linux.rs`), unchanged.
//! `PI_FILE_LOCK_BACKEND=sidecar` switches to a persistent sidecar file at the
//! lock path, held by an open-file-description (OFD) write lock, for sandboxes
//! that forbid `AF_UNIX` sockets entirely (the Oryn coordinator host).
//!
//! OFD locks rather than `flock(2)`: both belong to the open file description,
//! so two handles in one process exclude each other and the kernel drops the
//! lock when the holder exits or crashes. Unlike `flock`, an OFD holder is
//! visible to `F_OFD_GETLK`, so `is_held` observes it without taking anything
//! and a concurrent `try_acquire` never meets the probe. (On Linux `flock` and
//! `fcntl` locks live on separate lists, so `unix.rs`'s `F_GETLK` probe cannot
//! see a `flock` holder there.)
//!
//! Processes that disagree on the backend do not exclude each other; the
//! variable must be set for every omp sharing an agent directory.

use std::{
	ffi::OsStr,
	fs::{DirBuilder, File, OpenOptions},
	io,
	os::{
		fd::AsRawFd,
		unix::fs::{DirBuilderExt, OpenOptionsExt},
	},
	path::Path,
	sync::LazyLock,
};

use super::linux;

/// Environment variable selecting the lock backend.
pub const BACKEND_ENV: &str = "PI_FILE_LOCK_BACKEND";

/// Value of [`BACKEND_ENV`] selecting the sidecar backend.
const SIDECAR: &str = "sidecar";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Backend {
	AbstractSocket,
	Sidecar,
}

impl Backend {
	/// Only the exact value `sidecar` switches; anything else keeps upstream.
	fn from_env_value(value: Option<&OsStr>) -> Self {
		match value {
			Some(value) if value == SIDECAR => Self::Sidecar,
			_ => Self::AbstractSocket,
		}
	}
}

/// Read once per process: every lock in a process uses one backend.
static BACKEND: LazyLock<Backend> =
	LazyLock::new(|| Backend::from_env_value(std::env::var_os(BACKEND_ENV).as_deref()));

fn backend() -> Backend {
	*BACKEND
}

pub enum PlatformFileLock {
	Socket(linux::PlatformFileLock),
	Sidecar(SidecarLock),
}

pub fn try_acquire(path: &str) -> io::Result<Option<PlatformFileLock>> {
	match backend() {
		Backend::AbstractSocket => Ok(linux::try_acquire(path)?.map(PlatformFileLock::Socket)),
		Backend::Sidecar => Ok(sidecar_try_acquire(path)?.map(PlatformFileLock::Sidecar)),
	}
}

pub fn is_held(path: &str) -> io::Result<bool> {
	match backend() {
		Backend::AbstractSocket => linux::is_held(path),
		Backend::Sidecar => sidecar_is_held(path),
	}
}

impl PlatformFileLock {
	pub fn release(&mut self) -> io::Result<()> {
		match self {
			Self::Socket(lock) => lock.release(),
			Self::Sidecar(lock) => {
				drop(lock.file.take());
				Ok(())
			},
		}
	}
}

/// Sidecar lock held by its open file description's OFD write lock.
pub struct SidecarLock {
	file: Option<File>,
}

/// Open (creating) the sidecar. Upstream callers on Linux expect a lock that
/// never touches the filesystem, so a missing parent is created privately.
fn open_sidecar(path: &str) -> io::Result<File> {
	let open = || {
		OpenOptions::new()
			.read(true)
			.write(true)
			.create(true)
			.truncate(false)
			.mode(0o600)
			.open(path)
	};
	match open() {
		Err(error) if error.kind() == io::ErrorKind::NotFound => {
			if let Some(parent) = Path::new(path).parent() {
				DirBuilder::new()
					.recursive(true)
					.mode(0o700)
					.create(parent)?;
			}
			open()
		},
		result => result,
	}
}

/// Whole-file `fcntl` lock request/query of `kind` on `file`.
fn ofd_lock(file: &File, command: libc::c_int, kind: libc::c_int) -> io::Result<libc::flock> {
	// SAFETY: an all-zero `flock` is valid. Zero `l_whence` is `SEEK_SET`, and
	// zero `l_start`/`l_len` from there covers the whole file; OFD requests
	// require a zero `l_pid`.
	let mut lock: libc::flock = unsafe { std::mem::zeroed() };
	lock.l_type = kind as libc::c_short;
	// SAFETY: `file` owns a live descriptor and `lock` is a valid `flock` for
	// the duration of the call.
	if unsafe { libc::fcntl(file.as_raw_fd(), command, &raw mut lock) } == -1 {
		return Err(io::Error::last_os_error());
	}
	Ok(lock)
}

fn sidecar_try_acquire(path: &str) -> io::Result<Option<SidecarLock>> {
	let file = open_sidecar(path)?;
	match ofd_lock(&file, libc::F_OFD_SETLK, libc::F_WRLCK) {
		Ok(_) => Ok(Some(SidecarLock { file: Some(file) })),
		Err(error) if matches!(error.raw_os_error(), Some(libc::EAGAIN | libc::EACCES)) => Ok(None),
		Err(error) => Err(error),
	}
}

/// `F_OFD_GETLK` reports the first lock conflicting with a whole-file read
/// lock without placing one. A missing sidecar means nobody ever locked it.
fn sidecar_is_held(path: &str) -> io::Result<bool> {
	let file = match OpenOptions::new().read(true).open(path) {
		Ok(file) => file,
		Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
		Err(error) => return Err(error),
	};
	let query = ofd_lock(&file, libc::F_OFD_GETLK, libc::F_RDLCK)?;
	Ok(query.l_type != libc::F_UNLCK as libc::c_short)
}

#[cfg(test)]
mod tests {
	use std::{
		ffi::OsStr,
		io::{BufRead, BufReader, Read},
		path::PathBuf,
		process::{Command, Stdio},
		time::{Duration, Instant, SystemTime, UNIX_EPOCH},
	};

	use super::*;

	/// Set by `sidecar_excludes_another_process` on the child it spawns.
	const CHILD_ENV: &str = "ORYN_FILE_LOCK_TEST_CHILD";

	fn temp_path(tag: &str) -> PathBuf {
		let nonce = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.expect("system clock")
			.as_nanos();
		std::env::temp_dir().join(format!("oryn-file-lock-{tag}-{}-{nonce}", std::process::id()))
	}

	/// Whether `probe` reads `path` as free within two seconds. A test running
	/// concurrently may fork while a lock is open; its child shares the open
	/// file description (or socket) until `exec` closes it (`O_CLOEXEC`), so a
	/// just-released lock can briefly still read as held.
	fn released(path: &str, probe: fn(&str) -> io::Result<bool>) -> bool {
		let deadline = Instant::now() + Duration::from_secs(2);
		loop {
			if !probe(path).expect("probe") {
				return true;
			}
			if Instant::now() >= deadline {
				return false;
			}
			std::thread::sleep(Duration::from_millis(5));
		}
	}

	#[test]
	fn only_sidecar_value_selects_sidecar() {
		assert_eq!(Backend::from_env_value(None), Backend::AbstractSocket);
		assert_eq!(Backend::from_env_value(Some(OsStr::new(""))), Backend::AbstractSocket);
		assert_eq!(Backend::from_env_value(Some(OsStr::new("flock"))), Backend::AbstractSocket);
		assert_eq!(Backend::from_env_value(Some(OsStr::new("SIDECAR"))), Backend::AbstractSocket);
		assert_eq!(Backend::from_env_value(Some(OsStr::new("sidecar"))), Backend::Sidecar);
	}

	#[test]
	fn unset_env_keeps_abstract_socket() {
		if std::env::var_os(BACKEND_ENV).is_some() {
			eprintln!("{BACKEND_ENV} is set; the default-backend test does not apply");
			return;
		}
		assert_eq!(backend(), Backend::AbstractSocket);
		// A path whose directory does not exist: the socket lock never touches
		// it.
		let dir = temp_path("socket");
		let path = dir.join("lock");
		let path = path.to_str().expect("utf-8 temp path");
		let mut lease = try_acquire(path).expect("acquire").expect("free lease");
		assert!(matches!(lease, PlatformFileLock::Socket(_)));
		assert!(!dir.exists(), "the abstract socket lock created {}", dir.display());
		assert!(linux::is_held(path).expect("probe abstract name"));
		assert!(try_acquire(path).expect("contend").is_none());
		lease.release().expect("release");
		assert!(released(path, linux::is_held), "the abstract name outlived its released holder");
	}

	#[test]
	fn sidecar_handles_exclude_and_release() {
		let dir = temp_path("sidecar");
		let path = dir.join("nested").join("lock");
		let path = path.to_str().expect("utf-8 temp path");
		assert!(!sidecar_is_held(path).expect("probe missing sidecar"));

		let mut first = sidecar_try_acquire(path)
			.expect("acquire")
			.expect("free lease");
		let parent = Path::new(path).parent().expect("parent");
		{
			use std::os::unix::fs::PermissionsExt;
			let mode = std::fs::metadata(parent)
				.expect("parent created")
				.permissions()
				.mode();
			assert_eq!(mode & 0o777, 0o700);
		}
		assert!(sidecar_is_held(path).expect("probe held"));
		// A second open file description in the same process is refused.
		assert!(sidecar_try_acquire(path).expect("contend").is_none());
		// The probe neither took the lock nor left it held.
		assert!(sidecar_is_held(path).expect("probe held again"));

		drop(first.file.take());
		assert!(released(path, sidecar_is_held), "the lock outlived its released holder");
		let mut second = sidecar_try_acquire(path)
			.expect("reacquire")
			.expect("released lease");
		assert!(sidecar_is_held(path).expect("probe reacquired"));
		drop(second.file.take());
		// The sidecar persists across holders.
		assert!(Path::new(path).exists());
		let _ = std::fs::remove_dir_all(&dir);
	}

	/// Child half of `sidecar_excludes_another_process`: hold the lock, report,
	/// and wait for stdin to close (or for the parent to kill it).
	#[test]
	fn sidecar_child_holder() {
		let Some(path) = std::env::var_os(CHILD_ENV) else {
			return;
		};
		let path = path.to_str().expect("utf-8 path").to_owned();
		let _lease = sidecar_try_acquire(&path)
			.expect("child acquire")
			.expect("child lease");
		println!("ORYN-LOCK-HELD");
		let mut sink = Vec::new();
		let _ = std::io::stdin().read_to_end(&mut sink);
	}

	#[test]
	fn sidecar_excludes_another_process() {
		let dir = temp_path("process");
		let path = dir.join("lock");
		let path_str = path.to_str().expect("utf-8 temp path");
		let mut child = Command::new(std::env::current_exe().expect("test binary"))
			.args([
				"--exact",
				"file_lock::oryn_linux::tests::sidecar_child_holder",
				"--nocapture",
				"--test-threads=1",
			])
			.env(CHILD_ENV, &path)
			.stdin(Stdio::piped())
			.stdout(Stdio::piped())
			.stderr(Stdio::inherit())
			.spawn()
			.expect("spawn child");
		let stdout = child.stdout.take().expect("child stdout");
		let held = BufReader::new(stdout)
			.lines()
			.map_while(Result::ok)
			.any(|line| line.contains("ORYN-LOCK-HELD"));
		assert!(held, "child never reported holding the lock");

		assert!(sidecar_is_held(path_str).expect("probe child lock"));
		assert!(sidecar_try_acquire(path_str).expect("contend").is_none());

		// A killed holder releases the lock without cleanup.
		child.kill().expect("kill child");
		child.wait().expect("reap child");
		assert!(released(path_str, sidecar_is_held), "the lock outlived its killed holder");
		let mut lease = sidecar_try_acquire(path_str)
			.expect("acquire")
			.expect("lease after kill");
		drop(lease.file.take());
		let _ = std::fs::remove_dir_all(&dir);
	}
}
