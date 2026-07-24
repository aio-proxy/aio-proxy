CREATE TABLE `session_affinity` (
	`session_source` text NOT NULL,
	`session_id` text NOT NULL,
	`requested_model_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`revision` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`session_source`, `session_id`, `requested_model_id`)
);
--> statement-breakpoint
CREATE INDEX `session_affinity_expires_idx` ON `session_affinity` (`expires_at`);--> statement-breakpoint
CREATE TABLE `session_response` (
	`response_id_sha256` text PRIMARY KEY NOT NULL,
	`session_source` text NOT NULL,
	`session_id` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `session_response_expires_idx` ON `session_response` (`expires_at`);--> statement-breakpoint
CREATE TABLE `trace_span` (
	`trace_id` text NOT NULL,
	`span_id` text NOT NULL,
	`parent_span_id` text,
	`name` text NOT NULL,
	`kind` integer NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`status_code` integer NOT NULL,
	`termination_reason` text,
	`error_type` text,
	`error_code` text,
	`request_id` text,
	`session_source` text,
	`session_id` text,
	`session_resolved_by` text,
	`inbound_protocol` text,
	`requested_model_id` text,
	`final_provider_id` text,
	`final_model_id` text,
	`final_http_status` integer,
	`price_model_id` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`total_tokens` integer,
	`cache_read_tokens` integer,
	`cache_write_tokens` integer,
	`reasoning_tokens` integer,
	`estimated_cost_usd` real,
	`attempt_index` integer,
	`provider_id` text,
	`provider_kind` text,
	`provider_weight` real,
	`model_id` text,
	`transport` text,
	`source_protocol` text,
	`target_protocol` text,
	`selection_reason` text,
	`attributes_json` text NOT NULL,
	`events_json` text NOT NULL,
	`links_json` text NOT NULL,
	PRIMARY KEY(`trace_id`, `span_id`),
	FOREIGN KEY (`trace_id`,`parent_span_id`) REFERENCES `trace_span`(`trace_id`,`span_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trace_span_request_id_unique` ON `trace_span` (`request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `trace_span_one_root_idx` ON `trace_span` (`trace_id`) WHERE parent_span_id IS NULL;--> statement-breakpoint
CREATE INDEX `trace_span_root_started_idx` ON `trace_span` (`parent_span_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `trace_span_root_status_started_idx` ON `trace_span` (`parent_span_id`,`status_code`,`started_at`);--> statement-breakpoint
CREATE INDEX `trace_span_root_provider_started_idx` ON `trace_span` (`parent_span_id`,`final_provider_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `trace_span_root_model_started_idx` ON `trace_span` (`parent_span_id`,`requested_model_id`,`final_model_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `trace_span_root_protocol_started_idx` ON `trace_span` (`parent_span_id`,`inbound_protocol`,`started_at`);--> statement-breakpoint
CREATE INDEX `trace_span_root_session_started_idx` ON `trace_span` (`parent_span_id`,`session_source`,`session_id`,`requested_model_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `trace_span_trace_started_idx` ON `trace_span` (`trace_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `usage_daily` (
	`local_day` text NOT NULL,
	`model_dimension` text NOT NULL,
	`request_count` integer DEFAULT 0 NOT NULL,
	`success_count` integer DEFAULT 0 NOT NULL,
	`error_count` integer DEFAULT 0 NOT NULL,
	`cancelled_count` integer DEFAULT 0 NOT NULL,
	`interrupted_count` integer DEFAULT 0 NOT NULL,
	`usage_request_count` integer DEFAULT 0 NOT NULL,
	`priced_request_count` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`reasoning_tokens` integer DEFAULT 0 NOT NULL,
	`estimated_cost_usd` real DEFAULT 0 NOT NULL,
	PRIMARY KEY(`local_day`, `model_dimension`)
);
