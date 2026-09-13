ALTER TABLE `sync_binding` ADD `connect_pending` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
-- Bindings written before the flag existed were connected by an Apply that ran to completion, so
-- they are not pending; only rows inserted from here on start out awaiting their connect Apply.
UPDATE `sync_binding` SET `connect_pending` = 0;
