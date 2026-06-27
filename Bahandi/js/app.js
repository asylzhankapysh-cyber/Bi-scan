(function startApplication(global) {
    "use strict";

    const App = global.BScan;
    const { config, services, views, utils } = App;
    const root = document.getElementById("app");
    const dialogRoot = document.getElementById("dialog-root");
    const toastRegion = document.getElementById("toast-region");
    const networkBanner = document.getElementById("network-banner");

    const state = {
        route: "",
        params: [],
        authRole: "sender",
        historyFilter: "all",
        draft: freshDraft(),
        onboarding: freshOnboarding(),
        submittedItem: null
    };

    document.addEventListener("DOMContentLoaded", init);

    async function init() {
        await services.auth.initialize();
        if (services.auth.currentUser()?.role === "reviewer") await services.auth.loadPendingApplications().catch(() => {});
        applyTheme();
        bindGlobalEvents();
        window.setTimeout(route, 500);
    }

    function bindGlobalEvents() {
        global.addEventListener("hashchange", route);
        global.addEventListener("online", updateNetworkStatus);
        global.addEventListener("offline", updateNetworkStatus);
        document.addEventListener("click", (event) => {
            if (event.target.closest("#theme-quick")) toggleTheme();
        });
        updateNetworkStatus();
    }

    function parseRoute() {
        const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
        return { name: parts[0] || (services.auth.currentUser() ? "dashboard" : "login"), params: parts.slice(1) };
    }

    function route() {
        const next = parseRoute();
        const user = services.auth.currentUser();
        const authRoutes = ["login", "register", "pending", "forgot", "reset"];

        if (next.name === "create" && state.route !== "create" && state.submittedItem) {
            state.submittedItem = null;
            state.draft = freshDraft();
        }

        if (!config.routes.includes(next.name)) return navigate(user ? "dashboard" : "login", true);
        if (!user && !authRoutes.includes(next.name)) return navigate("login", true);
        if (user && authRoutes.includes(next.name)) return navigate("dashboard", true);
        if (user?.role === "reviewer" && next.name === "dashboard") return navigate("reviewer", true);
        if (user?.role !== "reviewer" && next.name === "reviewer") return navigate("dashboard", true);

        state.route = next.name;
        state.params = next.params;
        render(next.name, user);
        global.scrollTo({ top: 0, behavior: "instant" });
    }

    function render(name, user) {
        if (!user) {
            if (name === "register" && !state.onboarding.email) {
                const previous = services.auth.applicationByEmail();
                if (previous?.status === "rejected") state.onboarding = { ...freshOnboarding(), ...previous, step: 1, password: "", confirmPassword: "" };
            }
            root.innerHTML = name === "register" ? views.register(state.onboarding) : name === "pending" ? views.pending(services.auth.applicationByEmail()) : name === "forgot" ? views.forgot() : name === "reset" ? views.reset(state.params[0] || "") : views.login(state.authRole);
            bindAuthPage(name);
            focusMain();
            return;
        }

        const writeoffs = user.role === "reviewer" ? services.writeoffs.all() : services.writeoffs.list(user.id);
        const notifications = services.writeoffs.notifications(user.id);
        const unread = notifications.filter((item) => !item.read).length;
        let content = "";
        let title = "";

        switch (name) {
            case "dashboard": content = views.dashboard(user, writeoffs); title = "Главная"; break;
            case "reviewer": content = views.reviewer(services.auth.pendingApplications(), services.writeoffs.all().map((item) => ({ ...item, employeeTrust: services.auth.trustScore(item.userId) }))); title = "Центр одобрения"; break;
            case "create": content = state.submittedItem ? views.success(state.submittedItem) : views.createFlow(state.draft); title = "Новое списание"; break;
            case "history": content = views.history(writeoffs, state.historyFilter); title = "История"; break;
            case "request": content = views.detail(user.role === "reviewer" ? services.writeoffs.getAny(state.params[0]) : services.writeoffs.get(state.params[0], user.id)); title = "Детали заявки"; break;
            case "notifications": content = views.notifications(notifications); title = "Уведомления"; break;
            case "profile": content = views.profile(user, services.auth.trustScore(user.id), services.auth.achievements(user.id)); title = "Профиль"; break;
            case "pass": content = views.employeePass(user, services.auth.trustScore(user.id)); title = "B-scan Pass"; break;
            case "settings": content = views.settings(user); title = "Настройки"; break;
            case "help": content = views.help(); title = "Помощь"; break;
            case "about": content = views.about(); title = "О приложении"; break;
            default: content = views.empty("Страница не найдена", "Вернитесь на главную.", "#/dashboard"); title = "Ошибка";
        }

        root.innerHTML = views.shell(content, user, name === "request" ? "history" : name, unread, title);
        bindProtectedPage(name, user, writeoffs);
        enablePullToRefresh();
        focusMain();
    }

    function bindAuthPage(name) {
        if (name === "login") {
            document.getElementById("login-form").addEventListener("submit", handleLogin);
            document.querySelectorAll("[data-login-role]").forEach((button) => button.addEventListener("click", () => { state.authRole = button.dataset.loginRole; render("login", null); }));
        } else if (name === "register") bindOnboarding();
        else if (name === "pending") document.getElementById("refresh-approval")?.addEventListener("click", async () => {
            const application = await services.auth.refreshApplication().catch((error) => { toast(error.message, "error"); return null; });
            if (application?.status === "approved") { toast("Аккаунт одобрен. Теперь можно войти.", "success"); navigate("login"); }
            else render("pending", null);
        });
        else if (name === "forgot") document.getElementById("forgot-form").addEventListener("submit", handleForgot);
        else if (name === "reset") document.getElementById("reset-form").addEventListener("submit", handleReset);
    }

    function bindOnboarding() {
        const draft = state.onboarding;
        document.getElementById("onboarding-back")?.addEventListener("click", () => { draft.step = Math.max(1, draft.step - 1); render("register", null); });
        if (draft.step === 1) {
            const form = document.getElementById("onboarding-personal");
            const birthDate = document.getElementById("birthDate");
            birthDate.addEventListener("change", () => {
                draft.age = calculateAge(birthDate.value);
                document.getElementById("age-output").textContent = draft.age >= 0 ? `Возраст: ${draft.age}` : "Укажите корректную дату";
            });
            form.addEventListener("submit", (event) => {
                event.preventDefault();
                if (!validateForm(form)) return;
                const age = calculateAge(form.birthDate.value);
                if (age < 18 || age > 75) return setFieldError(form.birthDate, "Допустимый возрас — от 18 до 75 лет");
                if (!/^\+?[\d\s()-]{10,20}$/.test(form.phone.value)) return setFieldError(form.phone, "Проверьте номер телефона");
                if (!strongPassword(form.password.value)) return setFieldError(form.password, "Минимум 8 символов, буква и цифра");
                if (form.password.value !== form.confirmPassword.value) return setFieldError(form.confirmPassword, "Пароли не совпадают");
                Object.assign(draft, { lastName: form.lastName.value.trim(), firstName: form.firstName.value.trim(), patronymic: form.patronymic.value.trim(), birthDate: form.birthDate.value, age, phone: form.phone.value.trim(), email: form.email.value.trim().toLowerCase(), password: form.password.value, confirmPassword: form.confirmPassword.value, step: 2 });
                render("register", null);
            });
        } else if (draft.step === 2) {
            document.querySelectorAll('[name="onboardingRole"]').forEach((radio) => radio.addEventListener("change", () => {
                draft.role = radio.value;
                const secret = document.getElementById("manager-onboarding-secret");
                secret.classList.toggle("visible", radio.value === "reviewer");
                secret.querySelector("input").focus();
            }));
            document.getElementById("onboarding-next").addEventListener("click", () => {
                draft.role = document.querySelector('[name="onboardingRole"]:checked').value;
                draft.managerSecretCode = document.getElementById("managerSecretCode").value;
                if (draft.role === "reviewer" && !draft.managerSecretCode.trim()) return setFieldError(document.getElementById("managerSecretCode"), "Введите секретный код проверяющего.");
                draft.step = 3; render("register", null);
            });
        } else if (draft.step === 3) {
            document.getElementById("onboarding-next").addEventListener("click", () => { const selected = document.querySelector('[name="locationId"]:checked'); if (!selected) return toast("Выберите точку Bahandi", "error"); draft.locationId = selected.value; draft.step = 4; render("register", null); });
        } else if (draft.step === 4) {
            const input = document.getElementById("identity-input");
            document.getElementById("pick-identity").addEventListener("click", () => input.click());
            input.addEventListener("change", handleIdentityDocument);
            document.getElementById("onboarding-next")?.addEventListener("click", () => { if (!draft.idDocument) return toast("Загрузите удостоверение", "error"); draft.step = 5; render("register", null); });
        } else {
            document.getElementById("submit-onboarding").addEventListener("click", submitOnboarding);
        }
    }

    async function handleIdentityDocument(event) {
        const file = event.target.files[0]; if (!file) return;
        if (!file.type.startsWith("image/") || file.size > config.image.maxBytes) return toast("Выберите изображение до 10 МБ", "error");
        try { state.onboarding.idDocument = await compressImage(file); render("register", null); } catch { toast("Не удалось открыть документ", "error"); }
    }

    async function submitOnboarding() {
        if (!document.getElementById("onboarding-consent").checked) return toast("Подтвердите согласие на обработку данных", "error");
        const button = document.getElementById("submit-onboarding");
        try {
            const registration = { ...state.onboarding };
            await withButtonLoading(button, () => services.auth.register(registration));
            state.onboarding = freshOnboarding();
            navigate("pending");
        } catch (error) { toast(error.message, "error"); }
    }

    function calculateAge(value) {
        const birth = new Date(`${value}T00:00:00`); if (Number.isNaN(birth.getTime())) return -1;
        const today = new Date(); let age = today.getFullYear() - birth.getFullYear();
        if (today.getMonth() < birth.getMonth() || (today.getMonth() === birth.getMonth() && today.getDate() < birth.getDate())) age--;
        return age;
    }

    function bindProtectedPage(name, user, writeoffs) {
        if (name === "create" && !state.submittedItem) bindCreateStep(user);
        if (name === "reviewer") bindReviewer(user);
        if (name === "history") bindHistory(writeoffs);
        if (name === "notifications") document.getElementById("read-all")?.addEventListener("click", () => { services.writeoffs.markNotificationsRead(user.id); render("notifications", user); });
        if (name === "profile") {
            document.querySelector(".profile-form-actions")?.insertAdjacentHTML("beforebegin", `<div class="password-change"><span class="eyebrow">Безопасность</span><h3>Изменить пароль</h3><div class="form-grid"><label class="field"><span>Текущий пароль</span><input id="current-password" type="password" autocomplete="current-password"></label><label class="field"><span>Новый пароль</span><input id="new-password" type="password" autocomplete="new-password"></label></div></div>`);
            document.getElementById("profile-form")?.addEventListener("submit", handleProfileUpdate);
            document.getElementById("avatar-input")?.addEventListener("change", handleAvatarUpload);
        }
        if (name === "settings") bindSettings(user);
        if (name === "pass") renderEmployeeQr();
    }

    async function handleLogin(event) {
        event.preventDefault();
        const form = event.currentTarget;
        if (!validateForm(form)) return;
        await withButtonLoading(form.querySelector("button[type=submit]"), async () => loginWith(form.email.value, form.password.value, form.remember.checked, form.managerSecretCode?.value || ""));
    }

    async function loginWith(email, password, remember, managerSecretCode = "") {
        try {
            await services.auth.login(email, password, remember, state.authRole, managerSecretCode);
            toast("Вы вошли в B-scan", "success");
            navigate(services.auth.currentUser()?.role === "reviewer" ? "reviewer" : "dashboard");
        } catch (error) {
            if (["PENDING", "REJECTED"].includes(error.code)) navigate("pending");
            toast(error.message, "error");
        }
    }

    async function handleForgot(event) {
        event.preventDefault(); const form = event.currentTarget;
        if (!validateForm(form)) return;
        try { await services.auth.requestPasswordReset(form.email.value); toast("Если email зарегистрирован, ссылка отправлена", "success"); navigate("login"); }
        catch (error) { toast(error.message, "error"); }
    }

    async function handleReset(event) {
        event.preventDefault(); const form = event.currentTarget;
        if (!validateForm(form)) return;
        if (!strongPassword(form.password.value)) return setFieldError(form.password, "Минимум 8 символов, буква и цифра");
        if (form.password.value !== form.confirmPassword.value) return setFieldError(form.confirmPassword, "Пароли не совпадают");
        try { await services.auth.resetPassword(form.token.value, form.password.value); toast("Пароль обновлён", "success"); navigate("login"); } catch (error) { toast(error.message, "error"); }
    }

    function bindCreateStep(user) {
        if (state.draft.step === 1) {
            const input = document.getElementById("photo-input");
            document.getElementById("pick-photo").addEventListener("click", () => input.click());
            input.addEventListener("change", handlePhoto);
        } else if (state.draft.step === 2) runAnalysis();
        else if (state.draft.step === 3) {
            const form = document.getElementById("details-form");
            form.addEventListener("submit", handleDetails);
            document.getElementById("retake-photo").addEventListener("click", resetDraft);
            document.getElementById("productId").addEventListener("change", updateAiMatch);
            document.getElementById("comment").addEventListener("input", updateCommentCounter);
            document.getElementById("use-ai-comment").addEventListener("click", improveComment);
            syncDefaultUnit();
        } else {
            document.getElementById("edit-details").addEventListener("click", () => { state.draft.step = 3; render("create", user); });
            document.getElementById("submit-writeoff").addEventListener("click", () => submitWriteoff(user));
        }
    }

    async function handlePhoto(event) {
        const file = event.target.files[0]; if (!file) return;
        if (!file.type.startsWith("image/")) return toast("Выберите изображение", "error");
        if (file.size > config.image.maxBytes) return toast("Фото больше 10 МБ", "error");
        try { state.draft.photo = await compressImage(file); state.draft.step = 2; render("create", services.auth.currentUser()); } catch { toast("Не удалось обработать фото", "error"); }
    }

    async function runAnalysis() {
        try {
            const ai = await services.ai.analyze(state.draft.photo, (progress, message) => {
                const bar = document.getElementById("analysis-progress"); if (!bar) return;
                bar.style.width = `${progress}%`; document.getElementById("analysis-percent").textContent = `${progress}%`; document.getElementById("analysis-message").textContent = message;
            });
            ai.employeeTrust = services.auth.trustScore(services.auth.currentUser().id);
            ai.trustRecommendation = ai.employeeTrust >= 90 ? "Высокая уверенность на основе истории отправителя." : "Сниженная уверенность: требуется ручная проверка.";
            state.draft.ai = ai; state.draft.step = 3;
            global.setTimeout(() => render("create", services.auth.currentUser()), 300);
        } catch (error) { toast("Сервис AI временно недоступен", "error"); state.draft.step = 1; }
    }

    function handleDetails(event) {
        event.preventDefault(); const form = event.currentTarget;
        if (!validateForm(form)) return;
        const product = config.products.find((item) => item.id === form.productId.value);
        Object.assign(state.draft, { productId: product.id, productName: product.name, productIcon: product.icon, quantity: Number(form.quantity.value), unit: form.unit.value, reason: form.reason.value, type: form.querySelector('[name="type"]:checked').value, comment: form.comment.value.trim(), step: 4 });
        render("create", services.auth.currentUser());
    }

    function submitWriteoff(user, force = false) {
        const duplicate = services.writeoffs.duplicate(state.draft, user.id);
        if (duplicate && !force) return showDialog({ title: "Похожая заявка уже есть", message: `${duplicate.productName}, ${duplicate.quantity} ${duplicate.unit} была отправлена недавно. Всё равно отправить?`, confirmText: "Отправить", danger: true, onConfirm: () => submitWriteoff(user, true) });
        try {
            const payload = { ...state.draft }; delete payload.step;
            state.submittedItem = services.writeoffs.create(payload, user);
            const submittedId = state.submittedItem.id;
            global.setTimeout(() => {
                const updated = services.writeoffs.updateStatus(submittedId, user.id, "review");
                if (updated && services.auth.currentUser()?.id === user.id) {
                    toast("Проверяющий принял заявку в работу", "success");
                    if (["dashboard", "history", "request", "notifications"].includes(state.route)) render(state.route, services.auth.currentUser());
                }
            }, 8000);
            vibrate([60, 40, 90]);
            render("create", user);
        } catch (error) { toast(error.message, "error"); }
    }

    function bindHistory(items) {
        document.querySelectorAll("[data-history-filter]").forEach((button) => button.addEventListener("click", () => { state.historyFilter = button.dataset.historyFilter; render("history", services.auth.currentUser()); }));
        const search = document.getElementById("history-search");
        search.addEventListener("input", utils.debounce(() => {
            const query = search.value.trim().toLowerCase();
            document.querySelectorAll("#history-results .request-card").forEach((card) => card.hidden = !card.textContent.toLowerCase().includes(query));
        }, 100));
    }

    async function handleProfileUpdate(event) {
        event.preventDefault(); const form = event.currentTarget;
        if (!validateForm(form)) return;
        const currentPassword = document.getElementById("current-password").value;
        const newPassword = document.getElementById("new-password").value;
        if ((currentPassword || newPassword) && !strongPassword(newPassword)) return setFieldError(document.getElementById("new-password"), "Новый пароль: минимум 8 символов, буква и цифра");
        try {
            if (currentPassword || newPassword) await services.auth.changePassword(currentPassword, newPassword);
            services.auth.updateProfile({ phone: form.phone.value.trim() }); toast("Профиль обновлён", "success"); render("profile", services.auth.currentUser());
        } catch (error) { toast(error.message, "error"); }
    }

    async function handleAvatarUpload(event) {
        const file = event.target.files[0];
        if (!file) return;
        if (!file.type.startsWith("image/") || file.size > config.image.maxBytes) return toast("Выберите фото до 10 МБ", "error");
        try {
            services.auth.updateProfile({ avatar: await compressImage(file) });
            toast("Фото профиля обновлено", "success");
            render("profile", services.auth.currentUser());
        } catch { toast("Не удалось обработать фото", "error"); }
    }

    function bindSettings(user) {
        document.querySelectorAll("[data-setting]").forEach((input) => input.addEventListener("change", () => {
            const settings = { ...services.auth.currentUser().settings, [input.dataset.setting]: input.checked };
            services.auth.updateProfile({ settings }); applyTheme(); vibrate(20); toast("Настройка сохранена", "success");
        }));
        document.getElementById("logout").addEventListener("click", () => showDialog({ title: "Выйти из аккаунта?", message: "Неотправленный черновик будет потерян.", confirmText: "Выйти", danger: true, onConfirm: async () => { await services.auth.logout(); state.draft = freshDraft(); state.submittedItem = null; navigate("login"); } }));
    }

    function bindReviewer(reviewer) {
        document.querySelectorAll("[data-approve-user]").forEach((button) => button.addEventListener("click", () => {
            showDialog({ title: "Одобрить отправителя?", message: "Аккаунт будет активирован, а ID отправителя и QR Pass созданы автоматически.", confirmText: "Одобрить", onConfirm: async () => {
                try { const approved = await services.auth.approve(button.dataset.approveUser, reviewer.id); toast(`Аккаунт ${approved.employeeId} активирован`, "success"); render("reviewer", services.auth.currentUser()); } catch (error) { toast(error.message, "error"); }
            } });
        }));
        document.querySelectorAll("[data-reject-user]").forEach((button) => button.addEventListener("click", () => showRejectionDialog(button.dataset.rejectUser, reviewer.id)));
        document.querySelectorAll("[data-approve-writeoff]").forEach((button) => button.addEventListener("click", () => {
            services.writeoffs.updateStatus(button.dataset.approveWriteoff, button.dataset.owner, "approved"); toast("Списание одобрено", "success"); render("reviewer", services.auth.currentUser());
        }));
        document.querySelectorAll("[data-reject-writeoff]").forEach((button) => button.addEventListener("click", () => {
            showDialog({ title: "Отклонить списание?", message: "Отправитель увидит изменение статуса.", confirmText: "Отклонить", danger: true, onConfirm: () => { services.writeoffs.updateStatus(button.dataset.rejectWriteoff, button.dataset.owner, "rejected"); toast("Списание отклонено", "success"); render("reviewer", services.auth.currentUser()); } });
        }));
    }

    function showRejectionDialog(userId, reviewerId) {
        dialogRoot.innerHTML = `<div class="dialog-backdrop"><section class="dialog" role="dialog" aria-modal="true" aria-labelledby="reject-title"><span class="dialog-icon danger"><i class="fa-solid fa-user-xmark" aria-hidden="true"></i></span><h2 id="reject-title">Отклонить заявку</h2><p>Укажите точную причину — её увидит отправитель.</p><label class="field"><span>Причина</span><select id="rejection-reason"><option>ID фото нечитаемо</option><option>Неверные данные</option><option>Дублирующаяся регистрация</option><option>Неверная точка</option></select></label><label class="field"><span>Комментарий</span><textarea id="rejection-comment" maxlength="300" placeholder="Добавьте детали, если нужно"></textarea></label><div><button class="btn btn-ghost" id="dialog-cancel" type="button">Отмена</button><button class="btn btn-danger" id="dialog-confirm" type="button">Отклонить</button></div></section></div>`;
        const close = () => { dialogRoot.innerHTML = ""; };
        document.getElementById("dialog-cancel").addEventListener("click", close);
        document.getElementById("dialog-confirm").addEventListener("click", async () => {
            const reason = `${document.getElementById("rejection-reason").value}${document.getElementById("rejection-comment").value.trim() ? `: ${document.getElementById("rejection-comment").value.trim()}` : ""}`;
            try { await services.auth.reject(userId, reviewerId, reason); close(); toast("Заявка отклонена", "success"); render("reviewer", services.auth.currentUser()); } catch (error) { toast(error.message, "error"); }
        });
        document.getElementById("rejection-reason").focus();
    }

    function renderEmployeeQr() {
        const target = document.getElementById("employee-qr"); if (!target) return;
        if (global.QRCode) new global.QRCode(target, { text: target.dataset.qr, width: 190, height: 190, colorDark: "#10221e", colorLight: "#ffffff", correctLevel: global.QRCode.CorrectLevel.H });
        else target.textContent = target.dataset.qr;
        document.getElementById("print-pass")?.addEventListener("click", () => global.print());
    }

    function validateForm(form) {
        form.querySelectorAll("[aria-invalid]").forEach((field) => field.removeAttribute("aria-invalid"));
        if (form.checkValidity()) return true;
        const invalid = form.querySelector(":invalid"); invalid?.setAttribute("aria-invalid", "true"); invalid?.focus(); form.reportValidity(); return false;
    }

    function setFieldError(field, message) { field.setAttribute("aria-invalid", "true"); field.focus(); const error = document.querySelector(`[data-error-for="${field.id}"]`); if (error) error.textContent = message; toast(message, "error"); }
    function strongPassword(value) { return value.length >= 8 && /[A-Za-zА-Яа-я]/.test(value) && /\d/.test(value); }
    function updateCommentCounter() { const field = document.getElementById("comment"); document.getElementById("comment-counter").textContent = `${field.value.length}/500`; }
    function improveComment() { const field = document.getElementById("comment"); field.value = state.draft.ai.suggestedComment; updateCommentCounter(); toast("AI улучшил комментарий", "success"); }
    function updateAiMatch() { const result = services.ai.compare(state.draft.ai, document.getElementById("productId").value); const element = document.getElementById("ai-match"); element.className = `ai-match ${result.matches ? "" : "warning"}`; element.innerHTML = `<i class="fa-solid fa-${result.matches ? "circle-check" : "triangle-exclamation"}" aria-hidden="true"></i> ${utils.escapeHtml(result.message)}`; syncDefaultUnit(); }
    function syncDefaultUnit() { const product = config.products.find((item) => item.id === document.getElementById("productId").value); if (product) document.getElementById("unit").value = product.defaultUnit; }
    function resetDraft() { state.draft = freshDraft(); state.submittedItem = null; render("create", services.auth.currentUser()); }
    function freshDraft() { return { step: 1, photo: "", ai: null, productId: "", quantity: 1, unit: "шт", reason: "", type: "no_deduction", comment: "" }; }
    function freshOnboarding() { return { step: 1, lastName: "", firstName: "", patronymic: "", birthDate: "", age: 0, phone: "", email: "", password: "", confirmPassword: "", role: "sender", managerSecretCode: "", locationId: "", idDocument: "" }; }

    function compressImage(file) {
        return new Promise((resolve, reject) => {
            const image = new Image(); const url = URL.createObjectURL(file);
            image.onload = () => { URL.revokeObjectURL(url); const scale = Math.min(1, config.image.maxDimension / Math.max(image.naturalWidth, image.naturalHeight)); const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale)); const context = canvas.getContext("2d"); if (!context) return reject(new Error("Canvas unavailable")); context.drawImage(image, 0, 0, canvas.width, canvas.height); resolve(canvas.toDataURL("image/jpeg", config.image.quality)); };
            image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Invalid image")); }; image.src = url;
        });
    }

    function showDialog({ title, message, confirmText = "Подтвердить", danger = false, onConfirm }) {
        dialogRoot.innerHTML = `<div class="dialog-backdrop"><section class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><span class="dialog-icon ${danger ? "danger" : ""}"><i class="fa-solid fa-${danger ? "triangle-exclamation" : "circle-question"}" aria-hidden="true"></i></span><h2 id="dialog-title">${utils.escapeHtml(title)}</h2><p>${utils.escapeHtml(message)}</p><div><button class="btn btn-ghost" id="dialog-cancel" type="button">Отмена</button><button class="btn ${danger ? "btn-danger" : "btn-primary"}" id="dialog-confirm" type="button">${utils.escapeHtml(confirmText)}</button></div></section></div>`;
        const close = () => { dialogRoot.innerHTML = ""; };
        document.getElementById("dialog-cancel").addEventListener("click", close);
        document.getElementById("dialog-confirm").addEventListener("click", () => { close(); onConfirm?.(); });
        dialogRoot.querySelector(".dialog-backdrop").addEventListener("click", (event) => { if (event.target === event.currentTarget) close(); });
        document.getElementById("dialog-confirm").focus();
    }

    function toast(message, type = "info") {
        const element = document.createElement("div"); element.className = `toast ${type}`;
        const glyph = type === "error" ? "circle-exclamation" : type === "success" ? "circle-check" : "circle-info";
        element.innerHTML = `<i class="fa-solid fa-${glyph}" aria-hidden="true"></i><span>${utils.escapeHtml(message)}</span><button type="button" aria-label="Закрыть">×</button>`;
        element.querySelector("button").addEventListener("click", () => element.remove()); toastRegion.appendChild(element); global.setTimeout(() => element.remove(), 4200);
    }

    async function withButtonLoading(button, callback) { const original = button.innerHTML; button.disabled = true; button.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin" aria-hidden="true"></i> Подождите'; try { return await callback(); } finally { if (button.isConnected) { button.disabled = false; button.innerHTML = original; } } }
    function updateNetworkStatus() { networkBanner.hidden = navigator.onLine; document.body.classList.toggle("is-offline", !navigator.onLine); }
    function navigate(path, replace = false) { const hash = `#/${path}`; if (replace) location.replace(hash); else location.hash = hash; }
    function focusMain() { requestAnimationFrame(() => document.getElementById("main-content")?.focus({ preventScroll: true })); }
    function applyTheme() { const user = services.auth.currentUser(); const dark = user?.settings?.darkMode ?? matchMedia("(prefers-color-scheme: dark)").matches; document.documentElement.dataset.theme = dark ? "dark" : "light"; }
    function toggleTheme() { const user = services.auth.currentUser(); if (!user) return; services.auth.updateProfile({ settings: { ...user.settings, darkMode: !user.settings.darkMode } }); applyTheme(); }
    function vibrate(pattern) { if (services.auth.currentUser()?.settings?.haptics) navigator.vibrate?.(pattern); }

    function enablePullToRefresh() {
        const page = document.querySelector(".page"); if (!page || matchMedia("(pointer: fine)").matches) return;
        let start = 0;
        page.addEventListener("touchstart", (event) => { if (global.scrollY === 0) start = event.touches[0].clientY; }, { passive: true });
        page.addEventListener("touchend", (event) => { if (start && event.changedTouches[0].clientY - start > 90) { toast("Данные обновлены", "success"); render(state.route, services.auth.currentUser()); } start = 0; }, { passive: true });
    }
})(window);
