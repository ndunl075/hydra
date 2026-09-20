#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include "desktop-update-verifier.h"
#include <algorithm>
#include <bcrypt.h>
#include <softpub.h>
#include <wincrypt.h>
#include <wintrust.h>
#include <array>
#include <cstring>
#include <vector>

#pragma comment(lib, "bcrypt.lib")
#pragma comment(lib, "crypt32.lib")
#pragma comment(lib, "wintrust.lib")

namespace hydra_update {
namespace {

VerificationResult refuse(const wchar_t* why, LONG status = 0) {
  return { false, status, why };
}

bool sha256_of_handle(HANDLE file, unsigned long long expected_size,
  std::array<unsigned char, 32>& digest) {
  LARGE_INTEGER size{};
  if (!GetFileSizeEx(file, &size) || size.QuadPart < 0 ||
      static_cast<unsigned long long>(size.QuadPart) != expected_size) return false;
  LARGE_INTEGER start{};
  if (!SetFilePointerEx(file, start, nullptr, FILE_BEGIN)) return false;
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  bool okay = false;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) == 0 &&
      BCryptCreateHash(algorithm, &hash, nullptr, 0, nullptr, 0, 0) == 0) {
    std::array<unsigned char, 64 * 1024> block{};
    unsigned long long total = 0;
    while (total < expected_size) {
      DWORD read = 0;
      const DWORD requested = static_cast<DWORD>(std::min<unsigned long long>(block.size(), expected_size - total));
      if (!ReadFile(file, block.data(), requested, &read, nullptr) || read == 0) break;
      if (BCryptHashData(hash, block.data(), read, 0) != 0) break;
      total += read;
    }
    if (total == expected_size && BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()), 0) == 0) okay = true;
  }
  if (hash) BCryptDestroyHash(hash);
  if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0);
  return okay;
}

bool leaf_certificate_policy(PCCERT_CONTEXT cert, std::wstring& reason) {
  if (!cert || !cert->pCertInfo || CertVerifyTimeValidity(nullptr, cert->pCertInfo) != 0) {
    reason = L"verified signing certificate is not currently valid";
    return false;
  }
  const CERT_EXTENSION* extension = CertFindExtension(szOID_ENHANCED_KEY_USAGE,
    cert->pCertInfo->cExtension, cert->pCertInfo->rgExtension);
  if (!extension || !extension->Value.pbData || !extension->Value.cbData) {
    reason = L"verified signing certificate lacks a code-signing EKU";
    return false;
  }
  DWORD size = 0;
  if (!CryptDecodeObject(X509_ASN_ENCODING, X509_ENHANCED_KEY_USAGE,
      extension->Value.pbData, extension->Value.cbData, 0, nullptr, &size) ||
      size < sizeof(CERT_ENHKEY_USAGE) || size > 4096) {
    reason = L"verified signing certificate EKU is invalid";
    return false;
  }
  std::vector<unsigned char> decoded(size);
  if (!CryptDecodeObject(X509_ASN_ENCODING, X509_ENHANCED_KEY_USAGE,
      extension->Value.pbData, extension->Value.cbData, 0, decoded.data(), &size)) {
    reason = L"verified signing certificate EKU is invalid";
    return false;
  }
  const auto* usage = reinterpret_cast<const CERT_ENHKEY_USAGE*>(decoded.data());
  bool code_signing = false;
  for (DWORD index = 0; index < usage->cUsageIdentifier; ++index) {
    if (usage->rgpszUsageIdentifier && usage->rgpszUsageIdentifier[index] &&
        std::strcmp(usage->rgpszUsageIdentifier[index], szOID_PKIX_KP_CODE_SIGNING) == 0) code_signing = true;
  }
  if (!code_signing) reason = L"verified signing certificate lacks a code-signing EKU";
  return code_signing;
}

