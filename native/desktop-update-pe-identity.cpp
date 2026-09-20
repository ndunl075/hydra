#define WIN32_LEAN_AND_MEAN
#include "desktop-update-pe-identity.h"
#include <winver.h>
#include <array>
#include <cwchar>
#include <string>

#pragma comment(lib, "version.lib")

namespace hydra_update {
namespace {

bool parse_version(const std::wstring& text, std::array<unsigned short, 4>& parts) {
  if (text.empty() || text.size() > 32) return false;
  size_t start = 0;
  for (size_t index = 0; index < 3; ++index) {
    const size_t end = text.find(L'.', start);
    if ((index < 2 && end == std::wstring::npos) ||
        (index == 2 && end != std::wstring::npos)) return false;
    const size_t stop = end == std::wstring::npos ? text.size() : end;
    if (stop == start || stop - start > 5 || (stop - start > 1 && text[start] == L'0')) return false;
    unsigned int value = 0;
    for (size_t i = start; i < stop; ++i) {
      if (text[i] < L'0' || text[i] > L'9') return false;
      value = value * 10 + static_cast<unsigned int>(text[i] - L'0');
    }
    if (value > 65535) return false;
    parts[index] = static_cast<unsigned short>(value);
    start = stop + 1;
  }
  parts[3] = 0;
  return true;
}

std::wstring trim_padding(const wchar_t* value, UINT length) {
  if (!value || length == 0 || length > 512 || value[length - 1] != L'\0') return {};
  std::wstring result(value, length - 1);
  while (!result.empty() && result.back() == L' ') result.pop_back();
  return result;
}

} // namespace

bool verify_hydra_installer_identity(HANDLE file, const std::wstring& expected_version,
  std::wstring& reason) {
  reason.clear();
  std::array<unsigned short, 4> expected{};
  if (!parse_version(expected_version, expected)) {
    reason = L"invalid expected stable version";
    return false;
  }
  if (!file || file == INVALID_HANDLE_VALUE) {
    reason = L"invalid installer handle";
    return false;
  }
  // version.dll exposes this API without a header/import library. Unlike the
  // path API, it reads the file whose write/delete-denying lease is retained.
  HMODULE version = LoadLibraryW(L"version.dll");
  if (!version) { reason = L"version reader unavailable"; return false; }
  using ReadByHandle = BOOL (WINAPI *)(DWORD, HANDLE, LPVOID*, PDWORD);
  const auto read = reinterpret_cast<ReadByHandle>(GetProcAddress(version, "GetFileVersionInfoByHandle"));
  LPVOID data = nullptr;
  DWORD length = 0;
  const bool loaded = read && read(0, file, &data, &length) && data && length >= sizeof(VS_FIXEDFILEINFO) && length <= 1024 * 1024;
  FreeLibrary(version);
  if (!loaded) {
    if (data) LocalFree(data);
    reason = L"installer version resource unavailable";
    return false;
  }
  bool accepted = false;
  do {
    void* block = nullptr;
    UINT bytes = 0;
    if (!VerQueryValueW(data, L"\\", &block, &bytes) || bytes < sizeof(VS_FIXEDFILEINFO)) break;
    const auto* fixed = static_cast<const VS_FIXEDFILEINFO*>(block);
    if (fixed->dwSignature != 0xfeef04bd ||
        HIWORD(fixed->dwProductVersionMS) != expected[0] ||
        LOWORD(fixed->dwProductVersionMS) != expected[1] ||
        HIWORD(fixed->dwProductVersionLS) != expected[2] ||
        LOWORD(fixed->dwProductVersionLS) != expected[3]) break;
    struct Translation { WORD language; WORD codepage; };
    if (!VerQueryValueW(data, L"\\VarFileInfo\\Translation", &block, &bytes) ||
        bytes == 0 || bytes % sizeof(Translation) || bytes > 64 * sizeof(Translation)) break;
    const auto* translations = static_cast<const Translation*>(block);
    const size_t count = bytes / sizeof(Translation);
    bool all_match = true;
    for (size_t i = 0; i < count; ++i) {
      wchar_t key[96]{};
      if (swprintf_s(key, L"\\StringFileInfo\\%04x%04x\\ProductName",
            translations[i].language, translations[i].codepage) < 0 ||
          !VerQueryValueW(data, key, &block, &bytes) ||
          trim_padding(static_cast<const wchar_t*>(block), bytes) != L"Hydra") { all_match = false; break; }
      if (swprintf_s(key, L"\\StringFileInfo\\%04x%04x\\ProductVersion",
            translations[i].language, translations[i].codepage) < 0 ||
          !VerQueryValueW(data, key, &block, &bytes) ||
          trim_padding(static_cast<const wchar_t*>(block), bytes) != expected_version) { all_match = false; break; }
    }
    accepted = all_match;
  } while (false);
  LocalFree(data);
  if (!accepted) reason = L"installer PE product or version differs";
  return accepted;
}

} // namespace hydra_update
