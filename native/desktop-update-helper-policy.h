#pragma once

namespace hydra_update {
// Reviewed bootstrap policy. A public channel requires a separately reviewed,
// compiled trust root and authenticated installed-code inventory.
inline constexpr int helper_policy_version = 1;
inline constexpr bool helper_policy_enabled = false;
static_assert(!helper_policy_enabled, "The bootstrap helper cannot authorize updates.");
} // namespace hydra_update
