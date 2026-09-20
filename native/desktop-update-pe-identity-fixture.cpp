#define WIN32_LEAN_AND_MEAN
#include "desktop-update-pe-identity.h"
#include <cwchar>
#include <iostream>

// Test-only caller. Production must obtain the expected version from signed metadata.
int wmain(int count, wchar_t** arguments) {
  if (count != 4 || std::wcscmp(arguments[1], L"--fixture") != 0) return 64;
  HANDLE file = CreateFileW(arguments[2], GENERIC_READ, FILE_SHARE_READ, nullptr,
    OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (file == INVALID_HANDLE_VALUE) return 65;
  std::wstring reason;
  const bool accepted = hydra_update::verify_hydra_installer_identity(file, arguments[3], reason);
  CloseHandle(file);
  std::wcout << (accepted ? L"accepted" : L"refused") << L";reason=" << reason << L'\n';
  return accepted ? 0 : 2;
}
