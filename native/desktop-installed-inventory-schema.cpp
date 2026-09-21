#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include "desktop-installed-inventory-schema.h"
#include <windows.h>
#include <algorithm>
#include <set>
#include <string_view>

namespace hydra_update {
namespace {
constexpr size_t max_manifest_bytes = 4 * 1024 * 1024;
constexpr size_t max_files = 20000;
constexpr std::uint64_t max_file_bytes = 1024ull * 1024ull * 1024ull;

InstalledInventorySchema refuse(const wchar_t* reason) {
  InstalledInventorySchema result;
  result.reason = reason;
  return result;
}

bool hex(char value) { return (value >= '0' && value <= '9') || (value >= 'a' && value <= 'f'); }
unsigned hex_value(char value) { return value <= '9' ? static_cast<unsigned>(value - '0') : static_cast<unsigned>(value - 'a' + 10); }

bool version_valid(std::string_view value) {
  unsigned components = 0;
  size_t start = 0;
  for (size_t index = 0; index <= value.size(); ++index) {
    if (index != value.size() && value[index] != '.') continue;
    const auto part = value.substr(start, index - start);
    if (part.empty() || (part.size() > 1 && part[0] == '0') ||
        !std::all_of(part.begin(), part.end(), [](char c) { return c >= '0' && c <= '9'; })) return false;
    ++components;
    start = index + 1;
  }
  return components == 3;
}

bool reserved_device(std::wstring_view part) {
  const size_t end = part.find(L'.');
  part = part.substr(0, end);
  std::wstring lowered(part);
  std::transform(lowered.begin(), lowered.end(), lowered.begin(), [](wchar_t c) {
    return c >= L'A' && c <= L'Z' ? static_cast<wchar_t>(c + (L'a' - L'A')) : c;
  });
  if (lowered == L"con" || lowered == L"prn" || lowered == L"aux" || lowered == L"nul") return true;
  return lowered.size() == 4 && (lowered.substr(0, 3) == L"com" || lowered.substr(0, 3) == L"lpt") &&
    lowered[3] >= L'1' && lowered[3] <= L'9';
}

bool safe_path(const std::wstring& path) {
  if (path.empty() || path.size() > 1024) return false;
  size_t start = 0;
  for (size_t index = 0; index <= path.size(); ++index) {
    if (index != path.size() && path[index] != L'/') continue;
    const auto part = std::wstring_view(path).substr(start, index - start);
    if (part.empty() || part.size() > 255 || part == L"." || part == L".." ||
        part.back() == L'.' || part.back() == L' ' || reserved_device(part)) return false;
    for (wchar_t value : part)
      if (value < 32 || value == L'<' || value == L'>' || value == L':' || value == L'"' ||
          value == L'\\' || value == L'|' || value == L'?' || value == L'*') return false;
    start = index + 1;
  }
  return true;
}

struct WindowsFoldLess {
  bool operator()(const std::wstring& left, const std::wstring& right) const {
    return CompareStringOrdinal(left.data(), static_cast<int>(left.size()),
      right.data(), static_cast<int>(right.size()), TRUE) == CSTR_LESS_THAN;
  }
};

class Reader {
 public:
  explicit Reader(const std::vector<unsigned char>& bytes) : bytes_(bytes) {}
  bool literal(std::string_view value) {
    if (value.size() > bytes_.size() - position_ ||
        !std::equal(value.begin(), value.end(), bytes_.begin() + position_)) return false;
    position_ += value.size();
    return true;
  }
  bool done() const { return position_ == bytes_.size(); }
  bool peek(char value) const { return position_ < bytes_.size() && bytes_[position_] == value; }
  bool string(std::string& value) {
    if (!literal("\"")) return false;
    const auto start = position_;
    while (position_ < bytes_.size() && bytes_[position_] != '"') {
      const unsigned char current = bytes_[position_++];
      // Producer uses compact JSON. Escapes cannot occur in any accepted
      // inventory field: paths reject escaped slash/quote/control characters.
      // Escaping safe characters is noncanonical JSON.stringify output.
      if (current < 32 || current == '\\') return false;
    }
    if (position_ == bytes_.size()) return false;
    value.assign(reinterpret_cast<const char*>(bytes_.data() + start), position_ - start);
    ++position_;
    return true;
  }
  bool integer(std::uint64_t maximum, std::uint64_t& value) {
    if (position_ == bytes_.size() || bytes_[position_] < '0' || bytes_[position_] > '9') return false;
    if (bytes_[position_] == '0' && position_ + 1 < bytes_.size() &&
        bytes_[position_ + 1] >= '0' && bytes_[position_ + 1] <= '9') return false;
    value = 0;
    while (position_ < bytes_.size() && bytes_[position_] >= '0' && bytes_[position_] <= '9') {
      const auto digit = static_cast<unsigned>(bytes_[position_++] - '0');
      if (value > (maximum - digit) / 10) return false;
      value = value * 10 + digit;
    }
    return true;
  }
 private:
  const std::vector<unsigned char>& bytes_;
  size_t position_ = 0;
};

bool wide(const std::string& value, std::wstring& result) {
  if (value.empty() || value.size() > 4096) return false;
  const int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
    value.data(), static_cast<int>(value.size()), nullptr, 0);
  if (length <= 0) return false;
  result.resize(static_cast<size_t>(length));
  return MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
    value.data(), static_cast<int>(value.size()), result.data(), length) == length;
}

