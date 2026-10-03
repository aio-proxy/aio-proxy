ALTER TABLE `oauth_account` ADD `local_sign_in` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `oauth_account` ADD `local_sign_in_consumed` text;