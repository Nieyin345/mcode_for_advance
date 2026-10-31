#include "native_fs.h"

#ifdef _WIN32

#include <windows.h>
#include <winternl.h>

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

namespace mcode_fs {
namespace {

using NtCreateFileFn = NTSTATUS (NTAPI*)(
    PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK,
    PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
using RtlNtStatusToDosErrorFn = ULONG (WINAPI*)(NTSTATUS);
using NtSetInformationFileFn = NTSTATUS (NTAPI*)(
    HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, ULONG);
constexpr ULONG kFileRenameInformation = 10;

constexpr ULONG kObjCaseInsensitive = 0x00000040;
constexpr ULONG kObjDontReparse = 0x00001000;
constexpr ULONG kFileDirectoryFile = 0x00000001;
constexpr ULONG kFileSynchronousIoNonAlert = 0x00000020;
constexpr ULONG kFileNonDirectoryFile = 0x00000040;
constexpr ULONG kFileOpenReparsePoint = 0x00200000;
constexpr ULONG kFileOpen = 0x00000001;
constexpr ULONG kFileCreate = 0x00000002;
constexpr ULONG kFileOpenIf = 0x00000003;
constexpr ULONG kShareAll = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;

struct NativeObjectAttributes {
  ULONG Length;
  HANDLE RootDirectory;
  PUNICODE_STRING ObjectName;
  ULONG Attributes;
  PVOID SecurityDescriptor;
  PVOID SecurityQualityOfService;
};

struct NativeIoStatusBlock {
  union {
    NTSTATUS Status;
    PVOID Pointer;
  };
  ULONG_PTR Information;
};

NtCreateFileFn NtCreateFileProc() {
  static auto function = reinterpret_cast<NtCreateFileFn>(
      GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtCreateFile"));
  if (!function) throw FsError("ENOTSUP", "NtCreateFile is unavailable on this Windows installation");
  return function;
}

RtlNtStatusToDosErrorFn NtStatusToDosErrorProc() {
  static auto function = reinterpret_cast<RtlNtStatusToDosErrorFn>(
      GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlNtStatusToDosError"));
  return function;
}

NtSetInformationFileFn NtSetInformationFileProc() {
  static auto function = reinterpret_cast<NtSetInformationFileFn>(
      GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtSetInformationFile"));
  if (!function) throw FsError("ENOTSUP", "NtSetInformationFile is unavailable on this Windows installation");
  return function;
}

std::string Win32Code(DWORD error) {
  switch (error) {
    case ERROR_FILE_NOT_FOUND:
    case ERROR_PATH_NOT_FOUND: return "ENOENT";
    case ERROR_ALREADY_EXISTS:
    case ERROR_FILE_EXISTS: return "EEXIST";
    case ERROR_ACCESS_DENIED:
    case ERROR_PRIVILEGE_NOT_HELD: return "EACCES";
    case ERROR_DIRECTORY: return "ENOTDIR";
    case ERROR_DIR_NOT_EMPTY: return "ENOTEMPTY";
    case ERROR_INVALID_NAME:
    case ERROR_INVALID_PARAMETER: return "EINVAL";
    case ERROR_CANT_ACCESS_FILE:
    case ERROR_CANT_RESOLVE_FILENAME: return "ELOOP";
    case ERROR_FILENAME_EXCED_RANGE: return "ENAMETOOLONG";
    case ERROR_DISK_FULL: return "ENOSPC";
    case ERROR_NOT_SAME_DEVICE: return "EXDEV";
    case ERROR_NOT_SUPPORTED:
    case ERROR_INVALID_FUNCTION: return "ENOTSUP";
    case ERROR_TOO_MANY_OPEN_FILES: return "EMFILE";
    case ERROR_FILE_TOO_LARGE: return "EFBIG";
    default: return "EIO";
  }
}

[[noreturn]] void ThrowWindows(const char* operation, DWORD error = GetLastError()) {
  LPWSTR message = nullptr;
  const DWORD size = FormatMessageW(FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM |
      FORMAT_MESSAGE_IGNORE_INSERTS, nullptr, error, MAKELANGID(LANG_NEUTRAL, SUBLANG_DEFAULT),
      reinterpret_cast<LPWSTR>(&message), 0, nullptr);
  std::string detail = "Windows error " + std::to_string(error);
  if (size && message) {
    const int bytes = WideCharToMultiByte(CP_UTF8, 0, message, static_cast<int>(size),
                                          nullptr, 0, nullptr, nullptr);
    if (bytes > 0) {
      std::string converted(static_cast<std::size_t>(bytes), '\0');
      WideCharToMultiByte(CP_UTF8, 0, message, static_cast<int>(size),
                          converted.data(), bytes, nullptr, nullptr);
      detail = converted;
    }
    LocalFree(message);
  }
  throw FsError(Win32Code(error), std::string(operation) + ": " + detail);
}

[[noreturn]] void ThrowNtStatus(const char* operation, NTSTATUS status) {
  auto convert = NtStatusToDosErrorProc();
  const DWORD error = convert ? static_cast<DWORD>(convert(status)) : ERROR_GEN_FAILURE;
  ThrowWindows(operation, error);
}

std::wstring WideFromUtf8(const std::string& value) {
  if (value.empty()) return {};
  const int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                                        static_cast<int>(value.size()), nullptr, 0);
  if (count <= 0) ThrowWindows("decode UTF-8 filesystem path", ERROR_NO_UNICODE_TRANSLATION);
  std::wstring result(static_cast<std::size_t>(count), L'\0');
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                          static_cast<int>(value.size()), result.data(), count) != count) {
    ThrowWindows("decode UTF-8 filesystem path", ERROR_NO_UNICODE_TRANSLATION);
  }
  return result;
}

bool IsWellFormedUtf16(const std::wstring& value) {
  for (std::size_t i = 0; i < value.size(); ++i) {
    const auto unit = static_cast<std::uint16_t>(value[i]);
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      if (++i >= value.size()) return false;
      const auto low = static_cast<std::uint16_t>(value[i]);
      if (low < 0xDC00 || low > 0xDFFF) return false;
    } else if (unit >= 0xDC00 && unit <= 0xDFFF) {
      return false;
    }
  }
  return true;
}

std::string Utf8FromWide(const wchar_t* value, std::size_t length) {
  if (length == 0) return {};
  const int count = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value,
                                        static_cast<int>(length), nullptr, 0, nullptr, nullptr);
  if (count <= 0) ThrowWindows("encode filesystem entry name", ERROR_NO_UNICODE_TRANSLATION);
  std::string result(static_cast<std::size_t>(count), '\0');
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, static_cast<int>(length),
                          result.data(), count, nullptr, nullptr) != count) {
    ThrowWindows("encode filesystem entry name", ERROR_NO_UNICODE_TRANSLATION);
  }
  return result;
}

