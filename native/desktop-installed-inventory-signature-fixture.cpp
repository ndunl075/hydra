#define WIN32_LEAN_AND_MEAN
#include "desktop-installed-inventory-signature.h"
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <iterator>

#ifdef HYDRA_INVENTORY_SIGNATURE_FIXTURE
#include "fixture-public-key.h"
#endif

namespace {
std::vector<unsigned char> read(const wchar_t* name) {
  std::ifstream input(std::filesystem::path(name), std::ios::binary);
  if (!input) throw std::runtime_error("fixture file unavailable");
  return { std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>() };
}
} // namespace

int wmain(int count, wchar_t** arguments) {
  if (count != 3 && count != 4) return 64;
  try {
    auto inventory = read(arguments[1]);
    const auto detached = read(arguments[2]);
    hydra_update::InventoryByteAuthentication result;
#ifdef HYDRA_INVENTORY_SIGNATURE_FIXTURE
    const bool invalid_root = count == 4 && std::wstring(arguments[3]) == L"--invalid-root";
    if (count == 4 && !invalid_root) return 64;
    result = hydra_update::fixture_authenticate_installed_inventory_bytes(
      inventory.data(), inventory.size(), detached.data(), detached.size(),
      invalid_root ? fixture_invalid_public_key : fixture_public_key);
#else
    if (count != 3) return 64;
    result = hydra_update::authenticate_installed_inventory_bytes(
      inventory.data(), inventory.size(), detached.data(), detached.size());
#endif
    if (!result.accepted) { std::wcout << L"refused: " << result.reason << L"\n"; return 1; }
    if (result.bytes.size() != inventory.size()) return 2;
    if (!inventory.empty()) {
      const unsigned char original = result.bytes.front();
      inventory.front() ^= 1;
      if (result.bytes.front() != original) return 2;
    }
    std::cout << "accepted bytes=" << result.bytes.size() << " sha256=";
    for (const unsigned char byte : result.sha256)
      std::cout << std::hex << std::setw(2) << std::setfill('0') << static_cast<unsigned>(byte);
    std::cout << '\n';
    return 0;
  } catch (const std::exception&) { return 3; }
}
