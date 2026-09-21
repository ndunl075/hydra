#pragma once

#ifdef _WIN32
#include <array>
#include <cstddef>
#include <string>
#include <vector>

namespace hydra_update {

struct InventoryByteAuthentication {
  bool accepted = false;
  std::wstring reason;
  std::array<unsigned char, 32> sha256{};
  // Parse only this retained copy after authentication, never a caller path.
  std::vector<unsigned char> bytes;
};

// No release-owner inventory key is compiled yet. Production always refuses.
InventoryByteAuthentication authenticate_installed_inventory_bytes(
  const unsigned char* inventory, size_t inventory_bytes,
  const unsigned char* detached, size_t detached_bytes);

#ifdef HYDRA_INVENTORY_SIGNATURE_FIXTURE
// Fixture-only trusted root injection. Never expose this overload in the
// packaged helper or select a key from a file, CLI, or renderer request.
InventoryByteAuthentication fixture_authenticate_installed_inventory_bytes(
  const unsigned char* inventory, size_t inventory_bytes,
  const unsigned char* detached, size_t detached_bytes,
  const std::array<unsigned char, 64>& compiled_test_root);
#endif

} // namespace hydra_update
#endif
