(function bootstrapConfig(global) {
    "use strict";

    const App = global.BScan = global.BScan || {};

    App.config = Object.freeze({
        appName: "B-scan",
        version: "2.0.0",
        storagePrefix: "spisanie_v2_",
        image: Object.freeze({ maxBytes: 10 * 1024 * 1024, maxDimension: 1440, quality: 0.84 }),
        products: Object.freeze([
            { id: "prod-tomato-001", name: "Помидоры", defaultUnit: "кг", icon: "🍅" },
            { id: "prod-cutlet-042", name: "Котлеты", defaultUnit: "шт", icon: "🥩" },
            { id: "prod-bun-017", name: "Булочки", defaultUnit: "шт", icon: "🥯" },
            { id: "prod-cheese-023", name: "Сыр", defaultUnit: "кг", icon: "🧀" },
            { id: "prod-potato-009", name: "Картофель фри", defaultUnit: "кг", icon: "🍟" },
            { id: "prod-other-999", name: "Другое", defaultUnit: "шт", icon: "📦" }
        ]),
        reasons: Object.freeze([
            "Не соответствует стандартам",
            "Повреждено при доставке",
            "Нарушены санитарные нормы",
            "Ошибка приготовления",
            "Истёк срок годности",
            "Излишек после приготовления",
            "Другая причина"
        ]),
        locations: Object.freeze([
            { id: "bh-abay-45", name: "Bahandi • Абая 45", address: "ул. Абая, 45", city: "Алматы", hours: "09:00–02:00" },
            { id: "bh-mega", name: "Bahandi • Mega Center", address: "ТЦ Mega Center", city: "Алматы", hours: "10:00–23:00" },
            { id: "bh-kenesary-12", name: "Bahandi • Кенесары 12", address: "ул. Кенесары, 12", city: "Астана", hours: "09:00–01:00" },
            { id: "bh-satpayev-32", name: "Bahandi • Сатпаева 32", address: "ул. Сатпаева, 32", city: "Алматы", hours: "09:00–01:00" },
            { id: "bh-turan-24", name: "Bahandi • Туран 24", address: "пр. Туран, 24", city: "Астана", hours: "10:00–02:00" },
            { id: "bh-shymkent", name: "Bahandi • Shymkent Plaza", address: "пл. Аль-Фараби, 3/1", city: "Шымкент", hours: "10:00–00:00" }
        ]),
        routes: Object.freeze(["login", "register", "pending", "forgot", "reset", "dashboard", "reviewer", "create", "history", "request", "notifications", "profile", "pass", "settings", "help", "about"])
    });

    App.utils = {
        escapeHtml(value) {
            return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
        },
        uid(prefix = "id") {
            return global.crypto?.randomUUID?.() || `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        },
        formatDate(value, withTime = false) {
            const date = new Date(value);
            if (Number.isNaN(date.getTime())) return "—";
            return new Intl.DateTimeFormat("ru-RU", withTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" }).format(date);
        },
        formatNumber(value) {
            return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(Number(value));
        },
        initials(name) {
            return String(name).trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
        },
        debounce(callback, delay = 250) {
            let timer;
            return (...args) => { clearTimeout(timer); timer = setTimeout(() => callback(...args), delay); };
        }
    };
})(window);