bool signer_matches(HANDLE state, const ExpectedSigner& allowed, std::wstring& mismatch) {
  HMODULE wintrust = GetModuleHandleW(L"wintrust.dll");
  if (!wintrust) return false;
  const auto provider = reinterpret_cast<decltype(&WTHelperProvDataFromStateData)>(
    GetProcAddress(wintrust, "WTHelperProvDataFromStateData"));
  const auto signer_from_chain = reinterpret_cast<decltype(&WTHelperGetProvSignerFromChain)>(
    GetProcAddress(wintrust, "WTHelperGetProvSignerFromChain"));
  if (!provider || !signer_from_chain) return false;
  CRYPT_PROVIDER_DATA* data = provider(state);
  if (!data || data->csSigners != 1) return false;
  CRYPT_PROVIDER_SGNR* signer = signer_from_chain(data, 0, FALSE, 0);
  if (!signer || signer->csCertChain == 0 || !signer->pasCertChain || !signer->pasCertChain[0].pCert) return false;
  PCCERT_CONTEXT cert = signer->pasCertChain[0].pCert;
  if (!leaf_certificate_policy(cert, mismatch)) return false;
  DWORD thumb_bytes = 20;
  std::array<unsigned char, 20> thumb{};
  if (!CryptHashCertificate(0, CALG_SHA1, 0, cert->pbCertEncoded, cert->cbCertEncoded, thumb.data(), &thumb_bytes) ||
      thumb_bytes != thumb.size() || thumb != allowed.thumbprint) { mismatch = L"verified certificate thumbprint differs"; return false; }
  DWORD name_format = CERT_X500_NAME_STR | CERT_NAME_STR_REVERSE_FLAG;
  DWORD chars = CertGetNameStringW(cert, CERT_NAME_RDN_TYPE, 0, &name_format, nullptr, 0);
  if (chars <= 1 || chars > 513) return false;
  std::vector<wchar_t> name(chars);
  if (CertGetNameStringW(cert, CERT_NAME_RDN_TYPE, 0, &name_format, name.data(), chars) != chars) return false;
  if (std::wstring(name.data()) != allowed.subject) { mismatch = L"verified certificate subject differs: " + std::wstring(name.data()); return false; }
  return true;
}

using TrustCall = decltype(&WinVerifyTrust);
using SignerCheck = bool (*)(HANDLE, const ExpectedSigner&, std::wstring&);

VerificationResult verify_trust(HANDLE file, const wchar_t* absolute_path,
  const ExpectedSigner& allowed_signer, TrustCall trust_call, SignerCheck signer_check) {
  WINTRUST_FILE_INFO file_info{};
  file_info.cbStruct = sizeof(file_info);
  file_info.pcwszFilePath = absolute_path;
  file_info.hFile = file;
  WINTRUST_DATA data{};
  data.cbStruct = sizeof(data);
  data.dwUIChoice = WTD_UI_NONE;
  data.fdwRevocationChecks = WTD_REVOKE_WHOLECHAIN;
  data.dwUnionChoice = WTD_CHOICE_FILE;
  data.pFile = &file_info;
  data.dwStateAction = WTD_STATEACTION_VERIFY;
  data.dwProvFlags = WTD_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT | WTD_LIFETIME_SIGNING_FLAG;
  GUID action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
  const LONG status = trust_call(nullptr, &action, &data);
  // WinTrust requires CLOSE after every VERIFY, including failed calls that
  // return no state handle. Keep the state alive through signer inspection.
  struct CloseTrustState {
    WINTRUST_DATA& data;
    GUID& action;
    TrustCall call;
    ~CloseTrustState() {
      data.dwStateAction = WTD_STATEACTION_CLOSE;
      call(nullptr, &action, &data);
    }
  } close{ data, action, trust_call };
  if (status != 0) return refuse(L"Windows Authenticode trust refused", status);
  std::wstring mismatch;
  if (!data.hWVTStateData || !signer_check(data.hWVTStateData, allowed_signer, mismatch))
    return { false, status, mismatch.empty() ? L"verified signer is unavailable" : mismatch };
  return { true, status, L"verified" };
}

} // namespace

VerificationResult verify_signed_installer(HANDLE file, const wchar_t* absolute_path,
  const std::array<unsigned char, 32>& signed_sha256, unsigned long long signed_bytes,
  const ExpectedSigner& allowed_signer) {
  if (!file || file == INVALID_HANDLE_VALUE || !absolute_path || !*absolute_path ||
      signed_bytes == 0 || signed_bytes > 1024ULL * 1024 * 1024 || allowed_signer.subject.empty())
    return refuse(L"invalid verifier input");
  BY_HANDLE_FILE_INFORMATION info{};
  if (!GetFileInformationByHandle(file, &info) ||
      (info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) ||
      info.nNumberOfLinks != 1) return refuse(L"file type or link count refused");
  std::array<unsigned char, 32> actual{};
  if (!sha256_of_handle(file, signed_bytes, actual) || actual != signed_sha256)
    return refuse(L"signed length or SHA-256 differs");
  return verify_trust(file, absolute_path, allowed_signer, WinVerifyTrust, signer_matches);
}

#ifdef HYDRA_UPDATE_VERIFIER_FIXTURE
VerificationResult fixture_verify_trust(HANDLE file, const wchar_t* absolute_path,
  const ExpectedSigner& allowed_signer, FixtureTrustCall trust_call, FixtureSignerCheck signer_check) {
  return verify_trust(file, absolute_path, allowed_signer, trust_call, signer_check);
}

bool fixture_leaf_certificate_policy(PCCERT_CONTEXT certificate, std::wstring& reason) {
  return leaf_certificate_policy(certificate, reason);
}
#endif

} // namespace hydra_update
