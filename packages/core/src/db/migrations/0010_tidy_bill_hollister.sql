CREATE TABLE `provider_model_catalog` (
	`provider_id` text PRIMARY KEY NOT NULL,
	`source_digest` text NOT NULL,
	`models_json` text,
	`refreshed_at` integer,
	`failure_code` text,
	`failed_at` integer
);
