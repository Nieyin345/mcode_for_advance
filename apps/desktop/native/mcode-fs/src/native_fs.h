#pragma once

#include <napi.h>

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <shared_mutex>
#include <stdexcept>
#include <string>
#include <vector>

namespace mcode_fs {

class FsError final : public std::runtime_error {
 public:
  FsError(std::string code, const std::string& message)
      : std::runtime_error(message), code_(std::move(code)) {}
  const std::string& code() const noexcept { return code_; }
 private:
  std::string code_;
};

struct Stat {
  bool directory = false;
  bool regular = false;
  std::uint64_t size = 0;
  std::uint64_t links = 0;
  std::uint64_t device = 0;
  std::uint64_t inode = 0;
  std::int64_t mtime_ms = 0;
  std::int64_t birthtime_ms = 0;
};

struct Entry {
  std::string name;
  int type = 0;  // 1=file, 2=directory
  std::uint64_t size = 0;
};

using Segments = std::vector<std::string>;

class NativeRoot {
 public:
  explicit NativeRoot(const std::string& absolute_path);
  ~NativeRoot();

  NativeRoot(const NativeRoot&) = delete;
  NativeRoot& operator=(const NativeRoot&) = delete;

  void Close();
  bool IsClosed() const noexcept { return closed_.load(); }

  Stat GetStat(const Segments& segments) const;
  std::vector<Entry> ReadDir(const Segments& segments, std::size_t max_entries) const;
  std::vector<std::uint8_t> ReadFile(const Segments& segments, std::size_t max_bytes) const;
  void WriteFile(const Segments& segments, const std::vector<std::uint8_t>& bytes, bool exclusive) const;
  void MakeDir(const Segments& segments) const;
  void Rename(const Segments& from, const Segments& to, bool overwrite) const;
  void Copy(const Segments& from, const Segments& to, bool overwrite) const;
  void Remove(const Segments& segments) const;

 private:
  void EnsureOpen() const;

#ifdef _WIN32
  void* root_handle_ = nullptr;
#else
  int root_fd_ = -1;
#endif
  // AsyncWorker operations share the pinned handle. Close waits until every
  // in-flight operation has stopped using it before releasing the OS handle.
  mutable std::shared_mutex handle_mutex_;
  std::atomic<bool> closed_{false};
};

Napi::Object Init(Napi::Env env, Napi::Object exports);

}  // namespace mcode_fs
