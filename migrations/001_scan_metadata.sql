CREATE TABLE IF NOT EXISTS sentinel_scans (
  scan_id uuid PRIMARY KEY,
  session_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL,
  file_type varchar(32) NOT NULL,
  file_size_bytes bigint NOT NULL CHECK (file_size_bytes >= 0),
  scan_status varchar(24) NOT NULL,
  detector_mode varchar(48) NOT NULL,
  risk_score smallint NOT NULL CHECK (risk_score BETWEEN 0 AND 100),
  risk_category varchar(16) NOT NULL,
  finding_count integer NOT NULL CHECK (finding_count >= 0),
  severity_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  extracted_characters integer NOT NULL DEFAULT 0 CHECK (extracted_characters >= 0),
  extraction_coverage real NOT NULL DEFAULT 0 CHECK (extraction_coverage BETWEEN 0 AND 1),
  processing_duration_ms integer NOT NULL CHECK (processing_duration_ms >= 0)
);
CREATE INDEX IF NOT EXISTS sentinel_scans_session_created_idx ON sentinel_scans (session_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS sentinel_scans_retention_idx ON sentinel_scans (created_at);
