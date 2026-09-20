#define WIN32_LEAN_AND_MEAN
#include "desktop-update-staged-verifier.h"
#include <array>
#include <cwchar>
#include <iostream>
#include <string>

namespace {
template <size_t N> bool parse_hex(const wchar_t* text, std::array<unsigned char, N>& bytes) {
  if (!text || std::wcslen(text) != N * 2) return false;
  const auto digit = [](wchar_t value) -> int {
    if (value >= L'0' && value <= L'9') return value - L'0';
    if (value >= L'A' && value <= L'F') return value - L'A' + 10;
    if (value >= L'a' && value <= L'f') return value - L'a' + 10;
    return -1;
  };
  for (size_t i = 0; i < N; ++i) {
    const int high = digit(text[i * 2]), low = digit(text[i * 2 + 1]);
    if (high < 0 || low < 0) return false;
    bytes[i] = static_cast<unsigned char>((high << 4) | low);
  }
  return true;
}
}

// Test executable only. Never package this caller-provided path/trust interface.
int wmain(int count, wchar_t** arguments) {
  if ((count != 8 && count != 9) || std::wcscmp(arguments[1], L"--fixture") != 0) return 64;
  std::array<unsigned char, 32> digest{};
  hydra_update::ExpectedSigner signer{};
  if (!parse_hex(arguments[4], digest) || !parse_hex(arguments[7], signer.thumbprint)) return 64;
  signer.subject = arguments[6];
  wchar_t* end = nullptr;
  const unsigned long long bytes = std::wcstoull(arguments[5], &end, 10);
  if (!end || *end) return 64;
  hydra_update::StagedFileLease lease;
  const auto result = count == 9
    ? hydra_update::verify_staged_hydra_installer(arguments[2], arguments[3],
        digest, bytes, signer, arguments[8], lease)
    : hydra_update::verify_staged_installer(arguments[2], arguments[3],
        digest, bytes, signer, lease);
  std::wcout << (result.accepted ? L"accepted" : L"refused") << L";status="
             << static_cast<unsigned long>(result.trust_status) << L";reason=" << result.reason << L'\n';
  if (result.accepted && (lease.file == INVALID_HANDLE_VALUE || lease.directories.empty())) return 3;
  if (!result.accepted && lease.file != INVALID_HANDLE_VALUE) return 4;
  return result.accepted ? 0 : 2;
}
