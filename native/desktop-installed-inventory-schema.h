#pragma once

#ifdef _WIN32
#include <array>
#include <cstdint>
#include <string>
#include <vector>

namespace hydra_update {

struct InstalledInventoryFile {
  std::wstring path;
  std::uint64_t bytes = 0;
  std::array<unsigned char, 32> sha256{};
};

struct InstalledInventorySchema {
  bool accepted = false;
  std::wstring reason;
  std::wstring version;
  std::vector<InstalledInventoryFile> files;
};

// Parse only bytes already retained by the signature verifier. This accepts
// the exact field order and compact JSON emitted by createInstalledInventory.
// It does not authenticate a signature or inspect the installation tree.
InstalledInventorySchema parse_installed_inventory_schema(
  const std::vector<unsigned char>& authenticated_bytes);

} // namespace hydra_update
#endif
