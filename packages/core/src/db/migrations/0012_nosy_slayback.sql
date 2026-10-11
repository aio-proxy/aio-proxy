CREATE TABLE `usage_caller` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`kind` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `usage_caller_credential` (
	`fingerprint` text PRIMARY KEY NOT NULL,
	`caller_id` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `usage_caller_daily` (
	`caller_id` text NOT NULL,
	`local_day` text NOT NULL,
	`model_dimension` text NOT NULL,
	`request_count` text DEFAULT '0' NOT NULL,
	`success_count` text DEFAULT '0' NOT NULL,
	`error_count` text DEFAULT '0' NOT NULL,
	`cancelled_count` text DEFAULT '0' NOT NULL,
	`interrupted_count` text DEFAULT '0' NOT NULL,
	`usage_request_count` text DEFAULT '0' NOT NULL,
	`priced_request_count` text DEFAULT '0' NOT NULL,
	`input_tokens` text DEFAULT '0' NOT NULL,
	`output_tokens` text DEFAULT '0' NOT NULL,
	`total_tokens` text DEFAULT '0' NOT NULL,
	`cache_read_tokens` text DEFAULT '0' NOT NULL,
	`cache_write_tokens` text DEFAULT '0' NOT NULL,
	`reasoning_tokens` text DEFAULT '0' NOT NULL,
	`estimated_cost_nano_usd` text DEFAULT '0' NOT NULL,
	`normalized_cache_read_tokens` text DEFAULT '0' NOT NULL,
	`normalized_prompt_tokens` text DEFAULT '0' NOT NULL,
	`cache_hit_rate_available` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`caller_id`, `local_day`, `model_dimension`)
);
--> statement-breakpoint
CREATE TABLE `usage_identity_secret` (
	`id` text PRIMARY KEY NOT NULL,
	`secret` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `trace_span` ADD `caller_id` text;--> statement-breakpoint
ALTER TABLE `trace_span` ADD `caller_label` text;--> statement-breakpoint
ALTER TABLE `trace_span` ADD `caller_kind` text;--> statement-breakpoint
CREATE INDEX `trace_span_caller_ended_idx` ON `trace_span` (`caller_id`,`parent_span_id`,`ended_at`);
--> statement-breakpoint
INSERT INTO usage_caller_daily (caller_id, local_day, model_dimension, request_count, success_count, error_count, cancelled_count, interrupted_count, usage_request_count, priced_request_count, input_tokens, output_tokens, total_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, estimated_cost_nano_usd, normalized_cache_read_tokens, normalized_prompt_tokens, cache_hit_rate_available) SELECT 'legacy', local_day, model_dimension, request_count, success_count, error_count, cancelled_count, interrupted_count, usage_request_count, priced_request_count, input_tokens, output_tokens, total_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, estimated_cost_nano_usd, normalized_cache_read_tokens, normalized_prompt_tokens, cache_hit_rate_available FROM usage_daily;
