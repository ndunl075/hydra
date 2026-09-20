#include "desktop-update-staged-verifier.h"

namespace hydra_update {

VerificationResult verify_staged_installer(const std::wstring& user_data,
  const std::wstring& operation_id, const std::array<unsigned char, 32>& signed_sha256,
  unsigned long long signed_bytes, const ExpectedSigner& allowed_signer,
  StagedFileLease& lease) {
  lease.close();
  std::wstring reason;
  if (!open_staged_file(user_data, operation_id, lease, reason))
    return { false, 0, reason };
  const VerificationResult result = verify_signed_installer(lease.file, lease.path.c_str(),
    signed_sha256, signed_bytes, allowed_signer);
  if (!result.accepted) lease.close();
  return result;
}

} // namespace hydra_update
