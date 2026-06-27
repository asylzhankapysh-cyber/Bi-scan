(function registerServices(global) {
    "use strict";

    const App = global.BScan;
    const { config, utils } = App;

    class Store {
        key(name) { return `${config.storagePrefix}${name}`; }
        get(name, fallback = null, session = false) {
            try {
                const raw = (session ? sessionStorage : localStorage).getItem(this.key(name));
                return raw === null ? fallback : JSON.parse(raw);
            } catch (error) {
                console.warn(`Storage read failed: ${name}`, error);
                return fallback;
            }
        }
        set(name, value, session = false) {
            try {
                (session ? sessionStorage : localStorage).setItem(this.key(name), JSON.stringify(value));
                return true;
            } catch (error) {
                console.error(`Storage write failed: ${name}`, error);
                return false;
            }
        }
        remove(name) {
            localStorage.removeItem(this.key(name));
            sessionStorage.removeItem(this.key(name));
        }
    }

    const store = new Store();

    async function api(path, options = {}) {
        let response;
        try {
            response = await fetch(`/api${path}`, { credentials: "include", headers: { "content-type": "application/json", ...(options.headers || {}) }, ...options });
        } catch {
            throw new Error("Сервер B-scan недоступен");
        }
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error(data.message || "Ошибка сервера");
            error.code = data.error;
            error.application = data.application;
            throw error;
        }
        return data;
    }

    class AuthService {
        constructor() { this.pendingCache = []; }
        async initialize() {
            try { const data = await api("/auth/me"); store.set("api_user", data.user); }
            catch { store.remove("api_user"); }
            try { const data = await api("/auth/status"); store.set("pending_application", data.application); }
            catch { /* A status cookie only exists for pending or rejected accounts. */ }
        }
        async ensureDemoUser() { return this.initialize(); }
        currentUser() { return store.get("api_user", null); }
        async login(email, password, remember, requestedRole = "sender", managerSecretCode = "") {
            try {
                const data = await api("/auth/login", { method: "POST", body: JSON.stringify({ email, password, remember, role: requestedRole, managerSecretCode }) });
                store.set("api_user", data.user); store.remove("pending_application"); return data.user;
            } catch (error) {
                if (error.application) store.set("pending_application", error.application);
                throw error;
            }
        }
        async register(data) {
            const result = await api("/auth/register", { method: "POST", body: JSON.stringify(data) });
            store.set("pending_application", result.application);
            return result.application;
        }
        applicationByEmail() { return store.get("pending_application", null); }
        async refreshApplication() { const data = await api("/auth/status"); store.set("pending_application", data.application); return data.application; }
        pendingApplications() { return this.pendingCache; }
        async loadPendingApplications() { const data = await api("/reviewer/registrations"); this.pendingCache = data.applications; return this.pendingCache; }
        async approve(userId) { const data = await api(`/reviewer/registrations/${userId}/approve`, { method: "POST", body: "{}" }); await this.loadPendingApplications(); return data.user; }
        async reject(userId, _reviewerId, reason) { const data = await api(`/reviewer/registrations/${userId}/reject`, { method: "POST", body: JSON.stringify({ reason }) }); await this.loadPendingApplications(); return data; }
        trustScore(userId) {
            const items = store.get("writeoffs", []).filter((item) => item.userId === userId); const approved = items.filter((item) => item.status === "approved").length; const rejected = items.filter((item) => item.status === "rejected").length; const accuracy = items.length ? approved / items.length : .9;
            return Math.max(40, Math.min(100, Math.round(82 + approved * 1.5 - rejected * 6 + accuracy * 10)));
        }
        achievements(userId) {
            const items = store.get("writeoffs", []).filter((item) => item.userId === userId); const approved = items.filter((item) => item.status === "approved").length; const rejected = items.filter((item) => item.status === "rejected").length; const score = this.trustScore(userId);
            return [{ icon: "🏆", name: "50 одобренных списаний", unlocked: approved >= 50 }, { icon: "🎯", name: "100 точных заявок", unlocked: approved >= 100 }, { icon: "🛡️", name: "Без отказов 30 дней", unlocked: items.length >= 3 && rejected === 0 }, { icon: "⭐", name: "Надёжный отправитель", unlocked: score >= 90 }, { icon: "⚡", name: "Быстрый репортер", unlocked: items.length >= 5 }];
        }
        async requestPasswordReset(email) { return api("/auth/forgot-password", { method: "POST", body: JSON.stringify({ email }) }); }
        async resetPassword(token, password) {
            return api("/auth/reset-password", { method: "POST", body: JSON.stringify({ token, password }) });
        }
        updateProfile(patch) {
            const current = this.currentUser(); if (!current) throw new Error("Сессия истекла");
            const user = { ...current, ...patch }; store.set("api_user", user);
            api("/auth/me", { method: "PATCH", body: JSON.stringify(patch) }).then((data) => store.set("api_user", data.user)).catch(console.error);
            return user;
        }
        async changePassword(currentPassword, newPassword) {
            return api("/auth/change-password", { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) });
        }
        async logout() { try { await api("/auth/logout", { method: "POST", body: "{}" }); } finally { store.remove("api_user"); } }
    }

    class WriteoffService {
        constructor() { this.seed(); }
        seed() {
            if (store.get("writeoffs") !== null) return;
            const now = Date.now();
            store.set("writeoffs", [
                { id: "WR-240627-018", userId: "employee-demo-001", productId: "prod-tomato-001", productName: "Помидоры", productIcon: "🍅", quantity: 2.5, unit: "кг", reason: "Не соответствует стандартам", type: "no_deduction", comment: "Помидоры поступили помятыми и не прошли проверку качества.", restaurant: "Bahandi • Абая 45", status: "approved", createdAt: new Date(now - 86400000).toISOString(), updatedAt: new Date(now - 82800000).toISOString(), photo: "", ai: { confidence: 94, condition: "Повреждение", risk: "low", recommendation: "approve", reasoning: "Видимы деформация и нарушение целостности." }, timeline: [{ status: "submitted", at: new Date(now - 86400000).toISOString() }, { status: "approved", at: new Date(now - 82800000).toISOString() }] },
                { id: "WR-240626-011", userId: "employee-demo-001", productId: "prod-bun-017", productName: "Булочки", productIcon: "🥯", quantity: 6, unit: "шт", reason: "Повреждено при доставке", type: "no_deduction", comment: "Упаковка повреждена, булочки деформированы.", restaurant: "Bahandi • Абая 45", status: "review", createdAt: new Date(now - 7200000).toISOString(), updatedAt: new Date(now - 7200000).toISOString(), photo: "", ai: { confidence: 88, condition: "Деформация", risk: "medium", recommendation: "review", reasoning: "Нужна проверка проверяющего." }, timeline: [{ status: "submitted", at: new Date(now - 7200000).toISOString() }, { status: "review", at: new Date(now - 7100000).toISOString() }] }
            ]);
        }
        list(userId) { return store.get("writeoffs", []).filter((item) => item.userId === userId).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)); }
        all() { return store.get("writeoffs", []).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)); }
        get(id, userId) { return this.list(userId).find((item) => item.id === id) || null; }
        getAny(id) { return store.get("writeoffs", []).find((item) => item.id === id) || null; }
        duplicate(candidate, userId) { return this.list(userId).find((item) => item.productId === candidate.productId && item.quantity === candidate.quantity && Date.now() - new Date(item.createdAt).getTime() < 10 * 60_000); }
        create(data, user) {
            const all = store.get("writeoffs", []); const date = new Date();
            const item = { ...data, id: `WR-${date.toISOString().slice(2, 10).replaceAll("-", "")}-${String(Math.floor(Math.random() * 999)).padStart(3, "0")}`, userId: user.id, restaurant: user.restaurant, status: "submitted", createdAt: date.toISOString(), updatedAt: date.toISOString(), timeline: [{ status: "submitted", at: date.toISOString() }] };
            all.unshift(item); if (!store.set("writeoffs", all)) throw new Error("Не хватает места для сохранения");
            this.notify(user.id, "Заявка отправлена", `${item.productName} • ${item.quantity} ${item.unit}`, item.id);
            return item;
        }
        updateStatus(id, userId, status) {
            const all = store.get("writeoffs", []);
            const item = all.find((entry) => entry.id === id && entry.userId === userId);
            if (!item || item.status === status) return null;
            item.status = status;
            item.updatedAt = new Date().toISOString();
            item.timeline.push({ status, at: item.updatedAt });
            store.set("writeoffs", all);
            const labels = { review: "Заявка принята в работу", approved: "Заявка подтверждена", rejected: "Заявка отклонена" };
            this.notify(userId, labels[status] || "Статус заявки изменён", `${item.productName} • ${item.id}`, item.id);
            return item;
        }
        notify(userId, title, body, requestId = null) {
            const list = store.get("notifications", []); list.unshift({ id: utils.uid("notification"), userId, title, body, requestId, read: false, createdAt: new Date().toISOString() }); store.set("notifications", list);
        }
        notifications(userId) { return store.get("notifications", []).filter((item) => item.userId === userId); }
        markNotificationsRead(userId) { const list = store.get("notifications", []); list.forEach((item) => { if (item.userId === userId) item.read = true; }); store.set("notifications", list); }
    }

    class AiService {
        async analyze(photo, onProgress = () => {}) {
            const stages = [[15, "Проверяем качество снимка"], [42, "Определяем продукт"], [70, "Оцениваем состояние"], [92, "Формируем рекомендацию"]];
            for (const [progress, message] of stages) { onProgress(progress, message); await new Promise((resolve) => setTimeout(resolve, 420)); }
            const product = config.products[Math.floor(Math.random() * 3)]; const confidence = 87 + Math.floor(Math.random() * 11);
            onProgress(100, "Анализ готов");
            return { productId: product.id, productName: product.name, productIcon: product.icon, confidence, condition: confidence > 92 ? "Видимое повреждение" : "Требует проверки", quality: photo.length > 50_000 ? "good" : "acceptable", risk: confidence > 90 ? "low" : "medium", recommendation: confidence > 90 ? "approve" : "review", reasoning: "Форма, цвет и текстура соответствуют выбранному продукту. Видимы признаки, из-за которых продукт нельзя использовать.", suggestedComment: `${product.name}: обнаружены видимые дефекты, продукт не соответствует стандартам ресторана.` };
        }
        compare(ai, selectedProductId) { return { matches: ai.productId === selectedProductId, message: ai.productId === selectedProductId ? "Выбор совпадает с AI-анализом" : `AI распознал: ${ai.productName}. Проверьте выбор.` }; }
    }

    App.services = { store, auth: new AuthService(), writeoffs: new WriteoffService(), ai: new AiService() };
})(window);
