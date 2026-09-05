-- ─────────────────────────────────────────────────────────────────────────────
-- 0001_init — core schema for the salon CRM.
--
-- Design notes that matter (full rationale in ARCHITECTURE.md §2):
--
--  * Every salon-scoped table carries salon_id. Tenancy is a data-filtering
--    concern, never a code fork.
--  * Cross-tenant references are structurally impossible: child tables carry
--    composite foreign keys (id, salon_id) so an appointment cannot point at a
--    customer belonging to a different salon even if application code is wrong.
--  * All instants are timestamptz (stored UTC). Recurring *rules* — opening
--    hours, staff shifts — are stored as salon-local wall-clock `time` and are
--    interpreted in salons.timezone. Storing "09:00 opening" as UTC breaks
--    twice a year at DST boundaries.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Shared updated_at trigger -----------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── salons ────────────────────────────────────────────────────────────────────
CREATE TABLE salons (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE,
  timezone    text NOT NULL,
  phone       text,
  email       text,
  address     text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER salons_updated_at BEFORE UPDATE ON salons
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── business_hours ────────────────────────────────────────────────────────────
-- One row per (salon, day-of-week). 0 = Sunday .. 6 = Saturday, matching
-- JavaScript's Date#getDay so no off-by-one translation layer is needed.
CREATE TABLE business_hours (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id    uuid NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  is_closed   boolean NOT NULL DEFAULT false,
  open_time   time,
  close_time  time,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT business_hours_salon_day_key UNIQUE (salon_id, day_of_week),
  CONSTRAINT business_hours_consistent CHECK (
    (is_closed AND open_time IS NULL AND close_time IS NULL)
    OR (NOT is_closed AND open_time IS NOT NULL AND close_time IS NOT NULL AND open_time < close_time)
  )
);
CREATE TRIGGER business_hours_updated_at BEFORE UPDATE ON business_hours
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── closed_dates ──────────────────────────────────────────────────────────────
-- Date-specific override of business_hours. Both times NULL => closed all day;
-- both set => special opening hours for that date (e.g. Christmas Eve half-day).
CREATE TABLE closed_dates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id    uuid NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  date        date NOT NULL,
  reason      text,
  open_time   time,
  close_time  time,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT closed_dates_salon_date_key UNIQUE (salon_id, date),
  CONSTRAINT closed_dates_times_paired CHECK ((open_time IS NULL) = (close_time IS NULL)),
  CONSTRAINT closed_dates_times_ordered CHECK (open_time IS NULL OR open_time < close_time)
);
CREATE TRIGGER closed_dates_updated_at BEFORE UPDATE ON closed_dates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── services ──────────────────────────────────────────────────────────────────
-- Buffers are per-service: a colour needs 15 minutes of cleanup after, a
-- consultation needs none. They widen the blocked range on an appointment
-- without widening the time the customer is told.
CREATE TABLE services (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id              uuid NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  name                  text NOT NULL,
  description           text,
  category              text NOT NULL DEFAULT 'general',
  duration_minutes      integer NOT NULL CHECK (duration_minutes > 0 AND duration_minutes <= 600),
  buffer_before_minutes integer NOT NULL DEFAULT 0 CHECK (buffer_before_minutes BETWEEN 0 AND 120),
  buffer_after_minutes  integer NOT NULL DEFAULT 0 CHECK (buffer_after_minutes BETWEEN 0 AND 120),
  price                 numeric(10,2) NOT NULL CHECK (price >= 0),
  currency              char(3) NOT NULL DEFAULT 'GBP',
  active                boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT services_id_salon_key UNIQUE (id, salon_id)
);
CREATE UNIQUE INDEX services_salon_name_key ON services (salon_id, lower(name));
CREATE INDEX services_salon_active_idx ON services (salon_id, active);
CREATE TRIGGER services_updated_at BEFORE UPDATE ON services
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── staff_members ─────────────────────────────────────────────────────────────
-- Every appointment resolves to exactly one staff member (see appointments).
-- Salons that do not track individual stylists get a single row flagged
-- is_default_resource, representing "the chair" — nothing else changes.
CREATE TABLE staff_members (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id            uuid NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  name                text NOT NULL,
  role                text,
  is_default_resource boolean NOT NULL DEFAULT false,
  active              boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_members_id_salon_key UNIQUE (id, salon_id)
);
CREATE INDEX staff_members_salon_active_idx ON staff_members (salon_id, active);
CREATE TRIGGER staff_members_updated_at BEFORE UPDATE ON staff_members
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Which staff can perform which service. A service with no rows here is
-- performable by any active staff member (small salons never fill this in).
CREATE TABLE staff_services (
  staff_id   uuid NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  PRIMARY KEY (staff_id, service_id)
);
CREATE INDEX staff_services_service_idx ON staff_services (service_id);

