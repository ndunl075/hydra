#define WIN32_LEAN_AND_MEAN
#include "desktop-update-helper-context.h"
#include <cwchar>
#include <iostream>

int wmain(int count, wchar_t** arguments) {
  if (count == 3 && std::wcscmp(arguments[1], L"--lock") == 0) {
    hydra_update::NativeInstallContext context;
    return hydra_update::fixture_hold_native_path(arguments[2], false, context) ? 0 : 2;
  }
  if (count != 1) return 64;
  hydra_update::NativeInstallObservation valid{};
  valid.sid = L"S-1-5-21-100-200-300-1001";
  valid.session_id = 1;
  valid.user_profile = L"C:\\Users\\Nico";
  valid.local_app_data = L"C:\\Users\\Nico\\AppData\\Local";
  valid.roaming_app_data = L"C:\\Users\\Nico\\AppData\\Roaming";
  valid.user_program_files = L"C:\\Users\\Nico\\AppData\\Local\\Programs";
  valid.helper_path = L"C:\\Users\\Nico\\AppData\\Local\\Programs\\Hydra\\tools\\HydraUpdateVerify.exe";
  valid.registered_path = L"C:\\Users\\Nico\\AppData\\Local\\Programs\\Hydra";
  valid.registered_name = L"Hydra";
  valid.registered_version = L"0.22.0";
  valid.executable_version = L"0.22.0";
  auto accepts = [](const hydra_update::NativeInstallObservation& observation) {
    hydra_update::NativeInstallContext context;
    std::wstring reason;
    return hydra_update::validate_native_install_observation(observation, context, reason);
  };
  if (!accepts(valid)) return 1;
  auto changed = valid;
  changed.elevated = true;
  if (accepts(changed)) return 2;
  changed = valid; changed.session_id = 0;
  if (accepts(changed)) return 3;
  changed = valid; changed.user_program_files = L"C:\\Program Files";
  if (accepts(changed)) return 4;
  changed = valid; changed.helper_path = L"C:\\Temp\\HydraUpdateVerify.exe";
  if (accepts(changed)) return 5;
  changed = valid; changed.helper_path = L"C:\\Users\\Nico\\AppData\\Local\\Programs\\Hydra\\tools\\..\\HydraUpdateVerify.exe";
  if (accepts(changed)) return 6;
  changed = valid; changed.registered_path = L"C:\\Program Files\\Hydra";
  if (accepts(changed)) return 7;
  changed = valid; changed.registered_version = L"0.21.0";
  if (accepts(changed)) return 8;
  changed = valid; changed.roaming_app_data = L"D:\\Roaming";
  if (accepts(changed)) return 9;
  changed = valid; changed.user_profile = L"\\\\server\\share\\Nico";
  if (accepts(changed)) return 10;
  if (!hydra_update::canonical_operation_id(L"12345678-1234-4234-8234-123456789abc") ||
      hydra_update::canonical_operation_id(L"12345678-1234-4234-8234-123456789ABC") ||
      hydra_update::canonical_operation_id(L"../12345678-1234-4234-8234-123456789abc")) return 11;
  std::wcout << L"PASS: native install policy and canonical operation ID\n";
  return 0;
}
