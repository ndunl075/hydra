#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include "desktop-installed-inventory-signature.h"
#include "desktop-installed-inventory-schema.h"
#include "desktop-installed-inventory-tree.h"
#include "fixture-public-key.h"
#include <windows.h>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <vector>

namespace {
std::vector<unsigned char> read(const wchar_t* name) {
  std::ifstream input(std::filesystem::path(name), std::ios::binary);
  if (!input) throw std::runtime_error("fixture file unavailable");
  return { std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>() };
}
}

int wmain(int count, wchar_t** arguments) {
  if (count != 4) return 64;
  try {
    const auto inventory = read(arguments[1]);
    const auto signature = read(arguments[2]);
    const auto authenticated = hydra_update::fixture_authenticate_installed_inventory_bytes(
      inventory.data(), inventory.size(), signature.data(), signature.size(), fixture_public_key);
    if (!authenticated.accepted) { std::wcout << L"refused: signature\n"; return 1; }
    const auto schema = hydra_update::parse_installed_inventory_schema(authenticated.bytes);
    if (!schema.accepted) { std::wcout << L"refused: schema\n"; return 1; }
    hydra_update::InstalledTreeLease lease;
    std::wstring reason;
    if (!hydra_update::verify_installed_payload_tree(arguments[3], schema, lease, reason)) {
      std::wcout << L"refused: " << reason << L"\n"; return 1;
    }
    const std::wstring root(arguments[3]);
    const std::wstring file = root + L"\\Hydra.exe";
    const HANDLE writer = CreateFileW(file.c_str(), GENERIC_WRITE,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (writer != INVALID_HANDLE_VALUE) { CloseHandle(writer); std::wcout << L"unsafe: write opened\n"; return 2; }
    if (MoveFileExW(file.c_str(), (root + L"\\renamed.exe").c_str(), 0)) {
      std::wcout << L"unsafe: rename succeeded\n"; return 2;
    }
    HANDLE new_file = CreateFileW((root + L"\\surprise.txt").c_str(), GENERIC_WRITE,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    const bool added_during_lease = new_file != INVALID_HANDLE_VALUE;
    if (!added_during_lease) {
      lease.close();
      new_file = CreateFileW((root + L"\\surprise.txt").c_str(), GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
      if (new_file == INVALID_HANDLE_VALUE) return 2;
    }
    CloseHandle(new_file);
    hydra_update::InstalledTreeLease recheck;
    if (hydra_update::verify_installed_payload_tree(root, schema, recheck, reason)) {
      std::wcout << L"unsafe: added file passed recheck\n"; return 2;
    }
    lease.close();
    const HANDLE released_writer = CreateFileW(file.c_str(), GENERIC_WRITE,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (released_writer == INVALID_HANDLE_VALUE) {
      std::wcout << L"unsafe: file handle remained locked after release\n"; return 2;
    }
    CloseHandle(released_writer);
    std::wcout << L"accepted snapshot files=" << schema.files.size()
      << L"; held files deny write and rename; new file while leased="
      << (added_during_lease ? L"yes" : L"no") << L"; recheck refused\n";
    return 0;
  } catch (const std::exception&) { return 3; }
}
