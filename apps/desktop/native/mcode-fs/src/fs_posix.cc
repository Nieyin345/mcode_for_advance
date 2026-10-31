#include "native_fs.h"

#ifndef _WIN32

#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dirent.h>
#include <fcntl.h>
#include <filesystem>
#include <sys/stat.h>
#include <sys/types.h>
#include <system_error>
#include <unistd.h>

#ifdef __linux__
#include <linux/fs.h>
#include <sys/syscall.h>
#endif
#ifdef __APPLE__
#include <stdio.h>
#endif

namespace mcode_fs {
namespace {

std::string ErrnoCode(int error) {
  switch (error) {
    case ENOENT: return "ENOENT";
    case EEXIST: return "EEXIST";
    case EACCES:
    case EPERM: return "EACCES";
    case ENOTDIR: return "ENOTDIR";
    case EISDIR: return "EISDIR";
    case ENOTEMPTY: return "ENOTEMPTY";
    case ELOOP: return "ELOOP";
    case EINVAL: return "EINVAL";
    case ENOSPC: return "ENOSPC";
    case EROFS: return "EROFS";
    case EFBIG: return "EFBIG";
    case EXDEV: return "EXDEV";
    case ENAMETOOLONG: return "ENAMETOOLONG";
    case ENOTSUP:
    case ENOSYS: return "ENOTSUP";
    default: return "EIO";
  }
}

[[noreturn]] void ThrowErrno(const char* operation, int error = errno) {
  throw FsError(ErrnoCode(error), std::string(operation) + ": " + std::strerror(error));
}

std::int64_t TimespecMs(const struct timespec& value) {
  return static_cast<std::int64_t>(value.tv_sec) * 1000 +
         static_cast<std::int64_t>(value.tv_nsec / 1000000);
}

std::int64_t MtimeMs(const struct stat& info) {
#ifdef __APPLE__
  return TimespecMs(info.st_mtimespec);
#else
  return TimespecMs(info.st_mtim);
#endif
}

std::int64_t BirthtimeMs(const struct stat& info) {
#ifdef __APPLE__
  return TimespecMs(info.st_birthtimespec);
#else
  return TimespecMs(info.st_ctim);
#endif
}

bool SameTimespec(const struct timespec& left, const struct timespec& right) {
  return left.tv_sec == right.tv_sec && left.tv_nsec == right.tv_nsec;
}

bool SameFileChangeTimes(const struct stat& before, const struct stat& after) {
  // Do not round to milliseconds for read-integrity checks: concurrent writes
  // within one millisecond would otherwise escape both comparisons.
#ifdef __APPLE__
  return SameTimespec(before.st_mtimespec, after.st_mtimespec) &&
         SameTimespec(before.st_ctimespec, after.st_ctimespec);
#else
  return SameTimespec(before.st_mtim, after.st_mtim) &&
         SameTimespec(before.st_ctim, after.st_ctim);
#endif
}

int OpenRootDirectory(int root_fd) {
  // dup()/F_DUPFD share the same open-file description and therefore the
  // directory stream offset. fdopendir()+readdir() on such a duplicate would
  // consume the pinned root's offset, making later root listings start at EOF.
  // openat(".") creates an independent open-file description for each walk.
  const int fd = openat(root_fd, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) ThrowErrno("open pinned workspace root");
  return fd;
}

int OpenDirectoryAt(int parent, const std::string& name) {
  const int fd = openat(parent, name.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) ThrowErrno("open directory component");
  struct stat info {};
  if (fstat(fd, &info) != 0) {
    const int error = errno;
    close(fd);
    ThrowErrno("inspect directory component", error);
  }
  if (!S_ISDIR(info.st_mode)) {
    close(fd);
    throw FsError("ENOTDIR", "path component is not a directory");
  }
  return fd;
}

int OpenDirectoryRaw(int root_fd, const Segments& segments, std::size_t count) {
  int current = OpenRootDirectory(root_fd);
  try {
    for (std::size_t i = 0; i < count; ++i) {
      const int next = OpenDirectoryAt(current, segments[i]);
      close(current);
      current = next;
    }
    return current;
  } catch (...) {
    close(current);
    throw;
  }
}

struct ParentAndLeaf {
  int parent = -1;
  const std::string* leaf = nullptr;
  ~ParentAndLeaf() { if (parent >= 0) close(parent); }
  ParentAndLeaf() = default;
  ParentAndLeaf(const ParentAndLeaf&) = delete;
  ParentAndLeaf& operator=(const ParentAndLeaf&) = delete;
  ParentAndLeaf(ParentAndLeaf&& other) noexcept : parent(other.parent), leaf(other.leaf) {
    other.parent = -1;
    other.leaf = nullptr;
  }
};

ParentAndLeaf OpenParent(int root_fd, const Segments& segments) {
  if (segments.empty()) throw FsError("EINVAL", "operation cannot target the root directory");
  ParentAndLeaf result;
  result.parent = OpenDirectoryRaw(root_fd, segments, segments.size() - 1);
  result.leaf = &segments.back();
  return result;
}

Stat ConvertStat(const struct stat& info) {
  Stat result;
  result.directory = S_ISDIR(info.st_mode);
  result.regular = S_ISREG(info.st_mode);
  result.size = info.st_size < 0 ? 0 : static_cast<std::uint64_t>(info.st_size);
  result.links = static_cast<std::uint64_t>(info.st_nlink);
  result.device = static_cast<std::uint64_t>(info.st_dev);
  result.inode = static_cast<std::uint64_t>(info.st_ino);
  result.mtime_ms = MtimeMs(info);
  result.birthtime_ms = BirthtimeMs(info);
  return result;
}

void ValidateLeafInfo(const struct stat& info, const char* operation) {
  if (S_ISLNK(info.st_mode)) throw FsError("ELOOP", std::string(operation) + ": symbolic links are not allowed");
  if (!S_ISREG(info.st_mode) && !S_ISDIR(info.st_mode)) {
    throw FsError("EINVAL", std::string(operation) + ": only ordinary files and directories are supported");
  }
}

#ifdef __linux__
int RenameNoReplace(int from_parent, const char* from, int to_parent, const char* to) {
  return static_cast<int>(syscall(SYS_renameat2, from_parent, from, to_parent, to, RENAME_NOREPLACE));
}
#elif defined(__APPLE__)
int RenameNoReplace(int from_parent, const char* from, int to_parent, const char* to) {
  return renameatx_np(from_parent, from, to_parent, to, RENAME_EXCL);
}
#else
int RenameNoReplace(int, const char*, int, const char*) {
  errno = ENOTSUP;
  return -1;
}
#endif

}  // namespace

NativeRoot::NativeRoot(const std::string& absolute_path) {
  if (absolute_path.empty() || absolute_path.front() != '/') {
    throw FsError("EINVAL", "native filesystem root must be an absolute POSIX path");
  }
  // Resolve the caller-selected root before pinning it. macOS system paths
  // such as /var and /tmp may be symlink aliases of /private/var and
  // /private/tmp. Once pinned, every *child* walk still rejects symlinks.
  std::error_code resolve_error;
  const std::string canonical =
      std::filesystem::canonical(std::filesystem::path(absolute_path), resolve_error).string();
  if (resolve_error) ThrowErrno("resolve native filesystem root", resolve_error.value());
  if (canonical.empty() || canonical.front() != '/') {
    throw FsError("EINVAL", "native filesystem root must remain absolute after normalization");
  }

  root_fd_ = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (root_fd_ < 0) ThrowErrno("open filesystem namespace root");
  try {
    std::size_t cursor = 1;
    while (cursor < canonical.size()) {
      const auto slash = canonical.find('/', cursor);
      const auto end = slash == std::string::npos ? canonical.size() : slash;
      if (end > cursor) {
        const std::string component = canonical.substr(cursor, end - cursor);
        const int next = OpenDirectoryAt(root_fd_, component);
        close(root_fd_);
        root_fd_ = next;
      }
      cursor = end + 1;
    }
  } catch (...) {
    close(root_fd_);
    root_fd_ = -1;
    throw;
  }
}

NativeRoot::~NativeRoot() { if (root_fd_ >= 0) close(root_fd_); }

void NativeRoot::EnsureOpen() const {
  if (closed_.load() || root_fd_ < 0) throw FsError("EBADF", "native filesystem root is closed");
}

void NativeRoot::Close() {
  std::unique_lock lock(handle_mutex_);
  if (!closed_.exchange(true) && root_fd_ >= 0) {
    close(root_fd_);
    root_fd_ = -1;
  }
}

Stat NativeRoot::GetStat(const Segments& segments) const {
  std::shared_lock lock(handle_mutex_);
  EnsureOpen();
  if (segments.empty()) {
    struct stat info {};
    if (fstat(root_fd_, &info) != 0) ThrowErrno("stat workspace root");
    return ConvertStat(info);
  }
  auto target = OpenParent(root_fd_, segments);
  struct stat info {};
  if (fstatat(target.parent, target.leaf->c_str(), &info, AT_SYMLINK_NOFOLLOW) != 0) ThrowErrno("stat workspace entry");
  ValidateLeafInfo(info, "stat workspace entry");
  return ConvertStat(info);
}

std::vector<Entry> NativeRoot::ReadDir(const Segments& segments, std::size_t max_entries) const {
  std::shared_lock lock(handle_mutex_);
  EnsureOpen();
  const int fd = OpenDirectoryRaw(root_fd_, segments, segments.size());
  DIR* directory = fdopendir(fd);
  if (!directory) {
    const int error = errno;
    close(fd);
    ThrowErrno("enumerate workspace directory", error);
  }
  std::vector<Entry> entries;
  std::size_t scanned = 0;
  try {
    for (;;) {
      // Reset immediately before readdir: fstatat() for a concurrently removed
      // entry may set errno=ENOENT, which must not be mistaken for a readdir error.
      errno = 0;
      dirent* item = readdir(directory);
      if (!item) {
        if (errno == EINTR) continue;
        if (errno != 0) ThrowErrno("read workspace directory");
        break;
      }
      const std::string name(item->d_name);
      if (name == "." || name == "..") continue;
      if (++scanned > max_entries) {
        throw FsError("EOVERFLOW", "directory entry count exceeds configured limit");
      }
      struct stat info {};
      if (fstatat(dirfd(directory), name.c_str(), &info, AT_SYMLINK_NOFOLLOW) != 0) {
        if (errno == ENOENT || errno == ENOTDIR) continue;
        ThrowErrno("inspect directory entry");
      }
      // Only return entries that the native stat/read/write API can reopen.
      // In particular, do not advertise FIFOs, sockets, devices or symlinks
      // as ordinary files to Theia's workspace browser.
      if (!S_ISREG(info.st_mode) && !S_ISDIR(info.st_mode)) continue;
      Entry entry;
      entry.name = name;
      entry.type = S_ISDIR(info.st_mode) ? 2 : 1;
      entry.size = info.st_size < 0 ? 0 : static_cast<std::uint64_t>(info.st_size);
      entries.push_back(std::move(entry));
    }
    closedir(directory);
    return entries;
  } catch (...) {
    closedir(directory);
    throw;
  }
}

std::vector<std::uint8_t> NativeRoot::ReadFile(const Segments& segments, std::size_t max_bytes) const {
  std::shared_lock lock(handle_mutex_);
  EnsureOpen();
  auto target = OpenParent(root_fd_, segments);
  const int fd = openat(target.parent, target.leaf->c_str(),
                        O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) ThrowErrno("open workspace file");
  try {
    struct stat before {};
    if (fstat(fd, &before) != 0) ThrowErrno("inspect opened workspace file");
    if (!S_ISREG(before.st_mode) || before.st_nlink != 1) {
      throw FsError("EINVAL", "workspace read requires a singly-linked ordinary file");
    }
    if (before.st_size < 0 || static_cast<std::uint64_t>(before.st_size) > max_bytes) {
      throw FsError("EFBIG", "workspace file exceeds the configured read limit");
    }
    std::vector<std::uint8_t> bytes(static_cast<std::size_t>(before.st_size));
    std::size_t total = 0;
    while (total < bytes.size()) {
      const ssize_t count = pread(fd, bytes.data() + total, bytes.size() - total,
                                  static_cast<off_t>(total));
      if (count < 0) {
        if (errno == EINTR) continue;
        ThrowErrno("read workspace file");
      }
      if (count == 0) break;
      total += static_cast<std::size_t>(count);
    }
    struct stat after {};
    if (fstat(fd, &after) != 0) ThrowErrno("verify opened workspace file");
    if (total != bytes.size() || after.st_nlink != 1 ||
        before.st_dev != after.st_dev || before.st_ino != after.st_ino ||
        before.st_size != after.st_size || !SameFileChangeTimes(before, after)) {
      throw FsError("ESTALE", "workspace file changed while it was being read");
    }
    close(fd);
    return bytes;
  } catch (...) {
    close(fd);
    throw;
  }
}

void NativeRoot::WriteFile(const Segments& segments, const std::vector<std::uint8_t>& bytes,
                           bool exclusive) const {
  std::shared_lock lock(handle_mutex_);
  EnsureOpen();
  auto target = OpenParent(root_fd_, segments);
  int flags = O_WRONLY | O_CREAT | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC;
  if (exclusive) flags |= O_EXCL;
  const int fd = openat(target.parent, target.leaf->c_str(), flags, 0666);
  if (fd < 0) ThrowErrno("open workspace write target");
  try {
    struct stat before {};
    if (fstat(fd, &before) != 0) ThrowErrno("inspect workspace write target");
    if (!S_ISREG(before.st_mode) || before.st_nlink != 1) {
      throw FsError("EINVAL", "workspace write requires a singly-linked ordinary file");
    }
    if (ftruncate(fd, 0) != 0) ThrowErrno("truncate workspace write target");
    std::size_t offset = 0;
    while (offset < bytes.size()) {
      const ssize_t count = write(fd, bytes.data() + offset, bytes.size() - offset);
      if (count < 0) {
        if (errno == EINTR) continue;
        ThrowErrno("write workspace file");
      }
      if (count == 0) throw FsError("EIO", "workspace write made no progress");
      offset += static_cast<std::size_t>(count);
    }
    struct stat after {};
    if (fstat(fd, &after) != 0) ThrowErrno("verify workspace write target");
    if (before.st_dev != after.st_dev || before.st_ino != after.st_ino || after.st_nlink != 1) {
      throw FsError("ESTALE", "workspace file identity changed while writing");
    }
    close(fd);
  } catch (...) {
    close(fd);
    throw;
  }
}

void NativeRoot::MakeDir(const Segments& segments) const {
  std::shared_lock lock(handle_mutex_);
  EnsureOpen();
  int current = OpenRootDirectory(root_fd_);
  try {
    for (const auto& component : segments) {
      int next = -1;
      try {
        next = OpenDirectoryAt(current, component);
      } catch (const FsError& error) {
        if (error.code() != "ENOENT") throw;
        if (mkdirat(current, component.c_str(), 0755) != 0 && errno != EEXIST) {
          ThrowErrno("create workspace directory");
        }
        next = OpenDirectoryAt(current, component);
      }
      close(current);
      current = next;
    }
    close(current);
  } catch (...) {
    close(current);
    throw;
  }
}

void NativeRoot::Rename(const Segments& from, const Segments& to, bool overwrite) const {
  std::shared_lock lock(handle_mutex_);
  EnsureOpen();
  auto source = OpenParent(root_fd_, from);
  auto destination = OpenParent(root_fd_, to);
  struct stat source_info {};
  if (fstatat(source.parent, source.leaf->c_str(), &source_info, AT_SYMLINK_NOFOLLOW) != 0) {
    ThrowErrno("inspect workspace rename source");
  }
  ValidateLeafInfo(source_info, "workspace rename source");
  if (S_ISREG(source_info.st_mode) && source_info.st_nlink != 1) {
    throw FsError("EINVAL", "workspace rename refuses multiply-linked files");
  }
  const int result = overwrite
      ? renameat(source.parent, source.leaf->c_str(), destination.parent, destination.leaf->c_str())
      : RenameNoReplace(source.parent, source.leaf->c_str(), destination.parent, destination.leaf->c_str());
  if (result != 0) ThrowErrno("rename workspace entry");
}

void NativeRoot::Copy(const Segments& from, const Segments& to, bool overwrite) const {
  const auto bytes = ReadFile(from, 8 * 1024 * 1024);
  WriteFile(to, bytes, !overwrite);
}

void NativeRoot::Remove(const Segments& segments) const {
  std::shared_lock lock(handle_mutex_);
  EnsureOpen();
  auto target = OpenParent(root_fd_, segments);
  struct stat info {};
  if (fstatat(target.parent, target.leaf->c_str(), &info, AT_SYMLINK_NOFOLLOW) != 0) {
    ThrowErrno("inspect workspace remove target");
  }
  ValidateLeafInfo(info, "workspace remove target");
  const int flags = S_ISDIR(info.st_mode) ? AT_REMOVEDIR : 0;
  if (unlinkat(target.parent, target.leaf->c_str(), flags) != 0) {
    ThrowErrno("remove workspace entry");
  }
}

}  // namespace mcode_fs

#endif