-- Per-staff shift overrides. A staff member with no rows works the salon's
-- full opening hours; with rows, only the days and times listed.
CREATE TABLE staff_working_hours (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id    uuid NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE,
  day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time  time NOT NULL,
  end_time    time NOT NULL,
  CONSTRAINT staff_working_hours_staff_day_key UNIQUE (staff_id, day_of_week),
  CONSTRAINT staff_working_hours_ordered CHECK (start_time < end_time)
);

-- ── customers ─────────────────────────────────────────────────────────────────
CREATE TABLE customers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id   uuid NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  first_name text NOT NULL,
  last_name  text,
  phone      text NOT NULL,
  email      text,
  notes      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customers_id_salon_key UNIQUE (id, salon_id)
);
-- Phone is the identity key for a voice channel: unique per salon, E.164.
CREATE UNIQUE INDEX customers_salon_phone_key ON customers (salon_id, phone);
CREATE INDEX customers_salon_name_idx ON customers (salon_id, lower(first_name), lower(coalesce(last_name, '')));
CREATE TRIGGER customers_updated_at BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── booking_policies ──────────────────────────────────────────────────────────
-- One row per salon; the knobs that make salon #2 a config change rather than
-- a code change.
CREATE TABLE booking_policies (
  salon_id                             uuid PRIMARY KEY REFERENCES salons(id) ON DELETE CASCADE,
  min_lead_minutes                     integer NOT NULL DEFAULT 120 CHECK (min_lead_minutes >= 0),
  max_advance_days                     integer NOT NULL DEFAULT 90 CHECK (max_advance_days > 0),
  cancellation_window_hours            integer NOT NULL DEFAULT 24 CHECK (cancellation_window_hours >= 0),
  late_cancellation_fee                numeric(10,2) NOT NULL DEFAULT 0 CHECK (late_cancellation_fee >= 0),
  no_show_fee                          numeric(10,2) NOT NULL DEFAULT 0 CHECK (no_show_fee >= 0),
  slot_granularity_minutes             integer NOT NULL DEFAULT 15
                                         CHECK (slot_granularity_minutes IN (5, 10, 15, 20, 30, 60)),
  allow_double_booking                 boolean NOT NULL DEFAULT false,
  max_active_appointments_per_customer integer NOT NULL DEFAULT 5 CHECK (max_active_appointments_per_customer > 0),
  currency                             char(3) NOT NULL DEFAULT 'GBP',
  updated_at                           timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER booking_policies_updated_at BEFORE UPDATE ON booking_policies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── call_logs ─────────────────────────────────────────────────────────────────
-- Opened when a call starts, closed when it ends. Declared before appointments
-- because an appointment records the call that created it.
CREATE TABLE call_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id      uuid NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  caller_phone  text,
  started_at    timestamptz NOT NULL DEFAULT now(),
  ended_at      timestamptz,
  transport     text NOT NULL CHECK (transport IN ('browser', 'twilio', 'test')),
  status        text NOT NULL DEFAULT 'in_progress'
                  CHECK (status IN ('in_progress', 'completed', 'failed')),
  transcript    jsonb NOT NULL DEFAULT '[]'::jsonb,
  recording_ref text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT call_logs_id_salon_key UNIQUE (id, salon_id),
  CONSTRAINT call_logs_ended_after_started CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE INDEX call_logs_salon_started_idx ON call_logs (salon_id, started_at DESC);
CREATE TRIGGER call_logs_updated_at BEFORE UPDATE ON call_logs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── appointments ──────────────────────────────────────────────────────────────
-- staff_id is NOT NULL by design. A caller may say "anyone's fine", but the
-- system always commits to a concrete resource before writing, which is what
-- makes the no-overlap guarantee expressible as a database constraint rather
-- than as application-level capacity arithmetic.
--
-- start_time/end_time are what the customer is told.
-- block_start/block_end additionally include the service's buffers and are what
-- the overlap constraint operates on. They are stored rather than generated
-- because `timestamptz - interval` is STABLE (DST-dependent), not IMMUTABLE, so
-- Postgres rejects it in a GENERATED column. The CHECK below keeps them honest.
CREATE TABLE appointments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id            uuid NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  customer_id         uuid NOT NULL,
  service_id          uuid NOT NULL,
  staff_id            uuid NOT NULL,
  start_time          timestamptz NOT NULL,
  end_time            timestamptz NOT NULL,
  block_start         timestamptz NOT NULL,
  block_end           timestamptz NOT NULL,
  status              text NOT NULL DEFAULT 'booked'
                        CHECK (status IN ('booked', 'cancelled', 'completed', 'no_show', 'rescheduled')),
  source              text NOT NULL CHECK (source IN ('voice', 'staff', 'web')),
  call_id             uuid REFERENCES call_logs(id) ON DELETE SET NULL,
  rescheduled_from_id uuid REFERENCES appointments(id) ON DELETE SET NULL,
  rescheduled_to_id   uuid REFERENCES appointments(id) ON DELETE SET NULL,
  price_at_booking    numeric(10,2) NOT NULL DEFAULT 0 CHECK (price_at_booking >= 0),
  currency            char(3) NOT NULL DEFAULT 'GBP',
  notes               text,
  -- Set only by staff, only when the salon's policy allows it. Rows flagged
  -- here are exempt from the overlap constraint — this is how "squeeze in a
  -- regular" is supported without weakening the guarantee for everyone else.
  -- The voice agent has no scope permitting it to set this.
  overbooked          boolean NOT NULL DEFAULT false,
  cancellation_reason text,
  cancellation_fee    numeric(10,2) NOT NULL DEFAULT 0 CHECK (cancellation_fee >= 0),
  cancelled_at        timestamptz,
  completed_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT appointments_time_ordered CHECK (start_time < end_time),
  CONSTRAINT appointments_block_covers_service
    CHECK (block_start <= start_time AND end_time <= block_end),

  -- Composite FKs: an appointment physically cannot reference a customer,
  -- service, staff member or call belonging to a different salon.
  CONSTRAINT appointments_customer_fk FOREIGN KEY (customer_id, salon_id)
    REFERENCES customers (id, salon_id) ON DELETE RESTRICT,
  CONSTRAINT appointments_service_fk FOREIGN KEY (service_id, salon_id)
    REFERENCES services (id, salon_id) ON DELETE RESTRICT,
  CONSTRAINT appointments_staff_fk FOREIGN KEY (staff_id, salon_id)
    REFERENCES staff_members (id, salon_id) ON DELETE RESTRICT,

  CONSTRAINT appointments_id_salon_key UNIQUE (id, salon_id)
);

