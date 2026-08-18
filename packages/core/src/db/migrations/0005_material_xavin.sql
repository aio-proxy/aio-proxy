CREATE TABLE `agent_access_token` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `agent_token_family`(`family_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_access_family_idx` ON `agent_access_token` (`family_id`);--> statement-breakpoint
CREATE TABLE `agent_installation` (
	`installation_id` text PRIMARY KEY NOT NULL,
	`target` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_authorized_at` integer NOT NULL,
	`adapter_version` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `agent_refresh_token` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`issued_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	FOREIGN KEY (`family_id`) REFERENCES `agent_token_family`(`family_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_refresh_family_idx` ON `agent_refresh_token` (`family_id`);--> statement-breakpoint
CREATE TABLE `agent_token_family` (
	`family_id` text PRIMARY KEY NOT NULL,
	`installation_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	`refresh_expires_at` integer NOT NULL,
	FOREIGN KEY (`installation_id`) REFERENCES `agent_installation`(`installation_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_family_installation_idx` ON `agent_token_family` (`installation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_family_one_current_idx` ON `agent_token_family` (`installation_id`) WHERE "agent_token_family"."revoked_at" is null;