import "dotenv/config";
import crypto from "node:crypto";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import nodemailer from "nodemailer";
import pg from "pg";

const { Pool } = pg;
const scrypt = promisify(crypto.scrypt);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false });
const port = Number(process.env.PORT || 3000);
const sessionCookie = "bscan_session";
const approvalCookie = "bscan_approval";

function requiredEnv(name) {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required environment variable: ${name}`);
    return value;
}

function json(res, status, body) { return res.status(status).json(body); }
function normalizeEmail(value) { return String(value || "").trim().toLowerCase(); }
function safeEqual(left, right) {
    const a = Buffer.from(String(left || ""));
    const b = Buffer.from(String(right || ""));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function publicUser(row) {
    return { id: row.id, registrationId: row.registration_code, employeeId: row.employee_code, email: row.email, firstName: row.first_name, lastName: row.last_name, patronymic: row.patronymic || "", name: row.full_name, birthDate: row.birth_date, phone: row.phone, role: row.role, position: row.position, restaurant: row.restaurant_name, locationId: row.restaurant_iiko_id, avatar: row.avatar_data ? "/api/auth/avatar" : "", idDocument: `/api/reviewer/registrations/${row.id}/document`, status: row.approval_status, rejectionReason: row.rejection_reason, passToken: row.pass_token, joinedAt: row.approved_at, createdAt: row.created_at, settings: row.settings || { darkMode: false, notifications: true, haptics: true, language: "ru" } };
}
function employeeSelect() {
    return `SELECT e.*, r.name AS restaurant_name, r.iiko_id AS restaurant_iiko_id
            FROM employees e JOIN restaurants r ON r.id = e.restaurant_id`;
}

async function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString("hex");
    const derived = await scrypt(password, salt, 64);
    return `scrypt:${salt}:${Buffer.from(derived).toString("hex")}`;
}
async function verifyPassword(password, encoded) {
    const [algorithm, salt, expected] = String(encoded || "").split(":");
    if (algorithm !== "scrypt" || !salt || !expected) return false;
    const actual = Buffer.from(await scrypt(password, salt, 64));
    const target = Buffer.from(expected, "hex");
    return actual.length === target.length && crypto.timingSafeEqual(actual, target);
}

function parseCookies(req) {
    return Object.fromEntries(String(req.headers.cookie || "").split(";").map((part) => part.trim().split(/=(.*)/s)).filter(([key]) => key).map(([key, value]) => [key, decodeURIComponent(value || "")]));
}
function setCookie(res, name, value, maxAge) {
    res.cookie(name, value, { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", path: "/", maxAge });
}
function clearCookie(res, name) { res.clearCookie(name, { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", path: "/" }); }
function signApproval(userId) {
    const expires = Date.now() + 7 * 86400000;
    const payload = `${userId}.${expires}`;
    return `${payload}.${crypto.createHmac("sha256", requiredEnv("SESSION_SECRET")).update(payload).digest("hex")}`;
}
function readApproval(req) {
    const [userId, expires, signature] = String(parseCookies(req)[approvalCookie] || "").split(".");
    if (!userId || Number(expires) < Date.now()) return null;
    const expected = crypto.createHmac("sha256", requiredEnv("SESSION_SECRET")).update(`${userId}.${expires}`).digest("hex");
    return safeEqual(signature, expected) ? userId : null;
}

async function createSession(res, userId, remember) {
    const token = crypto.randomBytes(32).toString("base64url");
    const days = remember ? 30 : 1;
    await pool.query("INSERT INTO sessions (employee_id, refresh_token_hash, expires_at) VALUES ($1,$2,now()+$3*interval '1 day')", [userId, sha256(token), days]);
    setCookie(res, sessionCookie, token, days * 86400000);
}
async function authenticate(req, res, next) {
    try {
        const token = parseCookies(req)[sessionCookie];
        if (!token) return json(res, 401, { error: "AUTH_REQUIRED", message: "Требуется вход" });
        const result = await pool.query(`${employeeSelect()} JOIN sessions s ON s.employee_id=e.id WHERE s.refresh_token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND e.approval_status='approved' AND e.active=true`, [sha256(token)]);
        if (!result.rowCount) return json(res, 401, { error: "SESSION_EXPIRED", message: "Сессия истекла" });
        req.user = result.rows[0];
        next();
    } catch (error) { next(error); }
}
function reviewerOnly(req, res, next) { return req.user.role === "reviewer" ? next() : json(res, 403, { error: "FORBIDDEN", message: "Доступ только для проверяющего" }); }

function decodeDocument(dataUri) {
    const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUri || ""));
    if (!match) throw Object.assign(new Error("Загрузите JPG, PNG или WEBP документ"), { status: 400 });
    const data = Buffer.from(match[2], "base64");
    if (!data.length || data.length > 10 * 1024 * 1024) throw Object.assign(new Error("Документ должен быть не больше 10 МБ"), { status: 400 });
    return { mime: match[1], data };
}
function validateRegistration(body) {
    const required = ["lastName", "firstName", "birthDate", "phone", "email", "password", "role", "locationId", "idDocument"];
    for (const key of required) if (!String(body[key] || "").trim()) throw Object.assign(new Error(`Поле ${key} обязательно`), { status: 400 });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) throw Object.assign(new Error("Некорректный email"), { status: 400 });
    if (!/^(?=.*[A-Za-zА-Яа-я])(?=.*\d).{8,128}$/.test(body.password)) throw Object.assign(new Error("Пароль должен содержать минимум 8 символов, букву и цифру"), { status: 400 });
    if (!["sender", "reviewer"].includes(body.role)) throw Object.assign(new Error("Некорректная роль"), { status: 400 });
    if (body.role === "reviewer" && !safeEqual(body.managerSecretCode, requiredEnv("REVIEWER_SECRET_CODE"))) throw Object.assign(new Error("Неверный секретный код проверяющего"), { status: 403 });
}

async function telegram(method, payload) {
    const response = await fetch(`https://api.telegram.org/bot${requiredEnv("TELEGRAM_BOT_TOKEN")}/${method}`, { method: "POST", headers: payload instanceof FormData ? undefined : { "content-type": "application/json" }, body: payload instanceof FormData ? payload : JSON.stringify(payload) });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(`Telegram ${method}: ${result.description || response.statusText}`);
    return result.result;
}
function escapeTelegram(value) { return String(value ?? "").replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char]); }
async function sendRegistrationToTelegram(userId) {
    const result = await pool.query(`${employeeSelect()} WHERE e.id=$1`, [userId]);
    if (!result.rowCount) throw new Error("Registration not found");
    const user = result.rows[0];
    const caption = `━━━━━━━━━━━━━━━━━━\n🆕 <b>Новая заявка на регистрацию</b>\n\n👤 ${escapeTelegram(user.full_name)}\n🪪 ${escapeTelegram(user.registration_code)}\n📧 ${escapeTelegram(user.email)}\n📱 ${escapeTelegram(user.phone)}\n🎂 ${escapeTelegram(new Date(user.birth_date).toLocaleDateString("ru-RU"))}\n📍 ${escapeTelegram(user.restaurant_name)}\n👔 ${user.role === "reviewer" ? "Проверяющий" : "Отправитель"}\n🕒 ${escapeTelegram(new Date(user.created_at).toLocaleString("ru-RU", { timeZone: "Asia/Qyzylorda" }))}\n━━━━━━━━━━━━━━━━━━`;
    const form = new FormData();
    form.append("chat_id", requiredEnv("TELEGRAM_MANAGER_CHAT_ID"));
    form.append("photo", new Blob([user.identity_document_data], { type: user.identity_document_mime }), "identity-document.jpg");
    form.append("caption", caption);
    form.append("parse_mode", "HTML");
    form.append("reply_markup", JSON.stringify({ inline_keyboard: [[{ text: "✅ Одобрить", callback_data: `approve_${user.id}` }, { text: "❌ Отклонить", callback_data: `reject_${user.id}` }]] }));
    return telegram("sendPhoto", form);
}