struct ScopedHandle {
  HANDLE value = INVALID_HANDLE_VALUE;
  ScopedHandle() = default;
  explicit ScopedHandle(HANDLE handle) : value(handle) {}
  ~ScopedHandle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  ScopedHandle(const ScopedHandle&) = delete;
  ScopedHandle& operator=(const ScopedHandle&) = delete;
  ScopedHandle(ScopedHandle&& other) noexcept : value(other.value) { other.value = INVALID_HANDLE_VALUE; }
  ScopedHandle& operator=(ScopedHandle&& other) noexcept {
    if (this != &other) {
      if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value);
      value = other.value;
      other.value = INVALID_HANDLE_VALUE;
    }
    return *this;
  }
  HANDLE release() { HANDLE result = value; value = INVALID_HANDLE_VALUE; return result; }
};

std::wstring AddExtendedPrefix(const std::wstring& input) {
  if (input.rfind(L"\\\\?\\", 0) == 0) return input;
  if (input.rfind(L"\\\\", 0) == 0) return L"\\\\?\\UNC\\" + input.substr(2);
  return L"\\\\?\\" + input;
}

std::pair<std::wstring, std::vector<std::wstring>> SplitRootPath(const std::wstring& input) {
  const std::wstring path = AddExtendedPrefix(input);
  std::size_t root_end = std::wstring::npos;
  if (path.rfind(L"\\\\?\\UNC\\", 0) == 0) {
    const auto server_end = path.find(L'\\', 8);
    if (server_end == std::wstring::npos) throw FsError("EINVAL", "UNC root is missing a share name");
    const auto share_end = path.find(L'\\', server_end + 1);
    root_end = share_end == std::wstring::npos ? path.size() : share_end + 1;
  } else if (path.size() >= 7 && path.rfind(L"\\\\?\\", 0) == 0 &&
             ((path[4] >= L'A' && path[4] <= L'Z') || (path[4] >= L'a' && path[4] <= L'z')) &&
             path[5] == L':' && path[6] == L'\\') {
    root_end = 7;
  } else {
    throw FsError("EINVAL", "only drive-rooted and UNC filesystem roots are supported");
  }

  const std::wstring root_part = path.substr(0, root_end);
  std::vector<std::wstring> components;
  std::size_t cursor = root_end;
  while (cursor < path.size()) {
    while (cursor < path.size() && path[cursor] == L'\\') ++cursor;
    if (cursor >= path.size()) break;
    const auto end = path.find(L'\\', cursor);
    const auto stop = end == std::wstring::npos ? path.size() : end;
    const auto component = path.substr(cursor, stop - cursor);
    if (!component.empty()) components.push_back(component);
    cursor = stop + 1;
  }
  return {root_part, components};
}

