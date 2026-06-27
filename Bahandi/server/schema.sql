CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";

CREATE TYPE user_role AS ENUM ('sender', 'reviewer', 'admin');
CREATE TYPE approval_status AS ENUM ('pending', 'approved', 'rejected');
CREATE TYPE writeoff_status AS ENUM ('draft', 'submitted', 'review', 'approved', 'rejected', 'synced');
CREATE TYPE writeoff_type AS ENUM ('no_deduction', 'with_deduction');
CREATE SEQUENCE employee_code_sequence START 1;

CREATE TABLE restaurants (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    registration_code text UNIQUE NOT NULL,
    iiko_id text UNIQUE NOT NULL,
    name text NOT NULL,
    address text NOT NULL,
    timezone text NOT NULL DEFAULT 'Asia/Qyzylorda',
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE employees (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_code text,
    restaurant_id uuid NOT NULL REFERENCES restaurants(id),
    email citext UNIQUE NOT NULL,
    password_hash text NOT NULL,
    last_name text NOT NULL,
    first_name text NOT NULL,
    patronymic text,
    birth_date date NOT NULL,
    full_name text NOT NULL,
    position text NOT NULL,
    phone text,
    avatar_key text,
    avatar_mime text,
    avatar_data bytea,
    identity_document_key text,
    identity_document_mime text,
    identity_document_data bytea,
    approval_status approval_status NOT NULL DEFAULT 'pending',
    rejection_reason text,
    approved_by uuid REFERENCES employees(id),
    approved_at timestamptz,
    pass_token uuid UNIQUE,
    email_verified_at timestamptz,
    role user_role NOT NULL DEFAULT 'sender',
    settings jsonb NOT NULL DEFAULT '{"darkMode":false,"notifications":true,"haptics":true,"language":"ru"}'::jsonb,
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    refresh_token_hash text UNIQUE NOT NULL,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE password_reset_tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    token_hash text UNIQUE NOT NULL,
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE writeoffs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    display_id text UNIQUE NOT NULL,
    employee_id uuid NOT NULL REFERENCES employees(id),
    restaurant_id uuid NOT NULL REFERENCES restaurants(id),
    product_iiko_id text NOT NULL,
    product_name text NOT NULL,
    quantity numeric(12,3) NOT NULL CHECK (quantity > 0),
    unit text NOT NULL,
    reason text NOT NULL,
    type writeoff_type NOT NULL,
    responsible_employee_id uuid REFERENCES employees(id),
    comment text NOT NULL CHECK (char_length(comment) >= 10),
    photo_key text NOT NULL,
    status writeoff_status NOT NULL DEFAULT 'submitted',
    iiko_document_id text,
    idempotency_key uuid UNIQUE NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ai_assessments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    writeoff_id uuid UNIQUE NOT NULL REFERENCES writeoffs(id) ON DELETE CASCADE,
    model text NOT NULL,
    detected_product_id text,
    confidence numeric(5,2) CHECK (confidence BETWEEN 0 AND 100),
    image_quality text NOT NULL,
    condition text,
    risk text NOT NULL,
    recommendation text NOT NULL,
    reasoning text NOT NULL,
    raw_response jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE writeoff_events (
    id bigserial PRIMARY KEY,
    writeoff_id uuid NOT NULL REFERENCES writeoffs(id) ON DELETE CASCADE,
    actor_id uuid REFERENCES employees(id),
    status writeoff_status NOT NULL,
    note text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    writeoff_id uuid REFERENCES writeoffs(id) ON DELETE CASCADE,
    title text NOT NULL,
    body text NOT NULL,
    read_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE integration_outbox (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    channel text NOT NULL CHECK (channel IN ('email', 'telegram', 'iiko')),
    event_type text NOT NULL,
    aggregate_id uuid NOT NULL,
    payload jsonb NOT NULL,
    status text NOT NULL DEFAULT 'queued',
    attempts integer NOT NULL DEFAULT 0,
    available_at timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE approval_events (
    id bigserial PRIMARY KEY,
    employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    action text NOT NULL CHECK (action IN ('submitted', 'approved', 'rejected')),
    actor text NOT NULL,
    reason text,
    telegram_user_id bigint,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX employees_employee_code_unique ON employees(employee_code) WHERE approval_status = 'approved';
CREATE UNIQUE INDEX employees_pass_token_unique ON employees(pass_token) WHERE pass_token IS NOT NULL;
CREATE INDEX integration_outbox_queue_idx ON integration_outbox(status, available_at) WHERE status = 'queued';

CREATE INDEX writeoffs_employee_created_idx ON writeoffs(employee_id, created_at DESC);
CREATE INDEX writeoffs_restaurant_status_idx ON writeoffs(restaurant_id, status, created_at DESC);
CREATE INDEX notifications_employee_unread_idx ON notifications(employee_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX approval_events_employee_idx ON approval_events(employee_id, created_at DESC);

INSERT INTO restaurants (iiko_id, name, address) VALUES
('bh-abay-45', 'Bahandi • Абая 45', 'ул. Абая, 45'),
('bh-mega', 'Bahandi • Mega Center', 'ТЦ Mega Center'),
('bh-kenesary-12', 'Bahandi • Кенесары 12', 'ул. Кенесары, 12'),
('bh-satpayev-32', 'Bahandi • Сатпаева 32', 'ул. Сатпаева, 32'),
('bh-turan-24', 'Bahandi • Туран 24', 'пр. Туран, 24'),
('bh-shymkent', 'Bahandi • Shymkent Plaza', 'пл. Аль-Фараби, 3/1')
ON CONFLICT (iiko_id) DO NOTHING;