function mailTransport() {
    if (!process.env.SMTP_HOST) return null;
    return nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: process.env.SMTP_SECURE === "true", auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined });
}
async function sendDecisionEmail(user, approved, reason = "") {
    const transport = mailTransport();
    if (!transport) { console.warn("SMTP is not configured; approval email was not sent"); return; }
    await transport.sendMail({ from: process.env.EMAIL_FROM, to: user.email, subject: approved ? "Ваш аккаунт B-scan одобрен" : "Регистрация B-scan отклонена", text: approved ? `Ваш аккаунт активирован. ID отправителя: ${user.employee_code}` : `Регистрация отклонена. Причина: ${reason}` });
}

async function decideRegistration(userId, action, actor, telegramUserId = null, reason = "") {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const locked = await client.query(`${employeeSelect()} WHERE e.id=$1 FOR UPDATE OF e`, [userId]);
        if (!locked.rowCount) throw Object.assign(new Error("Заявка не найдена"), { status: 404 });
        const user = locked.rows[0];
        if (user.approval_status !== "pending") throw Object.assign(new Error("Заявка уже обработана"), { status: 409 });
        if (action === "approve") {
            const code = await client.query("SELECT nextval('employee_code_sequence') AS value");
            user.employee_code = `BH-${String(code.rows[0].value).padStart(6, "0")}`;
            const updated = await client.query("UPDATE employees SET approval_status='approved', employee_code=$2, pass_token=gen_random_uuid(), approved_at=now(), updated_at=now() WHERE id=$1 RETURNING *", [userId, user.employee_code]);
            Object.assign(user, updated.rows[0]);
        } else {
            reason ||= "Отклонено проверяющим в Telegram";
            await client.query("UPDATE employees SET approval_status='rejected', rejection_reason=$2, updated_at=now() WHERE id=$1", [userId, reason]);
            user.approval_status = "rejected"; user.rejection_reason = reason;
        }
        await client.query("INSERT INTO approval_events (employee_id, action, actor, reason, telegram_user_id) VALUES ($1,$2,$3,$4,$5)", [userId, action === "approve" ? "approved" : "rejected", actor, reason || null, telegramUserId]);
        await client.query("COMMIT");
        sendDecisionEmail(user, action === "approve", reason).catch(console.error);
        return user;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "14mb" }));
