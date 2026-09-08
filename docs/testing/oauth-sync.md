# OAuth sync verification

OAuth adapters declare a positive `credentialSync.formatVersion` when their credential format can be stored in synced account records. A copied account remains pending on a receiving device until the adapter also declares a non-empty `multiDevice.evidenceId` matching the account's plugin version and format version.

The evidence identifier records the adapter's compatibility assertion for copied access-token use, refresh rotation, concurrency, login effects, device-bound fields, and independent detachment. The host still validates the credential schema separately. Adapters without `credentialSync` remain local-only until updated.
