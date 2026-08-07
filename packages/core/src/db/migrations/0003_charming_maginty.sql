ALTER TABLE `usage_daily` ADD `normalized_cache_read_tokens` text DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE `usage_daily` ADD `normalized_prompt_tokens` text DEFAULT '0' NOT NULL;