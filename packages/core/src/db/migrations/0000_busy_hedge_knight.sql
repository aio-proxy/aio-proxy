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
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_account_plugin_capability_fingerprint_unique` ON `oauth_account` (`plugin`,`capability`,`fingerprint`);--> statement-breakpoint
CREATE TABLE `oauth_account_diagnostic` (
	`provider_id` text NOT NULL,
	`code` text NOT NULL,
	`diagnostic_json` text NOT NULL,
	PRIMARY KEY(`provider_id`, `code`),
	FOREIGN KEY (`provider_id`) REFERENCES `oauth_account`(`provider_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `oauth_catalog` (
	`provider_id` text PRIMARY KEY NOT NULL,
	`catalog_json` text NOT NULL,
	`refreshed_at` integer NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `oauth_account`(`provider_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `oauth_pending_operation` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`kind` text NOT NULL,
	`target_digest` text NOT NULL,
	`applied_revision` integer NOT NULL,
	`previous_revision` integer,
	`rollback_json` text,
	`created_at` integer NOT NULL,
	CONSTRAINT "oauth_pending_operation_kind_check" CHECK("oauth_pending_operation"."kind" in ('create', 'update', 'delete'))
);
--> statement-breakpoint
CREATE INDEX `oauth_pending_created_at_idx` ON `oauth_pending_operation` (`created_at`);--> statement-breakpoint
CREATE INDEX `oauth_pending_provider_idx` ON `oauth_pending_operation` (`provider_id`);--> statement-breakpoint
CREATE TABLE `oauth_refresh_lease` (
	`provider_id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `oauth_account`(`provider_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `plugin_secret` (
	`plugin` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`revision` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `request_log` (
	`request_id` text PRIMARY KEY NOT NULL,
	`inbound_protocol` text NOT NULL,
	`requested_model_id` text NOT NULL,
	`outcome` text NOT NULL,
	`final_provider_id` text,
	`final_model_id` text,
	`final_status_code` integer,
	`error_code` text,
	`attempts_json` text NOT NULL,
	`started_at` integer NOT NULL,
	`completed_at` integer NOT NULL,
	`duration_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `request_log_completed_at_idx` ON `request_log` (`completed_at`);--> statement-breakpoint
CREATE INDEX `request_log_outcome_completed_at_idx` ON `request_log` (`outcome`,`completed_at`);--> statement-breakpoint
CREATE INDEX `request_log_final_provider_completed_at_idx` ON `request_log` (`final_provider_id`,`completed_at`);--> statement-breakpoint
CREATE INDEX `request_log_requested_model_completed_at_idx` ON `request_log` (`requested_model_id`,`completed_at`);--> statement-breakpoint
CREATE INDEX `request_log_final_model_completed_at_idx` ON `request_log` (`final_model_id`,`completed_at`);--> statement-breakpoint
CREATE INDEX `request_log_protocol_completed_at_idx` ON `request_log` (`inbound_protocol`,`completed_at`);--> statement-breakpoint
CREATE INDEX `request_log_status_completed_at_idx` ON `request_log` (`final_status_code`,`completed_at`);--> statement-breakpoint
CREATE TABLE `usage` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`model_id` text NOT NULL,
	`price_model_id` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`total_tokens` integer,
	`cache_read_tokens` integer,
	`cache_write_tokens` integer,
	`reasoning_tokens` integer,
	`estimated_cost_usd` real,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `usage_request_id_unique` ON `usage` (`request_id`);