bool fixed_string(Reader& reader, size_t length, bool (*character)(char)) {
  std::string value;
  return reader.string(value) && value.size() == length &&
    std::all_of(value.begin(), value.end(), character);
}

bool parse_file(Reader& reader, InstalledInventoryFile& file) {
  std::string path;
  std::string digest;
  if (!reader.literal("{\"path\":") || !reader.string(path) || !wide(path, file.path) || !safe_path(file.path) ||
      !reader.literal(",\"bytes\":") || !reader.integer(max_file_bytes, file.bytes) ||
      !reader.literal(",\"sha256\":") || !reader.string(digest) || digest.size() != 64 ||
      !std::all_of(digest.begin(), digest.end(), hex) || !reader.literal("}")) return false;
  for (size_t index = 0; index < file.sha256.size(); ++index)
    file.sha256[index] = static_cast<unsigned char>((hex_value(digest[index * 2]) << 4) | hex_value(digest[index * 2 + 1]));
  return true;
}
} // namespace

InstalledInventorySchema parse_installed_inventory_schema(const std::vector<unsigned char>& bytes) {
  if (bytes.empty() || bytes.size() > max_manifest_bytes) return refuse(L"inventory size is invalid");
  try {
    Reader reader(bytes);
    std::string version;
    if (!reader.literal("{\"schemaVersion\":1,\"purpose\":\"hydra-installed-code-inventory\",\"product\":\"Hydra\",\"version\":") ||
        !reader.string(version) || !version_valid(version) ||
        !reader.literal(",\"target\":{\"platform\":\"win32\",\"architecture\":\"x64\",\"installTarget\":\"user\"},\"layout\":\"inno-user-unversioned-v1\",\"sourceCommit\":") ||
        !fixed_string(reader, 40, hex) || !reader.literal(",\"upstreamCommit\":") ||
        !fixed_string(reader, 40, hex) || !reader.literal(",\"files\":[")) return refuse(L"inventory schema or provenance is invalid");
    InstalledInventorySchema result;
    result.version.assign(version.begin(), version.end());
    std::set<std::wstring, WindowsFoldLess> folded;
    std::wstring previous;
    while (!reader.peek(']')) {
      if (result.files.size() == max_files) return refuse(L"inventory file count exceeds limit");
      InstalledInventoryFile file;
      if (!parse_file(reader, file) || (!previous.empty() && file.path <= previous) ||
          !folded.insert(file.path).second) return refuse(L"inventory file entry is invalid");
      previous = file.path;
      result.files.push_back(std::move(file));
      if (!reader.peek(',')) break;
      if (!reader.literal(",")) return refuse(L"inventory file separator is invalid");
    }
    if (result.files.empty() || !reader.literal("]}") || !reader.done())
      return refuse(L"inventory document is not canonical");
    result.accepted = true;
    result.reason = L"validated inventory schema only";
    return result;
  } catch (...) { return refuse(L"inventory schema validation failed"); }
}
} // namespace hydra_update
