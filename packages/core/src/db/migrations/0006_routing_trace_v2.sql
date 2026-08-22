ALTER TABLE `trace_span` ADD `routing_contract_version` integer;--> statement-breakpoint
ALTER TABLE `trace_span` ADD `effective_priority` integer;--> statement-breakpoint
ALTER TABLE `trace_span` ADD `effective_weight` integer;--> statement-breakpoint
ALTER TABLE `trace_span` ADD `priority_source` text;--> statement-breakpoint
ALTER TABLE `trace_span` ADD `weight_source` text;--> statement-breakpoint
ALTER TABLE `trace_span` ADD `selection_source` text;