app.use("/api/auth", rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false }));

app.post("/api/auth/register", async (req, res, next) => {
    try {
        validateRegistration(req.body);
        const document = decodeDocument(req.body.idDocument);
        const email = normalizeEmail(req.body.email);
        const passwordHash = await hashPassword(req.body.password);
        const client = await pool.connect();
        let user;
        try {
            await client.query("BEGIN");
            const restaurant = await client.query("SELECT id FROM restaurants WHERE iiko_id=$1 AND active=true", [req.body.locationId]);
            if (!restaurant.rowCount) throw Object.assign(new Error("Точка Bahandi не найдена"), { status: 400 });
            const existing = await client.query("SELECT id, approval_status FROM employees WHERE email=$1 FOR UPDATE", [email]);
            if (existing.rowCount && existing.rows[0].approval_status !== "rejected") throw Object.assign(new Error("Аккаунт с таким email уже существует"), { status: 409 });
            const registrationCode = `REG-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
            const values = [registrationCode, restaurant.rows[0].id, email, passwordHash, req.body.lastName.trim(), req.body.firstName.trim(), String(req.body.patronymic || "").trim(), req.body.birthDate, `${req.body.lastName.trim()} ${req.body.firstName.trim()} ${String(req.body.patronymic || "").trim()}`.trim(), req.body.role === "reviewer" ? "Проверяющий" : "Отправитель", req.body.phone.trim(), document.mime, document.data, req.body.role];
            if (existing.rowCount) {
                const updated = await client.query("UPDATE employees SET registration_code=$1, restaurant_id=$2, email=$3, password_hash=$4, last_name=$5, first_name=$6, patronymic=$7, birth_date=$8, full_name=$9, position=$10, phone=$11, identity_document_mime=$12, identity_document_data=$13, role=$14, approval_status='pending', rejection_reason=NULL, employee_code=NULL, pass_token=NULL, approved_at=NULL, updated_at=now() WHERE id=$15 RETURNING id", [...values, existing.rows[0].id]);
                user = updated.rows[0];
            } else {
                const inserted = await client.query("INSERT INTO employees (registration_code,restaurant_id,email,password_hash,last_name,first_name,patronymic,birth_date,full_name,position,phone,identity_document_mime,identity_document_data,role) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id", values);
                user = inserted.rows[0];
            }
            await client.query("INSERT INTO approval_events (employee_id, action, actor) VALUES ($1,'submitted','user')", [user.id]);
            await client.query("COMMIT");
        } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
        setCookie(res, approvalCookie, signApproval(user.id), 7 * 86400000);
        let telegramDelivered = true;
        try { await sendRegistrationToTelegram(user.id); } catch (error) { telegramDelivered = false; console.error(error); }
        const saved = await pool.query(`${employeeSelect()} WHERE e.id=$1`, [user.id]);
        return json(res, 201, { status: "pending", telegramDelivered, application: publicUser(saved.rows[0]), message: "Регистрация успешно отправлена" });
    } catch (error) { next(error); }
});

app.post("/api/auth/login", async (req, res, next) => {
    try {
        const result = await pool.query(`${employeeSelect()} WHERE e.email=$1`, [normalizeEmail(req.body.email)]);
        const user = result.rows[0];
        if (!user || !await verifyPassword(req.body.password, user.password_hash) || user.role !== req.body.role) return json(res, 401, { error: "INVALID_CREDENTIALS", message: "Неверный email или пароль" });
        if (user.role === "reviewer" && !safeEqual(req.body.managerSecretCode, requiredEnv("REVIEWER_SECRET_CODE"))) return json(res, 403, { error: "INVALID_REVIEWER_CODE", message: "Неверный секретный код проверяющего" });
        if (user.approval_status !== "approved") {
            setCookie(res, approvalCookie, signApproval(user.id), 7 * 86400000);
            return json(res, 403, { error: user.approval_status === "rejected" ? "REJECTED" : "PENDING", message: user.approval_status === "rejected" ? "Ваша регистрация отклонена" : "Аккаунт ожидает одобрения", application: publicUser(user) });
        }
        await createSession(res, user.id, Boolean(req.body.remember));
        clearCookie(res, approvalCookie);
        return json(res, 200, { user: publicUser(user) });
    } catch (error) { next(error); }
});

app.get("/api/auth/status", async (req, res, next) => {
    try {
        const userId = readApproval(req);
        if (!userId) return json(res, 401, { error: "STATUS_AUTH_REQUIRED", message: "Войдите, чтобы проверить статус" });
        const result = await pool.query(`${employeeSelect()} WHERE e.id=$1`, [userId]);
        if (!result.rowCount) return json(res, 404, { error: "NOT_FOUND", message: "Заявка не найдена" });
        return json(res, 200, { application: publicUser(result.rows[0]) });
    } catch (error) { next(error); }
});
app.get("/api/auth/me", authenticate, (req, res) => json(res, 200, { user: publicUser(req.user) }));
app.get("/api/auth/avatar", authenticate, (req, res) => { if (!req.user.avatar_data) return res.sendStatus(404); res.set({ "content-type": req.user.avatar_mime, "cache-control": "private, no-store" }); return res.send(req.user.avatar_data); });
app.patch("/api/auth/me", authenticate, async (req, res, next) => {
    try {
        const phone = String(req.body.phone ?? req.user.phone).trim();
        if (!/^\+?[\d\s()-]{10,20}$/.test(phone)) return json(res, 400, { error: "INVALID_PHONE", message: "Проверьте номер телефона" });
        const settings = { ...req.user.settings, ...(req.body.settings || {}) };
        let avatar = null;
        if (req.body.avatar) avatar = decodeDocument(req.body.avatar);
        await pool.query("UPDATE employees SET phone=$2, settings=$3, avatar_mime=COALESCE($4,avatar_mime), avatar_data=COALESCE($5,avatar_data), updated_at=now() WHERE id=$1", [req.user.id, phone, settings, avatar?.mime || null, avatar?.data || null]);
        const result = await pool.query(`${employeeSelect()} WHERE e.id=$1`, [req.user.id]);
        return json(res, 200, { user: publicUser(result.rows[0]) });
    } catch (error) { next(error); }
});
app.post("/api/auth/change-password", authenticate, async (req, res, next) => {
    try {
        if (!await verifyPassword(req.body.currentPassword, req.user.password_hash)) return json(res, 400, { error: "INVALID_PASSWORD", message: "Текущий пароль указан неверно" });
        if (!/^(?=.*[A-Za-zА-Яа-я])(?=.*\d).{8,128}$/.test(req.body.newPassword || "")) return json(res, 400, { error: "WEAK_PASSWORD", message: "Новый пароль слишком слабый" });
        await pool.query("UPDATE employees SET password_hash=$2, updated_at=now() WHERE id=$1", [req.user.id, await hashPassword(req.body.newPassword)]);
        return json(res, 200, { ok: true });
    } catch (error) { next(error); }
});
app.post("/api/auth/forgot-password", async (req, res, next) => {
    try {
        const result = await pool.query("SELECT id,email FROM employees WHERE email=$1", [normalizeEmail(req.body.email)]);
        if (result.rowCount) {
            const token = crypto.randomBytes(24).toString("base64url");
            await pool.query("INSERT INTO password_reset_tokens (employee_id,token_hash,expires_at) VALUES ($1,$2,now()+interval '15 minutes')", [result.rows[0].id, sha256(token)]);
            const transport = mailTransport();
            if (transport) await transport.sendMail({ from: process.env.EMAIL_FROM, to: result.rows[0].email, subject: "Восстановление пароля B-scan", text: `Откройте ссылку в течение 15 минут: ${requiredEnv("PUBLIC_BASE_URL").replace(/\/$/, "")}/#/reset/${token}` });
        }
        return json(res, 200, { ok: true });
    } catch (error) { next(error); }
});
app.post("/api/auth/reset-password", async (req, res, next) => {
    const client = await pool.connect();
    try {
        if (!/^(?=.*[A-Za-zА-Яа-я])(?=.*\d).{8,128}$/.test(req.body.password || "")) return json(res, 400, { error: "WEAK_PASSWORD", message: "Новый пароль слишком слабый" });
        await client.query("BEGIN");
        const token = await client.query("SELECT * FROM password_reset_tokens WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now() FOR UPDATE", [sha256(req.body.token || "")]);
        if (!token.rowCount) { await client.query("ROLLBACK"); return json(res, 400, { error: "INVALID_RESET_TOKEN", message: "Код неверен или истёк" }); }
        await client.query("UPDATE employees SET password_hash=$2, updated_at=now() WHERE id=$1", [token.rows[0].employee_id, await hashPassword(req.body.password)]);
        await client.query("UPDATE password_reset_tokens SET used_at=now() WHERE id=$1", [token.rows[0].id]);
        await client.query("UPDATE sessions SET revoked_at=now() WHERE employee_id=$1 AND revoked_at IS NULL", [token.rows[0].employee_id]);
        await client.query("COMMIT");
        return json(res, 200, { ok: true });
    } catch (error) { await client.query("ROLLBACK"); next(error); } finally { client.release(); }
});
app.post("/api/auth/logout", async (req, res, next) => { try { const token = parseCookies(req)[sessionCookie]; if (token) await pool.query("UPDATE sessions SET revoked_at=now() WHERE refresh_token_hash=$1", [sha256(token)]); clearCookie(res, sessionCookie); return json(res, 200, { ok: true }); } catch (error) { next(error); } });