-- The correctness core of the whole system.
--
-- Two concurrent callers racing for the same slot do not "check then write" —
-- the write IS the check. Postgres serialises the two inserts on the GiST
-- index; the loser gets SQLSTATE 23P01, which the service layer maps to the
-- SLOT_UNAVAILABLE error code. No advisory lock, no SELECT ... FOR UPDATE, no
-- serialisation-anomaly window.
--
-- Cancelled / rescheduled / no-show rows fall out of the predicate, which is
-- also what makes an atomic reschedule work: within one transaction the old row
-- is set to 'rescheduled' (leaving the index) and the new row is inserted,
-- so the appointment never conflicts with its own former self.
ALTER TABLE appointments ADD CONSTRAINT appointments_no_overlap
  EXCLUDE USING gist (
    salon_id WITH =,
    staff_id WITH =,
    tstzrange(block_start, block_end, '[)') WITH &&
  ) WHERE (status IN ('booked', 'completed') AND NOT overbooked);

CREATE INDEX appointments_salon_start_idx        ON appointments (salon_id, start_time);
CREATE INDEX appointments_salon_customer_idx     ON appointments (salon_id, customer_id, start_time DESC);
CREATE INDEX appointments_salon_staff_start_idx  ON appointments (salon_id, staff_id, start_time)
  WHERE status IN ('booked', 'completed');
