#include "native_fs.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <functional>
#include <limits>
#include <memory>
#include <string>
#include <utility>

namespace mcode_fs {
namespace {

constexpr std::size_t kMaxDepth = 256;
constexpr std::size_t kMaxComponentBytes = 255;
constexpr std::size_t kDefaultCopyLimit = 8 * 1024 * 1024;

bool IsReservedWindowsName(const std::string& component) {
  const auto dot = component.find('.');
  std::string base = component.substr(0, dot);
  std::transform(base.begin(), base.end(), base.begin(),
                 [](unsigned char c) { return static_cast<char>(std::toupper(c)); });
  if (base == "CON" || base == "PRN" || base == "AUX" || base == "NUL" ||
      base == "CONIN$" || base == "CONOUT$") return true;
  const bool serial_device = base.rfind("COM", 0) == 0 || base.rfind("LPT", 0) == 0;
  if (serial_device && base.size() == 4 && base[3] >= '1' && base[3] <= '9') return true;
  // Windows also reserves COM/LPT superscript 1, 2 and 3 (UTF-8 C2 B9/B2/B3).
  if (serial_device && base.size() == 5 &&
      (base.compare(3, 2, "\xC2\xB9") == 0 ||
       base.compare(3, 2, "\xC2\xB2") == 0 ||
       base.compare(3, 2, "\xC2\xB3") == 0)) return true;
  return false;
}

bool IsValidUtf8(const std::string& value) {
  const auto continuation = [&](std::size_t index) {
    return index < value.size() &&
        (static_cast<unsigned char>(value[index]) & 0xC0) == 0x80;
  };
  std::size_t i = 0;
  while (i < value.size()) {
    const auto first = static_cast<unsigned char>(value[i]);
    if (first <= 0x7F) { ++i; continue; }
    if (first >= 0xC2 && first <= 0xDF) {
      if (!continuation(i + 1)) return false;
      i += 2;
      continue;
    }
    if (first == 0xE0) {
      if (i + 2 >= value.size() ||
          static_cast<unsigned char>(value[i + 1]) < 0xA0 ||
          static_cast<unsigned char>(value[i + 1]) > 0xBF || !continuation(i + 2)) return false;
      i += 3;
      continue;
    }
    if ((first >= 0xE1 && first <= 0xEC) || (first >= 0xEE && first <= 0xEF)) {
      if (!continuation(i + 1) || !continuation(i + 2)) return false;
      i += 3;
      continue;
    }
    if (first == 0xED) {
      if (i + 2 >= value.size() ||
          static_cast<unsigned char>(value[i + 1]) < 0x80 ||
          static_cast<unsigned char>(value[i + 1]) > 0x9F || !continuation(i + 2)) return false;
      i += 3;
      continue;
    }
    if (first == 0xF0) {
      if (i + 3 >= value.size() ||
          static_cast<unsigned char>(value[i + 1]) < 0x90 ||
          static_cast<unsigned char>(value[i + 1]) > 0xBF ||
          !continuation(i + 2) || !continuation(i + 3)) return false;
      i += 4;
      continue;
    }
    if (first >= 0xF1 && first <= 0xF3) {
      if (!continuation(i + 1) || !continuation(i + 2) || !continuation(i + 3)) return false;
      i += 4;
      continue;
    }
    if (first == 0xF4) {
      if (i + 3 >= value.size() ||
          static_cast<unsigned char>(value[i + 1]) < 0x80 ||
          static_cast<unsigned char>(value[i + 1]) > 0x8F ||
          !continuation(i + 2) || !continuation(i + 3)) return false;
      i += 4;
      continue;
    }
    return false;
  }
  return true;
}

bool IsPortableComponent(const std::string& component) {
  if (!IsValidUtf8(component) || component.empty() || component == "." || component == ".." ||
      component.size() > kMaxComponentBytes || component.back() == '.' ||
      component.back() == ' ' || IsReservedWindowsName(component)) return false;
  return std::none_of(component.begin(), component.end(), [](unsigned char value) {
    return value < 0x20 || value == 0x7f || value == '<' || value == '>' ||
        value == ':' || value == '"' || value == '/' || value == '\\' ||
        value == '|' || value == '?' || value == '*';
  });
}

Segments ParseSegments(const Napi::Value& value, bool allow_root) {
  if (!value.IsArray()) throw Napi::TypeError::New(value.Env(), "path must be an array of components");
  const auto array = value.As<Napi::Array>();
  const auto length = array.Length();
  if (length > kMaxDepth) throw Napi::RangeError::New(value.Env(), "path depth exceeds native filesystem limit");
  if (!allow_root && length == 0) throw Napi::TypeError::New(value.Env(), "root cannot be used as a file target");

  Segments result;
  result.reserve(length);
  for (std::uint32_t i = 0; i < length; ++i) {
    const auto item = array.Get(i);
    if (!item.IsString()) throw Napi::TypeError::New(value.Env(), "path components must be strings");
    const std::string component = item.As<Napi::String>().Utf8Value();
    if (!IsPortableComponent(component)) {
      throw Napi::TypeError::New(value.Env(), "invalid or non-portable path component");
    }
    result.push_back(component);
  }
  return result;
}

std::size_t ParseLimit(const Napi::Value& value, std::size_t minimum, std::size_t maximum,
                       const char* label) {
  if (!value.IsNumber()) throw Napi::TypeError::New(value.Env(), std::string(label) + " must be a number");
  const double number = value.As<Napi::Number>().DoubleValue();
  if (!std::isfinite(number) || std::floor(number) != number ||
      number < static_cast<double>(minimum) || number > static_cast<double>(maximum)) {
    throw Napi::RangeError::New(value.Env(), std::string(label) + " is outside the supported range");
  }
  return static_cast<std::size_t>(number);
}

bool ParseBoolean(const Napi::Value& value, bool fallback = false) {
  if (value.IsUndefined()) return fallback;
  if (!value.IsBoolean()) throw Napi::TypeError::New(value.Env(), "expected a boolean option");
  return value.As<Napi::Boolean>().Value();
}

std::vector<std::uint8_t> ParseBuffer(const Napi::Value& value) {
  if (!value.IsBuffer()) throw Napi::TypeError::New(value.Env(), "file content must be a Buffer");
  const auto buffer = value.As<Napi::Buffer<std::uint8_t>>();
  if (buffer.Length() == 0) return {};
  return std::vector<std::uint8_t>(buffer.Data(), buffer.Data() + buffer.Length());
}

Napi::Object ToJsStat(Napi::Env env, const Stat& stat) {
  Napi::Object result = Napi::Object::New(env);
  result.Set("type", stat.directory ? "directory" : stat.regular ? "file" : "other");
  result.Set("size", Napi::Number::New(env, static_cast<double>(stat.size)));
  result.Set("links", Napi::Number::New(env, static_cast<double>(stat.links)));
  result.Set("device", Napi::String::New(env, std::to_string(stat.device)));
  result.Set("inode", Napi::String::New(env, std::to_string(stat.inode)));
  result.Set("mtimeMs", Napi::Number::New(env, static_cast<double>(stat.mtime_ms)));
  result.Set("birthtimeMs", Napi::Number::New(env, static_cast<double>(stat.birthtime_ms)));
  return result;
}

Napi::Array ToJsEntries(Napi::Env env, const std::vector<Entry>& entries) {
  Napi::Array result = Napi::Array::New(env);
  std::uint32_t index = 0;
  for (const auto& entry : entries) {
    // Do not surface POSIX-only names that the cross-platform path parser
    // intentionally refuses; otherwise Theia would list entries it cannot stat.
    if (!IsPortableComponent(entry.name)) continue;
    Napi::Object item = Napi::Object::New(env);
    item.Set("name", Napi::String::New(env, entry.name));
    item.Set("type", entry.type);
    item.Set("size", Napi::Number::New(env, static_cast<double>(entry.size)));
    result.Set(index++, item);
  }
  return result;
}

class PromiseWorker final : public Napi::AsyncWorker {
 public:
  PromiseWorker(Napi::Env env, std::function<void()> execute,
                std::function<Napi::Value(Napi::Env)> resolve)
      : Napi::AsyncWorker(env, "mcode:native-fs"),
        deferred_(Napi::Promise::Deferred::New(env)),
        execute_(std::move(execute)),
        resolve_(std::move(resolve)) {}