app.get("/api/reviewer/registrations", authenticate, reviewerOnly, async (req, res, next) => { try { const result = await pool.query(`${employeeSelect()} WHERE e.approval_status='pending' ORDER BY e.created_at`); return json(res, 200, { applications: result.rows.map(publicUser) }); } catch (error) { next(error); } });
app.get("/api/reviewer/registrations/:id/document", authenticate, reviewerOnly, async (req, res, next) => { try { const result = await pool.query("SELECT identity_document_mime, identity_document_data FROM employees WHERE id=$1", [req.params.id]); if (!result.rowCount || !result.rows[0].identity_document_data) return res.sendStatus(404); res.set({ "content-type": result.rows[0].identity_document_mime, "cache-control": "private, no-store" }); return res.send(result.rows[0].identity_document_data); } catch (error) { next(error); } });
app.post("/api/reviewer/registrations/:id/approve", authenticate, reviewerOnly, async (req, res, next) => { try { const user = await decideRegistration(req.params.id, "approve", `reviewer:${req.user.id}`); return json(res, 200, { user: publicUser({ ...user, restaurant_name: user.restaurant_name, restaurant_iiko_id: user.restaurant_iiko_id }) }); } catch (error) { next(error); } });
app.post("/api/reviewer/registrations/:id/reject", authenticate, reviewerOnly, async (req, res, next) => { try { const reason = String(req.body.reason || "").trim(); if (reason.length < 5) return json(res, 400, { error: "REASON_REQUIRED", message: "Укажите причину отклонения" }); await decideRegistration(req.params.id, "reject", `reviewer:${req.user.id}`, null, reason); return json(res, 200, { ok: true }); } catch (error) { next(error); } });

