#pragma once

#ifdef _WIN32
#include <windows.h>
#include <array>
#include <string>

namespace hydra_update {

struct ExpectedSigner {
  std::wstring subject;
  std::array<unsigned char, 20> thumbprint;
};

struct VerificationResult {
  bool accepted = false;
  LONG trust_status = 0;
  std::wstring reason;
};

// The caller owns and retains `file` for the entire trust decision. It must
// deny FILE_SHARE_WRITE and FILE_SHARE_DELETE, and must not point to a reparse
// target. This verifier does not authorize or launch an installer.
VerificationResult verify_signed_installer(HANDLE file, const wchar_t* absolute_path,
  const std::array<unsigned char, 32>& signed_sha256, unsigned long long signed_bytes,
  const ExpectedSigner& allowed_signer);

} // namespace hydra_update
#endif
