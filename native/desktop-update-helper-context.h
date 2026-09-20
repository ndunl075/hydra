#pragma once

#ifdef _WIN32
#include <windows.h>
#include <string>
#include <vector>

namespace hydra_update {

struct NativeInstallObservation {
  std::wstring sid;
  DWORD session_id = 0;
  bool elevated = false;
  std::wstring user_profile;
  std::wstring local_app_data;
  std::wstring roaming_app_data;
  std::wstring user_program_files;
  std::wstring helper_path;
  std::wstring registered_path;
  std::wstring registered_name;
  std::wstring registered_version;
  std::wstring executable_version;
};

struct NativeInstallContext {
  std::wstring sid;
  DWORD session_id = 0;
  std::wstring installation_path;
  std::wstring executable_path;
  std::wstring helper_path;
  std::wstring profile_path;
  std::wstring version;
  std::vector<HANDLE> held_handles;
  NativeInstallContext() = default;
  ~NativeInstallContext();
  NativeInstallContext(const NativeInstallContext&) = delete;
  NativeInstallContext& operator=(const NativeInstallContext&) = delete;
};

bool canonical_operation_id(const std::wstring& id);
bool validate_native_install_observation(const NativeInstallObservation& observation,
  NativeInstallContext& context, std::wstring& reason);
// Production observation. All paths, SID, registration, and PE version are
// derived in this process; there are no caller-supplied paths or policy values.
bool derive_native_install_context(NativeInstallContext& context, std::wstring& reason);
#ifdef HYDRA_UPDATE_CONTEXT_FIXTURE
bool fixture_hold_native_path(const std::wstring& path, bool directory, NativeInstallContext& context);
#endif

} // namespace hydra_update
#endif
