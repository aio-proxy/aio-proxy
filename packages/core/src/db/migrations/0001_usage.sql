CREATE TABLE `usage` (
  `id` text PRIMARY KEY NOT NULL,
  `trace_id` text NOT NULL,
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
