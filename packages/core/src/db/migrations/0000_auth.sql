CREATE TABLE `auth` (
  `vendor` text NOT NULL,
  `provider_id` text NOT NULL,
  `account_fingerprint` text,
  `payload` text NOT NULL,
  `updated_at` integer NOT NULL,
  PRIMARY KEY(`vendor`, `provider_id`)
);