  Napi::Promise Promise() const { return deferred_.Promise(); }

  void Execute() override {
    try {
      execute_();
    } catch (const FsError& error) {
      error_code_ = error.code();
      SetError(error.what());
    } catch (const std::exception& error) {
      error_code_ = "EIO";
      SetError(error.what());
    } catch (...) {
      error_code_ = "EIO";
      SetError("unknown native filesystem failure");
    }
  }

  void OnOK() override {
    deferred_.Resolve(resolve_(Env()));
  }

  void OnError(const Napi::Error& error) override {
    Napi::Error wrapped = Napi::Error::New(Env(), error.Message());
    if (!error_code_.empty()) wrapped.Value().Set("code", Napi::String::New(Env(), error_code_));
    deferred_.Reject(wrapped.Value());
  }

 private:
  Napi::Promise::Deferred deferred_;
  std::function<void()> execute_;
  std::function<Napi::Value(Napi::Env)> resolve_;
  std::string error_code_;
};

Napi::Value Queue(const Napi::CallbackInfo& info, std::function<void()> execute,
                  std::function<Napi::Value(Napi::Env)> resolve) {
  auto* worker = new PromiseWorker(info.Env(), std::move(execute), std::move(resolve));
  const auto promise = worker->Promise();
  worker->Queue();
  return promise;
}

class RootWrap final : public Napi::ObjectWrap<RootWrap> {
 public:
  static Napi::Function InitClass(Napi::Env env) {
    Napi::Function constructor = DefineClass(env, "NativeFsRoot", {
      InstanceMethod("stat", &RootWrap::StatPath),
      InstanceMethod("readdir", &RootWrap::ReadDirectory),
      InstanceMethod("readFile", &RootWrap::ReadFile),
      InstanceMethod("writeFile", &RootWrap::WriteFile),
      InstanceMethod("mkdir", &RootWrap::MakeDirectory),
      InstanceMethod("rename", &RootWrap::RenamePath),
      InstanceMethod("copy", &RootWrap::CopyPath),
      InstanceMethod("remove", &RootWrap::RemovePath),
      InstanceMethod("close", &RootWrap::CloseRoot),
    });
    constructor_ = Napi::Persistent(constructor);
    constructor_.SuppressDestruct();
    return constructor;
  }

