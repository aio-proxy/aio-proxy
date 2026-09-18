# @aio-proxy/plugin-cloudkit

The CloudKit plugin provides the iCloud sync backend through a signed and notarized macOS native helper.

Native archives are packaged into `dist/native` and verified before installation. The plugin stores installations below the SDK-provided local `dataDirectory`; `containerId` is the only user-facing option.
