#define WIN32_LEAN_AND_MEAN
#include "desktop-update-helper-context.h"
#include <KnownFolders.h>
#include <ShlObj.h>
#include <sddl.h>
#include <winver.h>
#include <array>
#include <cwchar>
#include <vector>

#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "version.lib")

namespace hydra_update {
namespace {
constexpr wchar_t uninstall_key[] =
  L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{4C372D32-54B2-43D8-8C63-ECC31D3744A8}_is1";

bool canonical_drive_path(const std::wstring& path) {
  if (path.size() < 4 || path.size() > 1024 ||
      !((path[0] >= L'A' && path[0] <= L'Z') || (path[0] >= L'a' && path[0] <= L'z')) ||
      path[1] != L':' || path[2] != L'\\' || path.back() == L'\\') return false;
  std::vector<wchar_t> full(path.size() + 32768);
  const DWORD length = GetFullPathNameW(path.c_str(), static_cast<DWORD>(full.size()), full.data(), nullptr);
  return length == path.size() && _wcsicmp(full.data(), path.c_str()) == 0;
}

bool equal_path(const std::wstring& left, const std::wstring& right) {
  return canonical_drive_path(left) && canonical_drive_path(right) && _wcsicmp(left.c_str(), right.c_str()) == 0;
}

bool stable_version(const std::wstring& version) {
  if (version.empty() || version.size() > 32) return false;
  int periods = 0;
  bool digit = false;
  for (const wchar_t value : version) {
    if (value == L'.') { if (!digit) return false; periods++; digit = false; }
    else if (value >= L'0' && value <= L'9') digit = true;
    else return false;
  }
  return periods == 2 && digit;
}

bool known_folder(const KNOWNFOLDERID& id, std::wstring& value) {
  PWSTR raw = nullptr;
  const HRESULT status = SHGetKnownFolderPath(id, KF_FLAG_DEFAULT, nullptr, &raw);
  if (FAILED(status) || !raw) { if (raw) CoTaskMemFree(raw); return false; }
  value.assign(raw);
  CoTaskMemFree(raw);
  return canonical_drive_path(value);
}

bool read_registration(const wchar_t* name, std::wstring& value) {
  HKEY key = nullptr;
  if (RegOpenKeyExW(HKEY_CURRENT_USER, uninstall_key, 0, KEY_READ | KEY_WOW64_64KEY, &key) != ERROR_SUCCESS)
    return false;
  std::array<wchar_t, 1024> data{};
  DWORD type = 0, bytes = static_cast<DWORD>(data.size() * sizeof(wchar_t));
  const LONG status = RegQueryValueExW(key, name, nullptr, &type, reinterpret_cast<BYTE*>(data.data()), &bytes);
  RegCloseKey(key);
  if (status != ERROR_SUCCESS || type != REG_SZ || bytes < sizeof(wchar_t) || bytes > data.size() * sizeof(wchar_t) ||
      bytes % sizeof(wchar_t) != 0 || data[bytes / sizeof(wchar_t) - 1] != L'\0') return false;
  value.assign(data.data(), bytes / sizeof(wchar_t) - 1);
  return value.find(L'\0') == std::wstring::npos;
}

bool current_user(NativeInstallObservation& observation) {
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
  DWORD size = 0;
  GetTokenInformation(token, TokenUser, nullptr, 0, &size);
  if (!size || size > 4096) { CloseHandle(token); return false; }
  std::vector<unsigned char> data(size);
  TOKEN_ELEVATION elevation{};
  DWORD elevation_size = 0;
  const bool okay = GetTokenInformation(token, TokenUser, data.data(), size, &size) &&
    GetTokenInformation(token, TokenElevation, &elevation, sizeof(elevation), &elevation_size);
  if (!okay) { CloseHandle(token); return false; }
  PWSTR sid = nullptr;
  const bool converted = ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(data.data())->User.Sid, &sid) != FALSE;
  CloseHandle(token);
  if (!converted || !sid) return false;
  observation.sid.assign(sid);
  LocalFree(sid);
  observation.elevated = elevation.TokenIsElevated != 0;
  return ProcessIdToSessionId(GetCurrentProcessId(), &observation.session_id) != FALSE;
}

bool product_version(const std::wstring& executable, std::wstring& version) {
  DWORD ignored = 0;
  const DWORD size = GetFileVersionInfoSizeW(executable.c_str(), &ignored);
  if (!size || size > 1024 * 1024) return false;
  std::vector<unsigned char> data(size);
  if (!GetFileVersionInfoW(executable.c_str(), 0, size, data.data())) return false;
  VS_FIXEDFILEINFO* info = nullptr;
  UINT info_size = 0;
  if (!VerQueryValueW(data.data(), L"\\", reinterpret_cast<void**>(&info), &info_size) ||
      !info || info_size < sizeof(VS_FIXEDFILEINFO) || info->dwSignature != 0xFEEF04BD) return false;
  version = std::to_wstring(HIWORD(info->dwProductVersionMS)) + L"." +
    std::to_wstring(LOWORD(info->dwProductVersionMS)) + L"." +
    std::to_wstring(HIWORD(info->dwProductVersionLS));
  return true;
}

bool hold_component(const std::wstring& path, bool directory, NativeInstallContext& context) {
  const DWORD flags = FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : 0);
  HANDLE handle = CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ,
    nullptr, OPEN_EXISTING, flags, nullptr);
  if (handle == INVALID_HANDLE_VALUE) return false;
  BY_HANDLE_FILE_INFORMATION info{};
  if (!GetFileInformationByHandle(handle, &info) || (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
      (directory ? !(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) :
        (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) || info.nNumberOfLinks != 1)) {
    CloseHandle(handle);
    return false;
  }
  context.held_handles.push_back(handle);
  return true;
}