app.post("/api/telegram/webhook", async (req, res, next) => {
    try {
        if (!safeEqual(req.get("X-Telegram-Bot-Api-Secret-Token"), requiredEnv("TELEGRAM_WEBHOOK_SECRET"))) return res.sendStatus(403);
        const callback = req.body.callback_query;
        if (!callback?.data) return json(res, 200, { ok: true });
        if (String(callback.message?.chat?.id) !== String(requiredEnv("TELEGRAM_MANAGER_CHAT_ID"))) return res.sendStatus(403);
        const match = /^(approve|reject)_([0-9a-f-]{36})$/i.exec(callback.data);
        if (!match) { await telegram("answerCallbackQuery", { callback_query_id: callback.id, text: "Неизвестная команда", show_alert: true }); return json(res, 200, { ok: true }); }
        try {
            const user = await decideRegistration(match[2], match[1], "telegram", callback.from?.id);
            const text = match[1] === "approve" ? `✅ Одобрено: ${user.employee_code}` : "❌ Регистрация отклонена";
            await telegram("answerCallbackQuery", { callback_query_id: callback.id, text });
            if (callback.message?.message_id) await telegram("editMessageReplyMarkup", { chat_id: callback.message.chat.id, message_id: callback.message.message_id, reply_markup: { inline_keyboard: [] } });
        } catch (error) {
            await telegram("answerCallbackQuery", { callback_query_id: callback.id, text: error.message, show_alert: true });
        }
        return json(res, 200, { ok: true });
    } catch (error) { next(error); }
});