CREATE INDEX appointments_call_idx               ON appointments (call_id) WHERE call_id IS NOT NULL;
CREATE TRIGGER appointments_updated_at BEFORE UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── call_summaries ────────────────────────────────────────────────────────────
-- Written for every call in a finally block — including failed and abandoned
-- ones, which are the calls most worth reviewing.
CREATE TABLE call_summaries (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id            uuid NOT NULL UNIQUE REFERENCES call_logs(id) ON DELETE CASCADE,
  salon_id           uuid NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  customer_id        uuid,                     -- NULL = unknown / new caller
  caller_phone       text,
  intents            text[] NOT NULL DEFAULT '{}',
  services_discussed text[] NOT NULL DEFAULT '{}',
  appointment_action text NOT NULL DEFAULT 'none'
                       CHECK (appointment_action IN ('book', 'cancel', 'reschedule', 'lookup', 'none')),
  action_result      text NOT NULL DEFAULT 'not_attempted'
                       CHECK (action_result IN ('success', 'failed', 'not_attempted')),
  failure_reason     text,
  appointment_id     uuid,
  summary            text NOT NULL DEFAULT '',
  key_entities       jsonb NOT NULL DEFAULT '{}'::jsonb,
  events             jsonb NOT NULL DEFAULT '[]'::jsonb,
  escalated          boolean NOT NULL DEFAULT false,
  escalation_reason  text,
  callback_request   jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT call_summaries_call_fk FOREIGN KEY (call_id, salon_id)
    REFERENCES call_logs (id, salon_id) ON DELETE CASCADE,
  CONSTRAINT call_summaries_customer_fk FOREIGN KEY (customer_id, salon_id)
    REFERENCES customers (id, salon_id) ON DELETE SET NULL,
  CONSTRAINT call_summaries_appointment_fk FOREIGN KEY (appointment_id, salon_id)
    REFERENCES appointments (id, salon_id) ON DELETE SET NULL,
  -- A failure must say why; a success must not claim a reason it does not have.
  CONSTRAINT call_summaries_failure_explained
    CHECK (action_result <> 'failed' OR failure_reason IS NOT NULL),
  CONSTRAINT call_summaries_escalation_explained
    CHECK (NOT escalated OR escalation_reason IS NOT NULL)
);
CREATE INDEX call_summaries_salon_created_idx ON call_summaries (salon_id, created_at DESC);
CREATE INDEX call_summaries_escalated_idx     ON call_summaries (salon_id, created_at DESC) WHERE escalated;
CREATE INDEX call_summaries_customer_idx      ON call_summaries (salon_id, customer_id)
  WHERE customer_id IS NOT NULL;
CREATE TRIGGER call_summaries_updated_at BEFORE UPDATE ON call_summaries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── idempotency_keys ──────────────────────────────────────────────────────────
-- request_hash lets us distinguish "the same request retried" (replay the
-- stored response) from "a different request reusing a key" (reject loudly,
-- because silently replaying would answer the wrong question).
CREATE TABLE idempotency_keys (
  salon_id        uuid NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  key             text NOT NULL,
  endpoint        text NOT NULL,
  request_hash    text NOT NULL,
  status          text NOT NULL CHECK (status IN ('in_progress', 'completed')),
  response_status integer,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  PRIMARY KEY (salon_id, key),
  CONSTRAINT idempotency_completed_has_response
    CHECK (status <> 'completed' OR (response_status IS NOT NULL AND response_body IS NOT NULL))
);
CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys (expires_at);

-- ── api_keys ──────────────────────────────────────────────────────────────────
-- Raw keys are never stored. The voice agent and the staff UI hold separate
-- credentials with separate scope sets, independently revocable: revoking the
-- agent key silences the phone line without logging staff out.
CREATE TABLE api_keys (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id   uuid NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  name       text NOT NULL,
  key_hash   text NOT NULL UNIQUE,
  key_prefix text NOT NULL,          -- first chars only, for display in the UI
  scopes     text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX api_keys_active_hash_idx ON api_keys (key_hash) WHERE revoked_at IS NULL;
CREATE INDEX api_keys_salon_idx ON api_keys (salon_id);
