#define WIN32_LEAN_AND_MEAN
#include "desktop-update-locked-path.h"
#include <utility>

namespace hydra_update {

StagedFileLease::~StagedFileLease() { close(); }
StagedFileLease::StagedFileLease(StagedFileLease&& other) noexcept { *this = std::move(other); }
StagedFileLease& StagedFileLease::operator=(StagedFileLease&& other) noexcept {
  if (this != &other) {
    close();
    directories = std::move(other.directories);
    other.directories.clear();
    file = std::exchange(other.file, INVALID_HANDLE_VALUE);
    path = std::move(other.path);
  }
  return *this;
}
void StagedFileLease::close() noexcept {
  if (file != INVALID_HANDLE_VALUE) { CloseHandle(file); file = INVALID_HANDLE_VALUE; }
  for (auto it = directories.rbegin(); it != directories.rend(); ++it) CloseHandle(*it);
  directories.clear();
  path.clear();
}

namespace {
bool operation_id_valid(const std::wstring& id) {
  if (id.size() != 36 || id[8] != L'-' || id[13] != L'-' || id[18] != L'-' || id[23] != L'-' || id[14] != L'4' ||
      (id[19] != L'8' && id[19] != L'9' && id[19] != L'a' && id[19] != L'b')) return false;
  for (size_t i = 0; i < id.size(); ++i) {
    if (i == 8 || i == 13 || i == 18 || i == 23) continue;
    if (!((id[i] >= L'0' && id[i] <= L'9') || (id[i] >= L'a' && id[i] <= L'f'))) return false;
  }
  return true;
}

bool canonical_drive_path(const std::wstring& path) {
  if (path.size() < 4 || !((path[0] >= L'A' && path[0] <= L'Z') || (path[0] >= L'a' && path[0] <= L'z')) ||
      path[1] != L':' || path[2] != L'\\' || path.back() == L'\\') return false;
  std::vector<wchar_t> expanded(path.size() + 32768);
  DWORD length = GetFullPathNameW(path.c_str(), static_cast<DWORD>(expanded.size()), expanded.data(), nullptr);
  return length == path.size() && _wcsicmp(expanded.data(), path.c_str()) == 0;
}

bool lock_directory(const std::wstring& path, StagedFileLease& lease, DWORD& error) {
  HANDLE handle = CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (handle == INVALID_HANDLE_VALUE) { error = GetLastError(); return false; }
  BY_HANDLE_FILE_INFORMATION info{};
  if (!GetFileInformationByHandle(handle, &info) ||
      !(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) ||
      (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) {
    error = GetLastError();
    CloseHandle(handle);
    return false;
  }
  lease.directories.push_back(handle);
  return true;
}
}

bool open_staged_file(const std::wstring& user_data, const std::wstring& operation_id,
  StagedFileLease& lease, std::wstring& reason) {
  lease.close();
  if (!canonical_drive_path(user_data) || !operation_id_valid(operation_id)) {
    reason = L"noncanonical user-data path or operation ID"; return false;
  }
  const std::wstring directory = user_data + L"\\hydra-updater\\" + operation_id;
  StagedFileLease opened;
  std::wstring prefix = user_data.substr(0, 3);
  DWORD error = 0;
  if (!lock_directory(prefix, opened, error)) { reason = L"volume root cannot be locked: " + std::to_wstring(error); return false; }
  for (size_t index = 3; index <= directory.size(); ++index) {
    if (index != directory.size() && directory[index] != L'\\') continue;
    if (index == 3 || directory[index - 1] == L'\\') { reason = L"empty path component"; return false; }
    prefix = directory.substr(0, index);
    if (!lock_directory(prefix, opened, error)) { reason = L"staging ancestor is missing or reparsed: " + prefix + L" (" + std::to_wstring(error) + L")"; return false; }
  }
  opened.path = directory + L"\\HydraSetup.exe";
  opened.file = CreateFileW(opened.path.c_str(), GENERIC_READ, FILE_SHARE_READ,
    nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN, nullptr);
  if (opened.file == INVALID_HANDLE_VALUE) { reason = L"staged installer cannot be opened exclusively for verification"; return false; }
  BY_HANDLE_FILE_INFORMATION info{};
  if (!GetFileInformationByHandle(opened.file, &info) ||
      (info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) || info.nNumberOfLinks != 1) {
    reason = L"staged installer type or link count is unsafe"; return false;
  }
  lease = std::move(opened);
  reason.clear();
  return true;
}

} // namespace hydra_update
