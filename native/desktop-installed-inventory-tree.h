#pragma once

#ifdef _WIN32
#include "desktop-installed-inventory-schema.h"
#include <windows.h>
#include <string>
#include <vector>

namespace hydra_update {

struct InstalledTreeLease {
  std::vector<HANDLE> directories;
  std::vector<HANDLE> files;
  InstalledTreeLease() = default;
  ~InstalledTreeLease();
  InstalledTreeLease(const InstalledTreeLease&) = delete;
  InstalledTreeLease& operator=(const InstalledTreeLease&) = delete;
  InstalledTreeLease(InstalledTreeLease&& other) noexcept;
  InstalledTreeLease& operator=(InstalledTreeLease&& other) noexcept;
  void close() noexcept;
};

// Fixture seam: caller supplies an exact payload-only root and a previously
// authenticated/parsed schema. Production must derive its own install root and
// account separately for installer-created metadata before connecting this.
bool verify_installed_payload_tree(const std::wstring& root,
  const InstalledInventorySchema& schema, InstalledTreeLease& lease, std::wstring& reason);

} // namespace hydra_update
#endif