  static Napi::Object NewInstance(Napi::Env env, const std::string& root_path) {
    return constructor_.New({Napi::String::New(env, root_path)}).As<Napi::Object>();
  }

  explicit RootWrap(const Napi::CallbackInfo& info) : Napi::ObjectWrap<RootWrap>(info) {
    if (info.Length() != 1 || !info[0].IsString()) {
      throw Napi::TypeError::New(info.Env(), "openRoot requires one absolute path");
    }
    const std::string root_path = info[0].As<Napi::String>().Utf8Value();
    // OS path entry points are NUL-terminated: never allow the selected root
    // to be silently truncated before it is pinned to a directory handle.
    if (root_path.find('\0') != std::string::npos) {
      throw Napi::TypeError::New(info.Env(), "native filesystem root contains a NUL byte");
    }
    try {
      root_ = std::make_shared<NativeRoot>(root_path);
    } catch (const FsError& error) {
      Napi::Error wrapped = Napi::Error::New(info.Env(), error.what());
      wrapped.Value().Set("code", error.code());
      throw wrapped;
    } catch (const std::exception& error) {
      throw Napi::Error::New(info.Env(), error.what());
    }
  }

 private:
  Napi::Value StatPath(const Napi::CallbackInfo& info) {
    if (info.Length() < 1) throw Napi::TypeError::New(info.Env(), "stat requires path components");
    const auto segments = ParseSegments(info[0], true);
    auto root = root_;
    auto result = std::make_shared<Stat>();
    return Queue(info, [root, segments, result] { *result = root->GetStat(segments); },
      [result](Napi::Env env) { return ToJsStat(env, *result); });
  }

  Napi::Value ReadDirectory(const Napi::CallbackInfo& info) {
    if (info.Length() < 1) throw Napi::TypeError::New(info.Env(), "readdir requires path components");
    const auto segments = ParseSegments(info[0], true);
    const auto limit = info.Length() > 1
      ? ParseLimit(info[1], 1, 5000, "maxEntries") : static_cast<std::size_t>(5000);
    auto root = root_;
    auto result = std::make_shared<std::vector<Entry>>();
    return Queue(info, [root, segments, limit, result] { *result = root->ReadDir(segments, limit); },
      [result](Napi::Env env) { return ToJsEntries(env, *result); });
  }