bool HasReparsePoint(HANDLE handle, FILE_ATTRIBUTE_TAG_INFO* output = nullptr) {
  FILE_ATTRIBUTE_TAG_INFO info{};
  if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &info, sizeof(info))) {
    ThrowWindows("inspect filesystem reparse attributes");
  }
  if (output) *output = info;
  return (info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
}

FILE_STANDARD_INFO GetStandardInfo(HANDLE handle) {
  FILE_STANDARD_INFO info{};
  if (!GetFileInformationByHandleEx(handle, FileStandardInfo, &info, sizeof(info))) {
    ThrowWindows("inspect filesystem entry");
  }
  return info;
}

FILE_BASIC_INFO GetBasicInfo(HANDLE handle) {
  FILE_BASIC_INFO info{};
  if (!GetFileInformationByHandleEx(handle, FileBasicInfo, &info, sizeof(info))) {
    ThrowWindows("inspect filesystem timestamps");
  }
  return info;
}

std::int64_t FileTimeMs(LARGE_INTEGER value) {
  constexpr std::int64_t kWindowsToUnixEpochMs = 11644473600000LL;
  return static_cast<std::int64_t>(value.QuadPart / 10000) - kWindowsToUnixEpochMs;
}

HANDLE OpenRelative(HANDLE parent, const std::wstring& component, ACCESS_MASK access,
                    ULONG disposition, ULONG options) {
  auto create = NtCreateFileProc();
  UNICODE_STRING name{};
  name.Buffer = const_cast<PWSTR>(component.c_str());
  name.Length = static_cast<USHORT>(component.size() * sizeof(wchar_t));
  name.MaximumLength = name.Length;
  NativeObjectAttributes attributes{};
  attributes.Length = sizeof(attributes);
  attributes.RootDirectory = parent;
  attributes.ObjectName = reinterpret_cast<PUNICODE_STRING>(&name);
  attributes.Attributes = kObjCaseInsensitive | kObjDontReparse;
  NativeIoStatusBlock io{};
  HANDLE handle = INVALID_HANDLE_VALUE;
  const NTSTATUS status = create(&handle, access | SYNCHRONIZE,
      reinterpret_cast<POBJECT_ATTRIBUTES>(&attributes), reinterpret_cast<PIO_STATUS_BLOCK>(&io),
      nullptr, FILE_ATTRIBUTE_NORMAL, kShareAll, disposition,
      options | kFileOpenReparsePoint | kFileSynchronousIoNonAlert, nullptr, 0);
  if (status < 0) ThrowNtStatus("open path relative to directory handle", status);
  if (!handle || handle == INVALID_HANDLE_VALUE) throw FsError("EIO", "NtCreateFile returned no handle");
  return handle;
}

