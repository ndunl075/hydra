#pragma once

#ifdef _WIN32
#include <windows.h>
#include <string>

namespace hydra_update {

// Checks the version resource on the already locked installer handle. This is
// an identity check, not an Authenticode or publisher authorization decision.
bool verify_hydra_installer_identity(HANDLE file, const std::wstring& expected_version,
  std::wstring& reason);

} // namespace hydra_update
#endif
