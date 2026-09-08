CREATE TABLE `sync_binding` (
	`id` text PRIMARY KEY NOT NULL,
	`plugin` text NOT NULL,
	`capability` text NOT NULL,
	`plugin_version` text NOT NULL,
	`identity_id` text NOT NULL,
	`space_id` text NOT NULL,
	`device_id` text NOT NULL,
	`session_generation` integer NOT NULL,
	`options_json` text NOT NULL,
	`active` integer DEFAULT 0 NOT NULL,
	`latest_confirmed_commit` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "sync_binding_space_check" CHECK("sync_binding"."space_id" = 'default'),
	CONSTRAINT "sync_binding_active_check" CHECK("sync_binding"."active" in (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sync_binding_one_active_idx` ON `sync_binding` (`active`) WHERE "sync_binding"."active" = 1;--> statement-breakpoint
CREATE TABLE `sync_commit` (
	`binding_id` text NOT NULL,
	`commit_id` text NOT NULL,
	`origin` text NOT NULL,
	`before_digest` text NOT NULL,
	`after_digest` text NOT NULL,
	`raw_after_json` text NOT NULL,
	`account_operation_ids_json` text NOT NULL,
	`phase` text NOT NULL,
	`remote_operations_json` text,
	`source_revisions_json` text,
	`confirmed_order` integer,
	PRIMARY KEY(`binding_id`, `commit_id`),
	CONSTRAINT "sync_commit_origin_check" CHECK("sync_commit"."origin" in ('local', 'remote')),
	CONSTRAINT "sync_commit_phase_check" CHECK("sync_commit"."phase" in ('prepared', 'confirmed'))
);
--> statement-breakpoint
CREATE INDEX `sync_commit_pending_idx` ON `sync_commit` (`binding_id`,`phase`);--> statement-breakpoint
CREATE TABLE `sync_entity` (
	`binding_id` text NOT NULL,
	`object_id` text NOT NULL,
	`logical_key` text NOT NULL,
	`kind` text NOT NULL,
	`mode` text NOT NULL,
	`epoch` integer NOT NULL,
	`desired_json` text,
	`baseline` text,
	`overrides_json` text NOT NULL,
	`pending_reason` text,
	PRIMARY KEY(`binding_id`, `object_id`),
	CONSTRAINT "sync_entity_mode_check" CHECK("sync_entity"."mode" in ('included', 'excluded'))
);
--> statement-breakpoint
CREATE INDEX `sync_entity_binding_idx` ON `sync_entity` (`binding_id`);--> statement-breakpoint
CREATE TABLE `sync_oauth_journal` (
	`binding_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`object_id` text NOT NULL,
	`epoch` integer NOT NULL,
	`base_generation` integer NOT NULL,
	`phase` text NOT NULL,
	`payload_json` text,
	PRIMARY KEY(`binding_id`, `operation_id`),
	CONSTRAINT "sync_oauth_journal_phase_check" CHECK("sync_oauth_journal"."phase" in ('started', 'result', 'complete'))
);
--> statement-breakpoint
CREATE INDEX `sync_oauth_journal_binding_idx` ON `sync_oauth_journal` (`binding_id`);--> statement-breakpoint
CREATE TABLE `sync_outbox` (
	`binding_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`object_id` text NOT NULL,
	`epoch` integer NOT NULL,
	`kind` text NOT NULL,
	`body_json` text,
	`commit_id` text NOT NULL,
	PRIMARY KEY(`binding_id`, `operation_id`),
	CONSTRAINT "sync_outbox_kind_check" CHECK("sync_outbox"."kind" in ('put', 'delete'))
);
--> statement-breakpoint
CREATE INDEX `sync_outbox_binding_idx` ON `sync_outbox` (`binding_id`);