void VerifyDirectory(HANDLE handle, const char* operation) {
  FILE_ATTRIBUTE_TAG_INFO attributes{};
  if (HasReparsePoint(handle, &attributes)) {
    throw FsError("ELOOP", std::string(operation) + ": reparse points are not allowed");
  }
  if ((attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0) {
    throw FsError("ENOTDIR", std::string(operation) + ": path component is not a directory");
  }
}

HANDLE OpenDirectoryAt(HANDLE parent, const std::wstring& name, bool list = false,
                        ACCESS_MASK extra_access = 0) {
  const ACCESS_MASK base_access = FILE_TRAVERSE | FILE_READ_ATTRIBUTES |
      ((list || (extra_access & FILE_LIST_DIRECTORY) != 0) ? FILE_LIST_DIRECTORY : 0);
  try {
    ScopedHandle handle(OpenRelative(parent, name, base_access | extra_access,
        kFileOpen, kFileDirectoryFile));
    VerifyDirectory(handle.value, "open directory component");
    return handle.release();
  } catch (const FsError& error) {
    // A selected read-only workspace must remain browseable. Keep the directory
    // handle with traversal/list rights, but omit mutation rights; later create
    // operations still fail at the handle-relative filesystem call.
    if (!extra_access || error.code() != "EACCES") throw;
    ScopedHandle read_only(OpenRelative(parent, name, base_access, kFileOpen, kFileDirectoryFile));
    VerifyDirectory(read_only.value, "open read-only directory component");
    return read_only.release();
  }
}

HANDLE DuplicateRoot(HANDLE root) {
  HANDLE copy = INVALID_HANDLE_VALUE;
  if (!DuplicateHandle(GetCurrentProcess(), root, GetCurrentProcess(), &copy,
                       0, FALSE, DUPLICATE_SAME_ACCESS)) {
    ThrowWindows("duplicate native filesystem root handle");
  }
  return copy;
}

HANDLE OpenDirectoryRaw(HANDLE root, const Segments& segments, std::size_t count,
                        bool list_final = false, ACCESS_MASK final_access = 0) {
  ScopedHandle current(DuplicateRoot(root));
  for (std::size_t i = 0; i < count; ++i) {
    ScopedHandle next(OpenDirectoryAt(current.value, WideFromUtf8(segments[i]),
        list_final && i + 1 == count, i + 1 == count ? final_access : 0));
    current = std::move(next);
  }
  return current.release();
}

struct ParentAndLeaf {
  ScopedHandle parent;
  std::wstring leaf;
};

ParentAndLeaf OpenParent(HANDLE root, const Segments& segments, ACCESS_MASK parent_access = 0) {
  if (segments.empty()) throw FsError("EINVAL", "operation cannot target the root directory");
  ParentAndLeaf result;
  result.parent = ScopedHandle(OpenDirectoryRaw(root, segments, segments.size() - 1,
      false, parent_access));
  result.leaf = WideFromUtf8(segments.back());
  return result;
}

void VerifyLeaf(HANDLE handle, const char* operation) {
  if (HasReparsePoint(handle)) {
    throw FsError("ELOOP", std::string(operation) + ": reparse points are not allowed");
  }
  const FILE_STANDARD_INFO standard = GetStandardInfo(handle);
  FILE_ATTRIBUTE_TAG_INFO attributes{};
  if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &attributes, sizeof(attributes))) {
    ThrowWindows("inspect filesystem entry attributes");
  }
  if ((attributes.FileAttributes & FILE_ATTRIBUTE_DEVICE) != 0) {
    throw FsError("EINVAL", std::string(operation) + ": device entries are not supported");
  }
  (void)standard;
}

