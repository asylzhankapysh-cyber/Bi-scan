# B-scan backend

Обычный Node.js/Express API запускается из `server/index.js`. PostgreSQL-схема находится в `server/schema.sql`.

## Required endpoints

- `POST /api/auth/register`, `/login`, `/logout`
- `GET /api/auth/me`, `/status`
- `POST /v1/auth/forgot-password`, `/reset-password`
- `GET/PATCH /v1/me`
- `GET /v1/me/pass`, `GET /v1/me/achievements`, `GET /v1/me/trust-score`
- `GET /api/reviewer/registrations`
- `POST /api/reviewer/registrations/:id/approve`, `/reject`
- `POST /api/telegram/webhook`
- `POST /v1/uploads/presign`
- `POST /v1/ai/analyze`
- `GET/POST /v1/writeoffs`
- `GET /v1/writeoffs/:id`
- `GET/PATCH /v1/notifications`
- `GET /v1/events` using Server-Sent Events for live status updates

## Security baseline

- Argon2id password hashing and rotating, hashed refresh tokens in secure `HttpOnly` cookies.
- CSRF protection, strict CORS allowlist, CSP, HSTS and per-route rate limits.
- Restaurant-level row authorization on every query. Never trust restaurant or sender IDs from clients.
- Validate the Reviewer Secret Code only on the server using a constant-time comparison against a rotated secret in the managed vault. Never return or persist the plaintext code.
- Reviewer login requires email, personal password and the Reviewer Secret Code. Role selection from the client is never accepted as authorization.
- Short-lived signed upload URLs, MIME sniffing, malware scanning and image metadata stripping.
- Idempotency keys on write-off and iiko mutations; encrypted secrets in a managed vault.
- Immutable audit events for submission, review, rejection and iiko synchronization.
- AI output is advisory only, schema-validated, versioned and never allowed to approve autonomously.
- Telegram and email messages are written transactionally to an outbox and delivered by workers; bot tokens and SMTP credentials never reach the browser.
- Sender IDs are allocated inside a database transaction using a locked sequence and formatted as `BH-000001`.
- Identity documents use a private encrypted bucket, short-lived reviewer URLs, access auditing and retention-based deletion.
- Structured logs without photos, passwords, tokens or sender personal data.

## Integration workflow

1. Client uploads a compressed image to object storage through a signed URL.
2. API creates the write-off and enqueues AI analysis.
3. Worker stores the validated AI assessment and alerts the sender on poor quality/mismatch.
4. Reviewer decision emits an event and queues an idempotent iiko write-off document.
5. Worker records the iiko document ID and emits a live status event to the sender.
