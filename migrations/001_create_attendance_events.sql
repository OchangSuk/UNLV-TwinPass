CREATE TABLE IF NOT EXISTS attendance_events (
  event_id UUID PRIMARY KEY,
  device_id VARCHAR(64) NOT NULL,
  person_id VARCHAR(16) NOT NULL,
  vision_verified BOOLEAN NOT NULL,
  voice_verified BOOLEAN NOT NULL,
  vision_confidence DOUBLE PRECISION,
  voice_confidence DOUBLE PRECISION,
  detected_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  inference_ms INTEGER,
  firmware_version VARCHAR(40),
  decision VARCHAR(8) NOT NULL CHECK (decision IN ('ACCEPT', 'REJECT')),
  CONSTRAINT valid_person_id CHECK (person_id IN ('Sihoon', 'changsuk', 'Catherine', 'seoyeon', 'OTHER'))
);

CREATE INDEX IF NOT EXISTS attendance_events_received_at_idx
  ON attendance_events (received_at DESC);

CREATE INDEX IF NOT EXISTS attendance_events_person_id_idx
  ON attendance_events (person_id, received_at DESC);