  Napi::Value ReadFile(const Napi::CallbackInfo& info) {
    if (info.Length() < 2) throw Napi::TypeError::New(info.Env(), "readFile requires path components and maxBytes");
    const auto segments = ParseSegments(info[0], false);
    const auto limit = ParseLimit(info[1], 0, 64 * 1024 * 1024, "maxBytes");
    auto root = root_;
    auto result = std::make_shared<std::vector<std::uint8_t>>();
    return Queue(info, [root, segments, limit, result] { *result = root->ReadFile(segments, limit); },
      [result](Napi::Env env) {
        if (result->empty()) return Napi::Buffer<std::uint8_t>::New(env, 0);
        return Napi::Buffer<std::uint8_t>::Copy(env, result->data(), result->size());
      });
  }

  Napi::Value WriteFile(const Napi::CallbackInfo& info) {
    if (info.Length() < 2) throw Napi::TypeError::New(info.Env(), "writeFile requires path components and Buffer");
    const auto segments = ParseSegments(info[0], false);
    if (!info[1].IsBuffer()) throw Napi::TypeError::New(info.Env(), "file content must be a Buffer");
    if (info[1].As<Napi::Buffer<std::uint8_t>>().Length() > kDefaultCopyLimit) {
      throw Napi::RangeError::New(info.Env(), "workspace file exceeds the 8 MiB write limit");
    }
    auto bytes = ParseBuffer(info[1]);
    const bool exclusive = info.Length() > 2 ? ParseBoolean(info[2]) : false;
    auto root = root_;
    return Queue(info, [root, segments, bytes, exclusive] { root->WriteFile(segments, bytes, exclusive); },
      [](Napi::Env env) { return env.Undefined(); });
  }

  Napi::Value MakeDirectory(const Napi::CallbackInfo& info) {
    if (info.Length() < 1) throw Napi::TypeError::New(info.Env(), "mkdir requires path components");
    const auto segments = ParseSegments(info[0], false);
    auto root = root_;
    return Queue(info, [root, segments] { root->MakeDir(segments); },
      [](Napi::Env env) { return env.Undefined(); });
  }

  Napi::Value RenamePath(const Napi::CallbackInfo& info) {
    if (info.Length() < 2) throw Napi::TypeError::New(info.Env(), "rename requires source and destination components");
    const auto from = ParseSegments(info[0], false);
    const auto to = ParseSegments(info[1], false);
    const bool overwrite = info.Length() > 2 ? ParseBoolean(info[2]) : false;
    auto root = root_;
    return Queue(info, [root, from, to, overwrite] { root->Rename(from, to, overwrite); },
      [](Napi::Env env) { return env.Undefined(); });
  }

  Napi::Value CopyPath(const Napi::CallbackInfo& info) {
    if (info.Length() < 2) throw Napi::TypeError::New(info.Env(), "copy requires source and destination components");
    const auto from = ParseSegments(info[0], false);
    const auto to = ParseSegments(info[1], false);
    const bool overwrite = info.Length() > 2 ? ParseBoolean(info[2]) : false;
    auto root = root_;
    return Queue(info, [root, from, to, overwrite] { root->Copy(from, to, overwrite); },
      [](Napi::Env env) { return env.Undefined(); });
  }

  Napi::Value RemovePath(const Napi::CallbackInfo& info) {
    if (info.Length() < 1) throw Napi::TypeError::New(info.Env(), "remove requires path components");
    const auto segments = ParseSegments(info[0], false);
    auto root = root_;
    return Queue(info, [root, segments] { root->Remove(segments); },
      [](Napi::Env env) { return env.Undefined(); });
  }

  Napi::Value CloseRoot(const Napi::CallbackInfo& info) {
    if (root_) root_->Close();
    return info.Env().Undefined();
  }

  std::shared_ptr<NativeRoot> root_;
  static Napi::FunctionReference constructor_;
};

Napi::FunctionReference RootWrap::constructor_;

Napi::Value OpenRoot(const Napi::CallbackInfo& info) {
  if (info.Length() != 1 || !info[0].IsString()) {
    throw Napi::TypeError::New(info.Env(), "openRoot requires one absolute path");
  }
  return RootWrap::NewInstance(info.Env(), info[0].As<Napi::String>().Utf8Value());
}

}  // namespace

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  RootWrap::InitClass(env);
  exports.Set("openRoot", Napi::Function::New(env, OpenRoot));
  exports.Set("napiVersion", Napi::Number::New(env, NAPI_VERSION));
  return exports;
}

}  // namespace mcode_fs

Napi::Object InitMcodeFs(Napi::Env env, Napi::Object exports) { return mcode_fs::Init(env, exports); }
NODE_API_MODULE(mcode_fs, InitMcodeFs)
