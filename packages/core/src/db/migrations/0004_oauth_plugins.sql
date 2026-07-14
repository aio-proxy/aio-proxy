CREATE TABLE `plugin_secret` (
  `plugin` text PRIMARY KEY NOT NULL,
  `value_json` text NOT NULL,
  `revision` integer NOT NULL,
  `updated_at` integer NOT NULL
);

CREATE TABLE `oauth_account` (
  `provider_id` text PRIMARY KEY NOT NULL,
  `plugin` text NOT NULL,
  `capability` text NOT NULL,
  `fingerprint` text NOT NULL,
  `options_json` text NOT NULL,
  `secret_json` text NOT NULL,
  `credential_json` text NOT NULL,
  `revision` integer NOT NULL,
  `runtime_revision` integer NOT NULL,
  `label` text,
  `expires_at` integer,
  `updated_at` integer NOT NULL,
  UNIQUE(`plugin`, `capability`, `fingerprint`)
);

CREATE TABLE `oauth_catalog` (
  `provider_id` text PRIMARY KEY NOT NULL,
  `catalog_json` text NOT NULL,
  `refreshed_at` integer NOT NULL,
  FOREIGN KEY (`provider_id`) REFERENCES `oauth_account`(`provider_id`) ON DELETE CASCADE
);

CREATE TABLE `oauth_account_diagnostic` (
  `provider_id` text NOT NULL,
  `code` text NOT NULL,
  `diagnostic_json` text NOT NULL,
  PRIMARY KEY (`provider_id`, `code`),
  FOREIGN KEY (`provider_id`) REFERENCES `oauth_account`(`provider_id`) ON DELETE CASCADE
);

CREATE TABLE `oauth_refresh_lease` (
  `provider_id` text PRIMARY KEY NOT NULL,
  `owner` text NOT NULL,
  `expires_at` integer NOT NULL,
  FOREIGN KEY (`provider_id`) REFERENCES `oauth_account`(`provider_id`) ON DELETE CASCADE
);

CREATE TABLE `oauth_pending_operation` (
  `operation_id` text PRIMARY KEY NOT NULL,
  `provider_id` text NOT NULL,
  `kind` text NOT NULL CHECK (`kind` IN ('create', 'update', 'delete')),
  `target_digest` text NOT NULL,
  `applied_revision` integer NOT NULL,
  `previous_revision` integer,
  `rollback_json` text,
  `created_at` integer NOT NULL
);

CREATE INDEX `oauth_account_fingerprint_idx`
  ON `oauth_account` (`plugin`, `capability`, `fingerprint`);
CREATE INDEX `oauth_pending_created_at_idx`
  ON `oauth_pending_operation` (`created_at`);
CREATE INDEX `oauth_pending_provider_idx`
  ON `oauth_pending_operation` (`provider_id`);
