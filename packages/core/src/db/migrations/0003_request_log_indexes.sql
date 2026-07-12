CREATE INDEX `request_log_final_provider_completed_at_idx`
  ON `request_log` (`final_provider_id`, `completed_at`);

CREATE INDEX `request_log_requested_model_completed_at_idx`
  ON `request_log` (`requested_model_id`, `completed_at`);

CREATE INDEX `request_log_final_model_completed_at_idx`
  ON `request_log` (`final_model_id`, `completed_at`);

CREATE INDEX `request_log_protocol_completed_at_idx`
  ON `request_log` (`inbound_protocol`, `completed_at`);

CREATE INDEX `request_log_status_completed_at_idx`
  ON `request_log` (`final_status_code`, `completed_at`);