app.get("/api/health", async (_req, res, next) => { try { await pool.query("SELECT 1"); return json(res, 200, { ok: true, service: "B-scan API" }); } catch (error) { next(error); } });
app.use("/js", express.static(path.join(root, "js"), { fallthrough: false }));
for (const file of ["styles.css", "utilities.css", "index.html"]) app.get(`/${file === "index.html" ? "" : file}`, (_req, res) => res.sendFile(path.join(root, file)));
app.get("/*path", (_req, res) => res.sendFile(path.join(root, "index.html")));
app.use((error, _req, res, _next) => { console.error(error); return json(res, error.status || 500, { error: error.code || "SERVER_ERROR", message: error.status ? error.message : "Внутренняя ошибка сервера" }); });

async function start() {
    requiredEnv("DATABASE_URL"); requiredEnv("SESSION_SECRET"); requiredEnv("REVIEWER_SECRET_CODE"); requiredEnv("TELEGRAM_BOT_TOKEN"); requiredEnv("TELEGRAM_MANAGER_CHAT_ID"); requiredEnv("TELEGRAM_WEBHOOK_SECRET");
    if (process.env.SESSION_SECRET.length < 32) throw new Error("SESSION_SECRET must contain at least 32 characters");
    await pool.query("SELECT 1");
    app.listen(port, () => console.log(`B-scan running at http://localhost:${port}`));
}
start().catch((error) => { console.error(error); process.exit(1); });