bool hold_path(const std::wstring& path, bool final_directory, NativeInstallContext& context) {
  if (!canonical_drive_path(path)) return false;
  if (!hold_component(path.substr(0, 3), true, context)) return false;
  for (size_t index = 3; index <= path.size(); ++index) {
    if (index != path.size() && path[index] != L'\\') continue;
    if (index == 3 || path[index - 1] == L'\\') return false;
    if (!hold_component(path.substr(0, index), index != path.size() || final_directory, context)) return false;
  }
  return true;
}
} // namespace

NativeInstallContext::~NativeInstallContext() {
  for (auto it = held_handles.rbegin(); it != held_handles.rend(); ++it) CloseHandle(*it);
}

bool canonical_operation_id(const std::wstring& id) {
  if (id.size() != 36 || id[8] != L'-' || id[13] != L'-' || id[18] != L'-' || id[23] != L'-' || id[14] != L'4' ||
      (id[19] != L'8' && id[19] != L'9' && id[19] != L'a' && id[19] != L'b')) return false;
  for (size_t i = 0; i < id.size(); ++i) {
    if (i == 8 || i == 13 || i == 18 || i == 23) continue;
    if (!((id[i] >= L'0' && id[i] <= L'9') || (id[i] >= L'a' && id[i] <= L'f'))) return false;
  }
  return true;
}

bool validate_native_install_observation(const NativeInstallObservation& observation,
  NativeInstallContext& context, std::wstring& reason) {
  const std::wstring local = observation.user_profile + L"\\AppData\\Local";
  const std::wstring roaming = observation.user_profile + L"\\AppData\\Roaming";
  const std::wstring program_files = local + L"\\Programs";
  const std::wstring installation = program_files + L"\\Hydra";
  const std::wstring executable = installation + L"\\Hydra.exe";
  const std::wstring helper = installation + L"\\tools\\HydraUpdateVerify.exe";
  const std::wstring profile = roaming + L"\\Hydra";
  if (observation.sid.size() < 8 || observation.sid.size() > 128 || observation.sid.rfind(L"S-1-", 0) != 0 ||
      observation.session_id == 0 || observation.elevated ||
      !equal_path(observation.local_app_data, local) || !equal_path(observation.roaming_app_data, roaming) ||
      !equal_path(observation.user_program_files, program_files) || !equal_path(observation.helper_path, helper) ||
      !equal_path(observation.registered_path, installation) || observation.registered_name != L"Hydra" ||
      !stable_version(observation.registered_version) || observation.registered_version != observation.executable_version) {
    reason = L"installed user identity differs";
    return false;
  }
  context.sid = observation.sid;
  context.session_id = observation.session_id;
  context.installation_path = installation;
  context.executable_path = executable;
  context.helper_path = helper;
  context.profile_path = profile;
  context.version = observation.executable_version;
  reason.clear();
  return true;
}

bool derive_native_install_context(NativeInstallContext& context, std::wstring& reason) {
  NativeInstallObservation observation{};
  std::array<wchar_t, 32768> path{};
  const DWORD length = GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()));
  if (!length || length >= path.size()) { reason = L"helper path unavailable"; return false; }
  observation.helper_path.assign(path.data(), length);
  if (!current_user(observation) || !known_folder(FOLDERID_Profile, observation.user_profile) ||
      !known_folder(FOLDERID_LocalAppData, observation.local_app_data) ||
      !known_folder(FOLDERID_RoamingAppData, observation.roaming_app_data) ||
      !known_folder(FOLDERID_UserProgramFiles, observation.user_program_files) ||
      !read_registration(L"Inno Setup: App Path", observation.registered_path) ||
      !read_registration(L"DisplayName", observation.registered_name) ||
      !read_registration(L"DisplayVersion", observation.registered_version)) {
    reason = L"OS user or registration unavailable"; return false;
  }
  if (!product_version(observation.registered_path + L"\\Hydra.exe", observation.executable_version) ||
      !validate_native_install_observation(observation, context, reason)) return false;
  if (!hold_path(context.installation_path, true, context) || !hold_path(context.profile_path, true, context) ||
      !hold_path(context.executable_path, false, context) || !hold_path(context.helper_path, false, context)) {
    reason = L"installed path is missing, reparsed, or linked"; return false;
  }
  std::wstring held_version, registered_path, registered_name, registered_version;
  if (!product_version(context.executable_path, held_version) || held_version != context.version ||
      !read_registration(L"Inno Setup: App Path", registered_path) ||
      !read_registration(L"DisplayName", registered_name) ||
      !read_registration(L"DisplayVersion", registered_version) ||
      !equal_path(registered_path, context.installation_path) || registered_name != L"Hydra" ||
      registered_version != context.version) {
    reason = L"installed identity changed during preflight"; return false;
  }
  return true;
}

#ifdef HYDRA_UPDATE_CONTEXT_FIXTURE
bool fixture_hold_native_path(const std::wstring& path, bool directory, NativeInstallContext& context) {
  return hold_path(path, directory, context);
}
#endif

} // namespace hydra_update
