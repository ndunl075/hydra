#pragma once

#ifdef _WIN32
#include "desktop-update-locked-path.h"
#include "desktop-update-verifier.h"

namespace hydra_update {

// Testable integration primitive. The production helper must derive user_data
// itself and authenticate the operation and installed trust before calling it.
// On success, the caller retains lease through any subsequent process creation.
VerificationResult verify_staged_installer(const std::wstring& user_data,
  const std::wstring& operation_id, const std::array<unsigned char, 32>& signed_sha256,
  unsigned long long signed_bytes, const ExpectedSigner& allowed_signer,
  StagedFileLease& lease);

} // namespace hydra_update
#endif
