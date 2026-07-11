ALTER TABLE `usage` RENAME COLUMN `trace_id` TO `request_id`;

CREATE UNIQUE INDEX `usage_request_id_unique`
  ON `usage` (`request_id`);

CREATE TABLE `request_log` (
  `request_id` text PRIMARY KEY NOT NULL,
  `inbound_protocol` text NOT NULL,
  `requested_model_id` text NOT NULL,
  `outcome` text NOT NULL CHECK (`outcome` IN ('success', 'failure', 'cancelled')),
  `final_provider_id` text,
  `final_model_id` text,
  `final_status_code` integer,
  `error_code` text,
  `attempts_json` text DEFAULT '[]' NOT NULL,
  `started_at` integer NOT NULL,
  `completed_at` integer NOT NULL,
  `duration_ms` integer NOT NULL
);

CREATE INDEX `request_log_completed_at_idx`
  ON `request_log` (`completed_at`);

CREATE INDEX `request_log_outcome_completed_at_idx`
  ON `request_log` (`outcome`, `completed_at`);

INSERT INTO `request_log` (
  `request_id`,
  `inbound_protocol`,
  `requested_model_id`,
  `outcome`,
  `final_provider_id`,
  `final_model_id`,
  `attempts_json`,
  `started_at`,
  `completed_at`,
  `duration_ms`
)
SELECT
  `request_id`,
  'legacy',
  `model_id`,
  'success',
  `provider_id`,
  `model_id`,
  '[]',
  `created_at`,
  `created_at`,
  0
FROM `usage`;