Stat ConvertStat(HANDLE handle) {
  VerifyLeaf(handle, "stat workspace entry");
  const FILE_STANDARD_INFO standard = GetStandardInfo(handle);
  const FILE_BASIC_INFO basic = GetBasicInfo(handle);
  Stat result;
  result.directory = standard.Directory != FALSE;
  result.regular = !result.directory;
  result.size = standard.EndOfFile.QuadPart < 0 ? 0 : static_cast<std::uint64_t>(standard.EndOfFile.QuadPart);
  result.links = standard.NumberOfLinks;
  BY_HANDLE_FILE_INFORMATION identity{};
  if (!GetFileInformationByHandle(handle, &identity)) ThrowWindows("read filesystem root identity");
  result.device = identity.dwVolumeSerialNumber;
  result.inode = (static_cast<std::uint64_t>(identity.nFileIndexHigh) << 32) |
      static_cast<std::uint64_t>(identity.nFileIndexLow);
  result.mtime_ms = FileTimeMs(basic.LastWriteTime);
  result.birthtime_ms = FileTimeMs(basic.CreationTime);
  return result;
}

}  // namespace

NativeRoot::NativeRoot(const std::string& absolute_path) {
  const std::wstring requested = WideFromUtf8(absolute_path);
  const DWORD needed = GetFullPathNameW(requested.c_str(), 0, nullptr, nullptr);
  if (needed == 0) ThrowWindows("resolve native filesystem root");
  std::wstring full(static_cast<std::size_t>(needed), L'\0');
  const DWORD written = GetFullPathNameW(requested.c_str(), needed, full.data(), nullptr);
  if (written == 0 || written >= needed) ThrowWindows("resolve native filesystem root");
  full.resize(written);

  auto split = SplitRootPath(full);
  std::wstring root_path = split.first;
  if (root_path.empty() || root_path.back() != L'\\') root_path.push_back(L'\\');

  DWORD namespace_access = FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES;
  // A volume/share root has no final child component to reopen with mutation
  // rights, unlike ordinary workspace roots handled by OpenDirectoryAt below.
  // Request those rights only for that case; preserve read-only roots if the
  // root ACL denies either create permission.
  if (split.second.empty()) namespace_access |= FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY;
  HANDLE namespace_handle = CreateFileW(root_path.c_str(), namespace_access,
      kShareAll, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (namespace_handle == INVALID_HANDLE_VALUE) {
    const DWORD error = GetLastError();
    if (!split.second.empty() ||
        (error != ERROR_ACCESS_DENIED && error != ERROR_PRIVILEGE_NOT_HELD)) {
      ThrowWindows("open filesystem namespace root", error);
    }
    namespace_handle = CreateFileW(root_path.c_str(),
        FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES,
        kShareAll, nullptr, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (namespace_handle == INVALID_HANDLE_VALUE) ThrowWindows("open filesystem namespace root");
  }
  ScopedHandle current(namespace_handle);
  VerifyDirectory(current.value, "open filesystem namespace root");

  for (std::size_t i = 0; i < split.second.size(); ++i) {
    const bool final_component = i + 1 == split.second.size();
    const ACCESS_MASK extra = final_component
        ? FILE_LIST_DIRECTORY | FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY : 0;
    HANDLE opened_component = INVALID_HANDLE_VALUE;
    try {
      opened_component = OpenDirectoryAt(current.value, split.second[i], false, extra);
    } catch (const FsError& error) {
      // A readable but non-writable workspace must still be usable for stat,
      // readdir and Markdown preview. Only retry the final root component, and
      // only when the stronger create rights were denied; never relax reparse,
      // missing-path or non-directory failures.
      if (!final_component || error.code() != "EACCES") throw;
      opened_component = OpenDirectoryAt(current.value, split.second[i], false, FILE_LIST_DIRECTORY);
    }
    ScopedHandle next(opened_component);
    current = std::move(next);
  }
  root_handle_ = current.release();
}

NativeRoot::~NativeRoot() {
  if (root_handle_ && root_handle_ != INVALID_HANDLE_VALUE) CloseHandle(static_cast<HANDLE>(root_handle_));
}

void NativeRoot::EnsureOpen() const {
  if (closed_.load() || !root_handle_ || root_handle_ == INVALID_HANDLE_VALUE) {
    throw FsError("EBADF", "native filesystem root is closed");
  }
}

void NativeRoot::Close() {
  std::unique_lock lock(handle_mutex_);
  if (!closed_.exchange(true) && root_handle_ && root_handle_ != INVALID_HANDLE_VALUE) {
    CloseHandle(static_cast<HANDLE>(root_handle_));
    root_handle_ = INVALID_HANDLE_VALUE;
  }
}

Stat NativeRoot::GetStat(const Segments& segments) const {
  std::shared_lock lock(handle_mutex_);
  EnsureOpen();
  if (segments.empty()) {
    ScopedHandle root(DuplicateRoot(static_cast<HANDLE>(root_handle_)));
    return ConvertStat(root.value);
  }
  auto target = OpenParent(static_cast<HANDLE>(root_handle_), segments);
  ScopedHandle leaf(OpenRelative(target.parent.value, target.leaf, FILE_READ_ATTRIBUTES,
                                 kFileOpen, 0));
  return ConvertStat(leaf.value);
}

std::vector<Entry> NativeRoot::ReadDir(const Segments& segments, std::size_t max_entries) const {
  std::shared_lock lock(handle_mutex_);
  EnsureOpen();
  ScopedHandle directory(OpenDirectoryRaw(static_cast<HANDLE>(root_handle_), segments,
                                           segments.size(), true));
  std::vector<Entry> entries;
  std::size_t scanned = 0;
  std::vector<std::uint8_t> buffer(64 * 1024);
  FILE_INFO_BY_HANDLE_CLASS info_class = FileFullDirectoryRestartInfo;
  for (;;) {
    if (!GetFileInformationByHandleEx(directory.value, info_class, buffer.data(),
                                       static_cast<DWORD>(buffer.size()))) {
      const DWORD error = GetLastError();
      if (error == ERROR_NO_MORE_FILES) break;
      ThrowWindows("enumerate workspace directory", error);
    }
    info_class = FileFullDirectoryInfo;
    auto* item = reinterpret_cast<FILE_FULL_DIR_INFO*>(buffer.data());
    for (;;) {
      const std::size_t chars = item->FileNameLength / sizeof(wchar_t);
      const std::wstring wide_name(item->FileName, chars);
      // Windows filesystems can contain unpaired UTF-16 surrogates even
      // though the cross-platform provider exposes UTF-8 names. Hide those
      // entries instead of failing the entire directory listing.
      if (wide_name != L"." && wide_name != L"..") {
        if (++scanned > max_entries) {
          throw FsError("EOVERFLOW", "directory entry count exceeds configured limit");
        }
        if (IsWellFormedUtf16(wide_name) &&
            (item->FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0 &&
            (item->FileAttributes & FILE_ATTRIBUTE_DEVICE) == 0) {
          Entry entry;
          entry.name = Utf8FromWide(wide_name.data(), wide_name.size());
          entry.type = (item->FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0 ? 2 : 1;
          entry.size = item->EndOfFile.QuadPart < 0 ? 0 : static_cast<std::uint64_t>(item->EndOfFile.QuadPart);
          entries.push_back(std::move(entry));
        }
      }
      if (item->NextEntryOffset == 0) break;
      item = reinterpret_cast<FILE_FULL_DIR_INFO*>(
          reinterpret_cast<std::uint8_t*>(item) + item->NextEntryOffset);
    }
  }
  return entries;
}

std::vector<std::uint8_t> NativeRoot::ReadFile(const Segments& segments, std::size_t max_bytes) const {
  std::shared_lock lock(handle_mutex_);
  EnsureOpen();
  auto target = OpenParent(static_cast<HANDLE>(root_handle_), segments);
  ScopedHandle file(OpenRelative(target.parent.value, target.leaf,
      FILE_READ_DATA | FILE_READ_ATTRIBUTES, kFileOpen, kFileNonDirectoryFile));
  VerifyLeaf(file.value, "read workspace file");
  const FILE_STANDARD_INFO before = GetStandardInfo(file.value);
  if (before.Directory || before.NumberOfLinks != 1) {
    throw FsError("EINVAL", "workspace read requires a singly-linked ordinary file");
  }
  if (before.EndOfFile.QuadPart < 0 ||
      static_cast<std::uint64_t>(before.EndOfFile.QuadPart) > max_bytes) {
    throw FsError("EFBIG", "workspace file exceeds the configured read limit");
  }
  const FILE_BASIC_INFO basic_before = GetBasicInfo(file.value);
  std::vector<std::uint8_t> bytes(static_cast<std::size_t>(before.EndOfFile.QuadPart));
  std::size_t total = 0;
  while (total < bytes.size()) {
    const DWORD request = static_cast<DWORD>(std::min<std::size_t>(
        bytes.size() - total, static_cast<std::size_t>(0x7ffff000)));
    DWORD read = 0;
    if (!::ReadFile(file.value, bytes.data() + total, request, &read, nullptr)) {
      const DWORD error = GetLastError();
      if (error == ERROR_HANDLE_EOF) break;
      ThrowWindows("read workspace file", error);
    }
    if (read == 0) break;
    total += read;
  }
  const FILE_STANDARD_INFO after = GetStandardInfo(file.value);
  const FILE_BASIC_INFO basic_after = GetBasicInfo(file.value);
  if (after.Directory || after.NumberOfLinks != 1 ||
      total != bytes.size() || before.EndOfFile.QuadPart != after.EndOfFile.QuadPart ||
      basic_before.LastWriteTime.QuadPart != basic_after.LastWriteTime.QuadPart ||
      basic_before.ChangeTime.QuadPart != basic_after.ChangeTime.QuadPart) {
    throw FsError("ESTALE", "workspace file changed while it was being read");
  }
  return bytes;
}

void NativeRoot::WriteFile(const Segments& segments, const std::vector<std::uint8_t>& bytes,
                           bool exclusive) const {
  std::shared_lock lock(handle_mutex_);
  EnsureOpen();
  auto target = OpenParent(static_cast<HANDLE>(root_handle_), segments, FILE_ADD_FILE);
  ScopedHandle file(OpenRelative(target.parent.value, target.leaf,
      FILE_WRITE_DATA | FILE_READ_ATTRIBUTES, exclusive ? kFileCreate : kFileOpenIf,
      kFileNonDirectoryFile));
  VerifyLeaf(file.value, "write workspace file");
  const FILE_STANDARD_INFO before = GetStandardInfo(file.value);
  if (before.Directory || before.NumberOfLinks != 1) {
    throw FsError("EINVAL", "workspace write requires a singly-linked ordinary file");
  }
  LARGE_INTEGER zero{};
  if (!SetFilePointerEx(file.value, zero, nullptr, FILE_BEGIN) || !SetEndOfFile(file.value)) {
    ThrowWindows("truncate workspace write target");
  }
  std::size_t offset = 0;
  while (offset < bytes.size()) {
    const DWORD request = static_cast<DWORD>(std::min<std::size_t>(
        bytes.size() - offset, static_cast<std::size_t>(0x7ffff000)));
    DWORD written = 0;
    if (!::WriteFile(file.value, bytes.data() + offset, request, &written, nullptr)) {
      ThrowWindows("write workspace file");
    }
    if (written == 0) throw FsError("EIO", "workspace write made no progress");
    offset += written;
  }
  const FILE_STANDARD_INFO after = GetStandardInfo(file.value);
  if (after.NumberOfLinks != 1 || after.Directory) {
    throw FsError("ESTALE", "workspace file identity changed while writing");
  }
}

void NativeRoot::MakeDir(const Segments& segments) const {
  std::shared_lock lock(handle_mutex_);
  EnsureOpen();
  auto target = OpenParent(static_cast<HANDLE>(root_handle_), segments, FILE_ADD_SUBDIRECTORY);
  try {
    ScopedHandle created(OpenRelative(target.parent.value, target.leaf,
        FILE_READ_ATTRIBUTES | FILE_TRAVERSE, kFileCreate, kFileDirectoryFile));
    VerifyDirectory(created.value, "create workspace directory");
  } catch (const FsError& error) {
    if (error.code() != "EEXIST") throw;
    ScopedHandle existing(OpenDirectoryAt(target.parent.value, target.leaf));
    VerifyDirectory(existing.value, "verify existing workspace directory");
  }
}

void NativeRoot::Rename(const Segments& from, const Segments& to, bool overwrite) const {
  std::shared_lock lock(handle_mutex_);
  EnsureOpen();
  auto source = OpenParent(static_cast<HANDLE>(root_handle_), from);
  ScopedHandle entry(OpenRelative(source.parent.value, source.leaf,
      DELETE | FILE_READ_ATTRIBUTES, kFileOpen, 0));
  VerifyLeaf(entry.value, "rename workspace source");
  const FILE_STANDARD_INFO standard = GetStandardInfo(entry.value);
  if (!standard.Directory && standard.NumberOfLinks != 1) {
    throw FsError("EINVAL", "workspace rename refuses multiply-linked files");
  }
  const ACCESS_MASK destination_access = standard.Directory ? FILE_ADD_SUBDIRECTORY : FILE_ADD_FILE;
  auto destination = OpenParent(static_cast<HANDLE>(root_handle_), to, destination_access);
  if (overwrite) {
    try {
      ScopedHandle existing(OpenRelative(destination.parent.value, destination.leaf,
          FILE_READ_ATTRIBUTES, kFileOpen, 0));
      VerifyLeaf(existing.value, "rename workspace destination");
      const FILE_STANDARD_INFO destination_info = GetStandardInfo(existing.value);
      if (standard.Directory != destination_info.Directory) {
        throw FsError(standard.Directory ? "ENOTDIR" : "EISDIR",
            "rename cannot replace a file with a directory or a directory with a file");
      }
      if (standard.Directory) {
        // FILE_RENAME_INFO.ReplaceIfExists does not provide portable atomic
        // replacement of an existing directory on Windows. Do not translate
        // that limitation into a generic access-denied error or delete the
        // destination first: fail closed while preserving both directory trees.
        throw FsError("ENOTSUP", "replacing an existing directory is not supported on Windows");
      }
    } catch (const FsError& error) {
      if (error.code() != "ENOENT") throw;
    }
  }
  const std::size_t name_bytes = destination.leaf.size() * sizeof(wchar_t);
  const std::size_t buffer_bytes = sizeof(FILE_RENAME_INFO) + name_bytes;
  std::vector<std::uint8_t> buffer(buffer_bytes);
  auto* rename = reinterpret_cast<FILE_RENAME_INFO*>(buffer.data());
  std::memset(rename, 0, buffer.size());
  rename->ReplaceIfExists = overwrite ? TRUE : FALSE;
  rename->RootDirectory = destination.parent.value;
  rename->FileNameLength = static_cast<DWORD>(name_bytes);
  std::memcpy(rename->FileName, destination.leaf.data(), name_bytes);
  NativeIoStatusBlock io{};
  const NTSTATUS status = NtSetInformationFileProc()(
      entry.value, reinterpret_cast<PIO_STATUS_BLOCK>(&io), rename,
      static_cast<ULONG>(buffer.size()), kFileRenameInformation);
  if (status < 0) ThrowNtStatus("rename workspace entry", status);
}

void NativeRoot::Copy(const Segments& from, const Segments& to, bool overwrite) const {
  const auto bytes = ReadFile(from, 8 * 1024 * 1024);
  WriteFile(to, bytes, !overwrite);
}

void NativeRoot::Remove(const Segments& segments) const {
  std::shared_lock lock(handle_mutex_);
  EnsureOpen();
  auto target = OpenParent(static_cast<HANDLE>(root_handle_), segments);
  ScopedHandle entry(OpenRelative(target.parent.value, target.leaf,
      DELETE | FILE_READ_ATTRIBUTES, kFileOpen, 0));
  VerifyLeaf(entry.value, "remove workspace entry");
  FILE_DISPOSITION_INFO disposition{};
  disposition.DeleteFile = TRUE;
  if (!SetFileInformationByHandle(entry.value, FileDispositionInfo,
                                  &disposition, sizeof(disposition))) {
    ThrowWindows("remove workspace entry");
  }
}

}  // namespace mcode_fs

#endif
