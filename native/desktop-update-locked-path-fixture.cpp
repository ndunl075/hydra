#define WIN32_LEAN_AND_MEAN
#include "desktop-update-locked-path.h"
#include <cwchar>
#include <iostream>

// Test executable only. A production helper must derive its profile root.
int wmain(int count, wchar_t** arguments) {
  if (count != 4 && count != 5) return 64;
  if (std::wcscmp(arguments[1], L"--fixture") != 0) return 64;
  hydra_update::StagedFileLease lease;
  std::wstring reason;
  if (!hydra_update::open_staged_file(arguments[2], arguments[3], lease, reason)) {
    std::wcout << L"refused;reason=" << reason << L'\n';
    return 2;
  }
  std::wcout << L"locked" << std::endl;
  if (count == 5) {
    wchar_t* end = nullptr;
    const unsigned long ms = std::wcstoul(arguments[4], &end, 10);
    if (!end || *end || ms > 5000) return 64;
    Sleep(ms);
  }
  std::wcout << L"released" << std::endl;
  return 0;
}
