#pragma once

#ifdef _WIN32
#include <windows.h>
#include <string>
#include <vector>

namespace hydra_update {

struct StagedFileLease {
  std::vector<HANDLE> directories;
  HANDLE file = INVALID_HANDLE_VALUE;
  std::wstring path;
  StagedFileLease() = default;
  ~StagedFileLease();
  StagedFileLease(const StagedFileLease&) = delete;
  StagedFileLease& operator=(const StagedFileLease&) = delete;
  StagedFileLease(StagedFileLease&& other) noexcept;
  StagedFileLease& operator=(StagedFileLease&& other) noexcept;
  void close() noexcept;
};

// Testable path-locking primitive. Production must derive user_data from the
// current Hydra profile in the native process; no renderer may supply it.
bool open_staged_file(const std::wstring& user_data, const std::wstring& operation_id,
  StagedFileLease& lease, std::wstring& reason);

} // namespace hydra_update
#endif
