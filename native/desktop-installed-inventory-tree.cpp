#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include "desktop-installed-inventory-tree.h"
#include <bcrypt.h>
#include <algorithm>
#include <array>
#include <map>
#include <set>
#include <utility>

#pragma comment(lib, "bcrypt.lib")

namespace hydra_update {
InstalledTreeLease::~InstalledTreeLease() { close(); }
InstalledTreeLease::InstalledTreeLease(InstalledTreeLease&& other) noexcept { *this = std::move(other); }
InstalledTreeLease& InstalledTreeLease::operator=(InstalledTreeLease&& other) noexcept {
  if (this != &other) {
    close();
    directories = std::move(other.directories);
    files = std::move(other.files);
    other.directories.clear();
    other.files.clear();
  }
  return *this;
}
void InstalledTreeLease::close() noexcept {
  for (auto it = files.rbegin(); it != files.rend(); ++it) CloseHandle(*it);
  for (auto it = directories.rbegin(); it != directories.rend(); ++it) CloseHandle(*it);
  files.clear();
  directories.clear();
}

namespace {
constexpr size_t max_directories = 40000;

struct Algorithm {
  BCRYPT_ALG_HANDLE value = nullptr;
  ~Algorithm() { if (value) BCryptCloseAlgorithmProvider(value, 0); }
};
struct Hash {
  BCRYPT_HASH_HANDLE value = nullptr;
  ~Hash() { if (value) BCryptDestroyHash(value); }
};
struct Search {
  HANDLE value = INVALID_HANDLE_VALUE;
  ~Search() { if (value != INVALID_HANDLE_VALUE) FindClose(value); }
};

bool canonical_root(const std::wstring& path) {
  if (path.size() < 4 || path.size() > 30000 ||
      !((path[0] >= L'A' && path[0] <= L'Z') || (path[0] >= L'a' && path[0] <= L'z')) ||
      path[1] != L':' || path[2] != L'\\' || path.back() == L'\\') return false;
  std::vector<wchar_t> expanded(path.size() + 32768);
  const DWORD length = GetFullPathNameW(path.c_str(), static_cast<DWORD>(expanded.size()), expanded.data(), nullptr);
  return length == path.size() && _wcsicmp(expanded.data(), path.c_str()) == 0;
}

bool lock_directory(const std::wstring& path, bool install_tree, InstalledTreeLease& lease) {
  const HANDLE handle = CreateFileW(path.c_str(),
    install_tree ? FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY : FILE_READ_ATTRIBUTES,
    install_tree ? FILE_SHARE_READ : FILE_SHARE_READ | FILE_SHARE_WRITE,
    nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (handle == INVALID_HANDLE_VALUE) return false;
  BY_HANDLE_FILE_INFORMATION info{};
  if (!GetFileInformationByHandle(handle, &info) ||
      !(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) ||
      (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) {
    CloseHandle(handle);
    return false;
  }
  lease.directories.push_back(handle);
  return true;
}

bool hash_file(HANDLE handle, std::array<unsigned char, 32>& digest) {
  Algorithm algorithm;
  Hash hash;
  if (BCryptOpenAlgorithmProvider(&algorithm.value, BCRYPT_SHA256_ALGORITHM, MS_PRIMITIVE_PROVIDER, 0) != 0 ||
      BCryptCreateHash(algorithm.value, &hash.value, nullptr, 0, nullptr, 0, 0) != 0) return false;
  std::array<unsigned char, 64 * 1024> buffer{};
  LARGE_INTEGER start{};
  if (!SetFilePointerEx(handle, start, nullptr, FILE_BEGIN)) return false;
  for (;;) {
    DWORD count = 0;
    if (!ReadFile(handle, buffer.data(), static_cast<DWORD>(buffer.size()), &count, nullptr)) return false;
    if (count == 0) break;
    if (BCryptHashData(hash.value, buffer.data(), count, 0) != 0) return false;
  }
  return BCryptFinishHash(hash.value, digest.data(), static_cast<ULONG>(digest.size()), 0) == 0;
}

bool lock_file(const std::wstring& path, const InstalledInventoryFile& expected,
  InstalledTreeLease& lease) {
  const HANDLE handle = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ,
    nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN, nullptr);
  if (handle == INVALID_HANDLE_VALUE) return false;
  BY_HANDLE_FILE_INFORMATION before{};
  BY_HANDLE_FILE_INFORMATION after{};
  std::array<unsigned char, 32> digest{};
  const bool valid = GetFileInformationByHandle(handle, &before) &&
    !(before.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) &&
    before.nNumberOfLinks == 1 &&
    ((static_cast<std::uint64_t>(before.nFileSizeHigh) << 32) | before.nFileSizeLow) == expected.bytes &&
    hash_file(handle, digest) && GetFileInformationByHandle(handle, &after) &&
    before.dwVolumeSerialNumber == after.dwVolumeSerialNumber &&
    before.nFileIndexHigh == after.nFileIndexHigh && before.nFileIndexLow == after.nFileIndexLow &&
    before.nNumberOfLinks == after.nNumberOfLinks &&
    before.nFileSizeHigh == after.nFileSizeHigh && before.nFileSizeLow == after.nFileSizeLow &&
    CompareFileTime(&before.ftLastWriteTime, &after.ftLastWriteTime) == 0 &&
    std::equal(digest.begin(), digest.end(), expected.sha256.begin());
  if (!valid) { CloseHandle(handle); return false; }
  lease.files.push_back(handle);
  return true;
}

struct Walk {
  const std::wstring& root;
  const std::map<std::wstring, const InstalledInventoryFile*>& files;
  const std::set<std::wstring>& directories;
  InstalledTreeLease& lease;
  size_t observed_files = 0;
  size_t observed_directories = 0;

  bool visit(const std::wstring& absolute, const std::wstring& relative) {
    if (++observed_directories > max_directories) return false;
    Search search;
    WIN32_FIND_DATAW entry{};
    search.value = FindFirstFileExW((absolute + L"\\*").c_str(), FindExInfoBasic, &entry,
      FindExSearchNameMatch, nullptr, 0);
    if (search.value == INVALID_HANDLE_VALUE) return GetLastError() == ERROR_FILE_NOT_FOUND;
    do {
      const std::wstring name(entry.cFileName);
      if (name == L"." || name == L"..") continue;
      if (name.empty() || name.find_first_of(L"\\/:*?\"<>|") != std::wstring::npos ||
          (entry.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) return false;
      const std::wstring child = relative.empty() ? name : relative + L"/" + name;
      const std::wstring path = absolute + L"\\" + name;
      if (entry.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
        if (!directories.count(child) || !lock_directory(path, true, lease) || !visit(path, child)) return false;
      } else {
        const auto expected = files.find(child);
        if (expected == files.end() || ++observed_files > files.size() ||
            !lock_file(path, *expected->second, lease)) return false;
      }
    } while (FindNextFileW(search.value, &entry));
    return GetLastError() == ERROR_NO_MORE_FILES;
  }
};
} // namespace

bool verify_installed_payload_tree(const std::wstring& root,
  const InstalledInventorySchema& schema, InstalledTreeLease& lease, std::wstring& reason) {
  lease.close();
  if (!schema.accepted || schema.files.empty() || !canonical_root(root)) {
    reason = L"unauthenticated schema or noncanonical install root"; return false;
  }
  InstalledTreeLease opened;
  std::wstring prefix = root.substr(0, 3);
  if (!lock_directory(prefix, false, opened)) { reason = L"volume root is unsafe"; return false; }
  for (size_t index = 3; index <= root.size(); ++index) {
    if (index != root.size() && root[index] != L'\\') continue;
    if (index == 3 || root[index - 1] == L'\\') { reason = L"empty install-root component"; return false; }
    prefix = root.substr(0, index);
    if (!lock_directory(prefix, index == root.size(), opened)) {
      reason = L"install ancestor is missing, in use, or reparsed: " + prefix; return false;
    }
  }
  std::map<std::wstring, const InstalledInventoryFile*> expected_files;
  std::set<std::wstring> expected_directories;
  for (const auto& file : schema.files) {
    if (!expected_files.emplace(file.path, &file).second) { reason = L"duplicate expected file"; return false; }
    for (size_t index = 0; index < file.path.size(); ++index)
      if (file.path[index] == L'/') expected_directories.insert(file.path.substr(0, index));
  }
  Walk walk{ root, expected_files, expected_directories, opened };
  if (!walk.visit(root, L"") || walk.observed_files != expected_files.size() ||
      walk.observed_directories != expected_directories.size() + 1) {
    reason = L"installed payload tree differs from authenticated inventory"; return false;
  }
  lease = std::move(opened);
  reason.clear();
  return true;
}
} // namespace hydra_update
