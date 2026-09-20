#define WIN32_LEAN_AND_MEAN
#include "desktop-update-helper-context.h"
#include "desktop-update-helper-policy.h"
#include <cwchar>
#include <iostream>


// Production entrypoint: exactly one operation ID. No paths, hashes, signer,
// version, pipe endpoint, fixture mode, or installer command are accepted.
int wmain(int count, wchar_t** arguments) {
  if (count != 2 || !arguments[1] || !hydra_update::canonical_operation_id(arguments[1])) return 64;
  hydra_update::NativeInstallContext context;
  std::wstring reason;
  if (!hydra_update::derive_native_install_context(context, reason)) {
    std::wcerr << L"Hydra update helper refused: installed identity unavailable.\n";
    return 2;
  }
  // No transport or installer action exists in this bootstrap binary. Even a
  // valid installed identity is insufficient to authenticate Electron main.
  std::wcerr << L"Hydra update helper refused: update trust is disabled.\n";
  return 2;
}
