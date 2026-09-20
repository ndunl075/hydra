#define WIN32_LEAN_AND_MEAN
#include "desktop-update-verifier.h"
#include <winerror.h>
#include <iostream>

namespace {
LONG next_status = 0;
bool provide_state = true;
bool match_signer = true;
int verify_calls = 0;
int close_calls = 0;
int signer_calls = 0;
bool policy_flags = true;

LONG WINAPI fake_trust(HWND, GUID*, LPVOID raw) {
  auto* data = static_cast<WINTRUST_DATA*>(raw);
  if (data->dwStateAction == WTD_STATEACTION_VERIFY) {
    ++verify_calls;
    policy_flags = policy_flags && data->fdwRevocationChecks == WTD_REVOKE_WHOLECHAIN &&
      data->dwProvFlags == (WTD_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT | WTD_LIFETIME_SIGNING_FLAG) &&
      data->dwUIChoice == WTD_UI_NONE;
    data->hWVTStateData = provide_state ? reinterpret_cast<HANDLE>(1) : nullptr;
    return next_status;
  }
  if (data->dwStateAction == WTD_STATEACTION_CLOSE) { ++close_calls; return 0; }
  return TRUST_E_SUBJECT_NOT_TRUSTED;
}

bool fake_signer(HANDLE, const hydra_update::ExpectedSigner&, std::wstring& reason) {
  ++signer_calls;
  if (!match_signer) reason = L"signer differs";
  return match_signer;
}

bool trust_case(LONG status, bool state, bool signer, bool accepted) {
  next_status = status;
  provide_state = state;
  match_signer = signer;
  verify_calls = close_calls = signer_calls = 0;
  policy_flags = true;
  const hydra_update::ExpectedSigner allowed{ L"fixture", {} };
  const auto result = hydra_update::fixture_verify_trust(reinterpret_cast<HANDLE>(1),
    L"C:\\fixture\\installer.exe", allowed, fake_trust, fake_signer);
  return result.accepted == accepted && result.trust_status == status &&
    verify_calls == 1 && close_calls == 1 && signer_calls == (status == 0 && state ? 1 : 0) && policy_flags;
}

FILETIME day_from_now(int offset) {
  FILETIME now{};
  GetSystemTimeAsFileTime(&now);
  ULARGE_INTEGER value{};
  value.LowPart = now.dwLowDateTime;
  value.HighPart = now.dwHighDateTime;
  value.QuadPart += static_cast<LONGLONG>(offset) * 86400LL * 10000000LL;
  FILETIME shifted{};
  shifted.dwLowDateTime = value.LowPart;
  shifted.dwHighDateTime = value.HighPart;
  return shifted;
}

bool leaf_case(int not_before, int not_after, const unsigned char* eku, DWORD eku_length, bool accepted) {
  CERT_EXTENSION extension{};
  extension.pszObjId = const_cast<LPSTR>(szOID_ENHANCED_KEY_USAGE);
  extension.Value.cbData = eku_length;
  extension.Value.pbData = const_cast<BYTE*>(eku);
  CERT_INFO info{};
  info.NotBefore = day_from_now(not_before);
  info.NotAfter = day_from_now(not_after);
  info.cExtension = eku ? 1 : 0;
  info.rgExtension = eku ? &extension : nullptr;
  CERT_CONTEXT certificate{};
  certificate.pCertInfo = &info;
  std::wstring reason;
  return hydra_update::fixture_leaf_certificate_policy(&certificate, reason) == accepted &&
    (accepted || !reason.empty());
}
} // namespace

int wmain() {
  const unsigned char code_signing[] = { 0x30, 0x0a, 0x06, 0x08, 0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x03 };
  const unsigned char server_auth[] = { 0x30, 0x0a, 0x06, 0x08, 0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01 };
  const unsigned char malformed[] = { 0x30, 0x02, 0x06 };
  const bool okay =
    trust_case(0, true, true, true) &&
    trust_case(0, false, true, false) &&
    trust_case(0, true, false, false) &&
    trust_case(CERT_E_REVOKED, true, true, false) &&
    trust_case(CERT_E_EXPIRED, false, true, false) &&
    trust_case(CRYPT_E_REVOCATION_OFFLINE, false, true, false) &&
    trust_case(TRUST_E_SUBJECT_NOT_TRUSTED, true, true, false) &&
    leaf_case(-1, 1, code_signing, sizeof(code_signing), true) &&
    leaf_case(-2, -1, code_signing, sizeof(code_signing), false) &&
    leaf_case(1, 2, code_signing, sizeof(code_signing), false) &&
    leaf_case(-1, 1, server_auth, sizeof(server_auth), false) &&
    leaf_case(-1, 1, nullptr, 0, false) &&
    leaf_case(-1, 1, malformed, sizeof(malformed), false);
  if (!okay) { std::wcerr << L"Native verifier policy fixture failed.\n"; return 1; }
  std::wcout << L"PASS: trust failures refuse and every VERIFY closes; current code-signing EKU required.\n";
  return 0;
}
