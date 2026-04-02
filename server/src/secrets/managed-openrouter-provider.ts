/**
 * managed_openrouter secret provider.
 *
 * Functionally delegates to local_encrypted for AES-256-GCM key material storage.
 * The externalRef stores the OpenRouter provider key ID (e.g. "key-abc123").
 *
 * This provider is used for platform-managed OpenRouter sub-keys. Users do not
 * interact with this provider directly — it is managed by the managed-openrouter service.
 */
import type { SecretProviderModule, StoredSecretVersionMaterial } from "./types.js";
import { localEncryptedProvider } from "./local-encrypted-provider.js";

export const managedOpenRouterProvider: SecretProviderModule = {
  id: "managed_openrouter",
  descriptor: {
    id: "managed_openrouter",
    label: "Managed OpenRouter key (platform-managed)",
    requiresExternalRef: true,
  },

  async createVersion(input) {
    // Delegate entirely to local_encrypted for the actual AES-256-GCM encryption.
    // externalRef is the OpenRouter provider key ID — pass it through unchanged.
    return localEncryptedProvider.createVersion(input);
  },

  async resolveVersion(input) {
    return localEncryptedProvider.resolveVersion(input);
  },
};
