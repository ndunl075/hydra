#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include "desktop-installed-inventory-signature.h"
#include <windows.h>

#ifdef HYDRA_INVENTORY_SIGNATURE_FIXTURE
#include <bcrypt.h>
#include <algorithm>
#include <cstring>
#include <iterator>
#include <limits>

#pragma comment(lib, "bcrypt.lib")
#endif

namespace hydra_update {
namespace {
InventoryByteAuthentication refuse(const wchar_t* reason) {
  InventoryByteAuthentication result;
  result.reason = reason;
  return result;
}

#ifdef HYDRA_INVENTORY_SIGNATURE_FIXTURE
constexpr size_t max_inventory_bytes = 4 * 1024 * 1024;
constexpr size_t detached_bytes_v1 = 8 + 32 + 64;
constexpr unsigned char magic[] = { 'H', 'Y', 'D', 'R', 'I', 'N', 'V', '1' };
constexpr char domain[] = "Hydra installed-code inventory signature v1";

struct Algorithm {
  BCRYPT_ALG_HANDLE handle = nullptr;
  ~Algorithm() { if (handle) BCryptCloseAlgorithmProvider(handle, 0); }
};
struct Hash {
  BCRYPT_HASH_HANDLE handle = nullptr;
  ~Hash() { if (handle) BCryptDestroyHash(handle); }
};
struct Key {
  BCRYPT_KEY_HANDLE handle = nullptr;
  ~Key() { if (handle) BCryptDestroyKey(handle); }
};

bool sha256(const unsigned char* bytes, size_t length, std::array<unsigned char, 32>& result) {
  if (!bytes || length > static_cast<size_t>(std::numeric_limits<ULONG>::max())) return false;
  Algorithm algorithm;
  Hash hash;
  return BCryptOpenAlgorithmProvider(&algorithm.handle, BCRYPT_SHA256_ALGORITHM, MS_PRIMITIVE_PROVIDER, 0) == 0 &&
    BCryptCreateHash(algorithm.handle, &hash.handle, nullptr, 0, nullptr, 0, 0) == 0 &&
    BCryptHashData(hash.handle, const_cast<PUCHAR>(bytes), static_cast<ULONG>(length), 0) == 0 &&
    BCryptFinishHash(hash.handle, result.data(), static_cast<ULONG>(result.size()), 0) == 0;
}

InventoryByteAuthentication authenticate_with_root(const unsigned char* inventory, size_t inventory_bytes,
  const unsigned char* detached, size_t detached_bytes,
  const std::array<unsigned char, 64>& trusted_root) {
  if (!inventory || inventory_bytes == 0 || inventory_bytes > max_inventory_bytes ||
      !detached || detached_bytes != detached_bytes_v1) return refuse(L"inventory or detached record size is invalid");
  // All later checks and the returned payload use these same retained bytes.
  // A caller cannot swap its input buffers after signature verification.
  const std::vector<unsigned char> retained(inventory, inventory + inventory_bytes);
  std::array<unsigned char, detached_bytes_v1> record{};
  std::memcpy(record.data(), detached, record.size());
  if (!std::equal(std::begin(magic), std::end(magic), record.begin())) return refuse(L"inventory signature format is invalid");
  std::array<unsigned char, 32> key_id{};
  if (!sha256(trusted_root.data(), trusted_root.size(), key_id) ||
      !std::equal(key_id.begin(), key_id.end(), record.begin() + sizeof(magic)))
    return refuse(L"inventory signature key is not trusted");

  std::vector<unsigned char> preimage;
  preimage.reserve(sizeof(domain) + 40 + 4 + inventory_bytes);
  preimage.insert(preimage.end(), std::begin(domain), std::end(domain));
  preimage.insert(preimage.end(), record.begin(), record.begin() + 40);
  const auto length = static_cast<unsigned long>(inventory_bytes);
  for (unsigned index = 0; index < 4; ++index)
    preimage.push_back(static_cast<unsigned char>((length >> (index * 8)) & 0xff));
  preimage.insert(preimage.end(), retained.begin(), retained.end());
  std::array<unsigned char, 32> preimage_hash{};
  if (!sha256(preimage.data(), preimage.size(), preimage_hash)) return refuse(L"inventory preimage hash failed");

  std::array<unsigned char, sizeof(BCRYPT_ECCKEY_BLOB) + 64> key_blob{};
  const BCRYPT_ECCKEY_BLOB header{ BCRYPT_ECDSA_PUBLIC_P256_MAGIC, 32 };
  std::memcpy(key_blob.data(), &header, sizeof(header));
  std::memcpy(key_blob.data() + sizeof(header), trusted_root.data(), trusted_root.size());
  Algorithm algorithm;
  Key key;
  if (BCryptOpenAlgorithmProvider(&algorithm.handle, BCRYPT_ECDSA_P256_ALGORITHM, MS_PRIMITIVE_PROVIDER, 0) != 0 ||
      BCryptImportKeyPair(algorithm.handle, nullptr, BCRYPT_ECCPUBLIC_BLOB, &key.handle,
        key_blob.data(), static_cast<ULONG>(key_blob.size()), 0) != 0 ||
      BCryptVerifySignature(key.handle, nullptr, preimage_hash.data(), static_cast<ULONG>(preimage_hash.size()),
        record.data() + 40, 64, 0) != 0)
    return refuse(L"inventory signature verification failed");

  InventoryByteAuthentication accepted;
  if (!sha256(retained.data(), retained.size(), accepted.sha256)) return refuse(L"inventory digest failed");
  accepted.bytes = retained;
  accepted.accepted = true;
  accepted.reason = L"authenticated bytes only";
  return accepted;
}
#endif
} // namespace

InventoryByteAuthentication authenticate_installed_inventory_bytes(
  const unsigned char*, size_t, const unsigned char*, size_t) {
  return refuse(L"no approved production inventory trust root is compiled");
}

#ifdef HYDRA_INVENTORY_SIGNATURE_FIXTURE
InventoryByteAuthentication fixture_authenticate_installed_inventory_bytes(
  const unsigned char* inventory, size_t inventory_bytes,
  const unsigned char* detached, size_t detached_bytes,
  const std::array<unsigned char, 64>& compiled_test_root) {
  return authenticate_with_root(inventory, inventory_bytes, detached, detached_bytes, compiled_test_root);
}
#endif
} // namespace hydra_update
