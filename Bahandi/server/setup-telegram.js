import "dotenv/config";

const required = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "PUBLIC_BASE_URL"];
for (const name of required) if (!process.env[name]) throw new Error(`Missing ${name}`);

const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
        url: `${process.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/api/telegram/webhook`,
        secret_token: process.env.TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: ["callback_query"],
        drop_pending_updates: true
    })
});
const result = await response.json();
if (!response.ok || !result.ok) throw new Error(result.description || "Unable to configure Telegram webhook");
console.log("Telegram webhook configured.");
