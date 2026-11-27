import { io } from "socket.io-client";

const configuredApi = import.meta.env.PUBLIC_API_URL?.replace(/\/+$/, "");
const isLocalPage = location.port === "4321" || ["localhost", "127.0.0.1"].includes(location.hostname);
const pointsToLocalApi = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(configuredApi || "");
const API = !isLocalPage && location.hostname.endsWith(".vercel.app")
  ? location.origin
  : configuredApi && !(pointsToLocalApi && !isLocalPage)
    ? configuredApi
    : isLocalPage ? "http://localhost:3001" : "https://gsc-clearance-queueing.onrender.com";
const page = document.body.dataset.page;
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value = "") => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
let socket;
let refreshTimer;
let countdownTimer;
let dashboardCurrent;

const ticketUrl = (id) => location.port === "4321" ? `/status/?ticket=${encodeURIComponent(id)}` : `/status/${encodeURIComponent(id)}`;

async function request(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    credentials: "include",
    ...options,
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "The request could not be completed.");
  return data;
}

function showAlert(target, message, type = "error") {
  if (!target) return;
  target.textContent = message;
  target.className = `alert show ${type}`;
}

function connectLive({ onDashboard, onQueueStatus, onPosition, onConnection } = {}) {
  if (socket) socket.disconnect();
  socket = io(API, { withCredentials: true, transports: ["websocket", "polling"] });
  if (onConnection) {
    onConnection("reconnecting");
    socket.on("connect", () => onConnection("live"));
    socket.on("disconnect", () => onConnection("reconnecting"));
    socket.on("connect_error", () => onConnection("reconnecting"));
  }
  if (onDashboard) socket.on("dashboard:update", onDashboard);
  if (onQueueStatus) socket.on("queue:status", onQueueStatus);
  if (onPosition) socket.on("student:position", onPosition);
}

function formatDate(value) {
  return new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function statusBadge(status) {
  const labels = { waiting: "Waiting", serving: "Called", completed: "Served", "no-show": "No-show", joined: "Joined", called: "Called", no_show: "No-show" };
  const safe = escapeHtml(status);
  return `<span class="admin-status" data-status="${safe}">${labels[status] || escapeHtml(status.replaceAll("_", " "))}</span>`;
}

function secondsLeft(expiresAt) {
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1000));
}

function formatCountdown(seconds) {
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

async function requireUser(roles) {
  const allowedRoles = Array.isArray(roles) ? roles : [roles];
  try {
    const { user } = await request("/api/auth/me");
    if (user.mustChangePassword && location.pathname !== "/change-password") {
      location.replace("/change-password");
      return null;
    }
    if (!allowedRoles.includes(user.role)) {
      location.replace(user.role === "admin" ? "/admin/dashboard" : "/staff/dashboard");
      return null;
    }
    document.querySelectorAll("#user-name").forEach((el) => { el.textContent = user.name; });
    const avatar = $("#admin-user-avatar");
    if (avatar) avatar.textContent = user.name.trim().charAt(0).toUpperCase() || "A";
    return user;
  } catch {
    location.replace("/");
    return null;
  }
}

async function initJoinPage() {
  const input = $("#student-id");
  const button = $("#join-button");
  const alert = $("#join-alert");
  const form = $("#join-form");
  let queueOpen = false;
  const validStudentId = (value) => {
    const digits = value.replace(/-/g, "");
    return /^\d+(?:-\d+)*$/.test(value) && digits.length >= 3 && digits.length <= 40;
  };
  const updateJoinButton = () => {
    button.disabled = !queueOpen || !validStudentId(input.value.trim());
  };
  const renderQueueStatus = (status) => {
    queueOpen = status.queueOpen;
    $("#office-status").textContent = queueOpen ? "Office open" : "Queue closed";
    $("#office-status").dataset.state = queueOpen ? "open" : "closed";
    $("#public-waiting-count").textContent = `${status.waitingCount} waiting`;
    $("#public-current-serving").textContent = `Now serving #${status.currentServing || "—"}`;
    $("#queue-closed-reason").textContent = queueOpen ? "" : "The queue is currently closed. Please ask staff for assistance.";
    $("#queue-closed-reason").hidden = queueOpen;
    updateJoinButton();
  };
  const renderQueueUnavailable = () => {
    queueOpen = false;
    $("#office-status").textContent = "Service unavailable";
    $("#office-status").dataset.state = "unavailable";
    $("#public-waiting-count").textContent = "— waiting";
    $("#public-current-serving").textContent = "Now serving #—";
    $("#queue-closed-reason").textContent = "Queue status can't be reached right now. Please try again later.";
    $("#queue-closed-reason").hidden = false;
    updateJoinButton();
  };
  const loadQueueStatus = async () => {
    try { renderQueueStatus(await request("/api/queue/public")); }
    catch { renderQueueUnavailable(); }
  };
  await loadQueueStatus();
  connectLive({ onQueueStatus: renderQueueStatus });
  const saved = localStorage.getItem("clearance-ticket");
  if (saved) {
    try {
      const { ticket } = await request(`/api/queue/${encodeURIComponent(saved)}`);
      if (ticket.status === "waiting" || ticket.status === "serving") {
        location.replace(ticketUrl(ticket.id));
        return;
      }
    } catch { localStorage.removeItem("clearance-ticket"); }
  }
  input.addEventListener("input", updateJoinButton);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!queueOpen || !validStudentId(input.value.trim())) return;
    if (!window.confirm("You're about to join the Clearance queue. Continue?")) return;
    button.disabled = true;
    button.textContent = "Joining…";
    try {
      const { ticket, existing } = await request("/api/queue/join", {
        method: "POST",
        body: JSON.stringify({ studentId: input.value.trim() }),
      });
      localStorage.setItem("clearance-ticket", ticket.id);
      if (existing) showAlert(alert, "You already have an active ticket today. Showing your existing place in line.", "success");
      location.assign(ticketUrl(ticket.id));
    } catch (error) {
      showAlert(alert, error.message);
      button.textContent = "Join Queue";
      updateJoinButton();
    }
  });
}

async function initStatusPage() {
  const pathSegments = location.pathname.split("/").filter(Boolean);
  const pathId = pathSegments.at(-1) === "status" ? "" : pathSegments.at(-1);
  const id = decodeURIComponent(pathId || new URLSearchParams(location.search).get("ticket") || "");
  $("#ticket-notify")?.addEventListener("click", enableTicketNotifications, { once: true });
  const load = async () => {
    try {
      const { ticket } = await request(`/api/queue/${encodeURIComponent(id)}`);
      const { currentServing, ahead, estimatedWaitMinutes } = await request(`/api/queue/${encodeURIComponent(id)}/position`);
      $("#ticket-loading").hidden = true;
      $("#ticket-panel").hidden = false;
      $("#ticket-number").textContent = ticket.queueNumber;
      $("#ticket-status").textContent = ticket.status.replace("-", " ");
      $("#ticket-student").textContent = ticket.studentId;
      $("#ticket-joined").textContent = formatDate(ticket.joinedAt);
      $("#ticket-current").textContent = currentServing || "—";
      $("#ticket-ahead").textContent = String(ahead);
      $("#ticket-wait").textContent = ticket.status === "serving" ? "You are being served" : ticket.status === "completed" || ticket.status === "no-show" ? "Queue finished" : estimatedWaitMinutes ? `About ${estimatedWaitMinutes} minutes` : "Up next";
      updateTicketMessage(ticket.status, ahead);
    } catch {
      $("#ticket-loading").textContent = "This ticket link is invalid or unavailable. Please return to the queue page to join.";
    }
  };
  await load();
  connectLive({ onPosition: renderStudentPosition });
  socket.emit("student:watch", { ticketId: id }, (result) => {
    if (result?.position) renderStudentPosition(result.position);
  });
  refreshTimer = window.setInterval(load, 15000);
}

function renderStudentPosition(position) {
  if ($("#ticket-ahead")) $("#ticket-ahead").textContent = String(position.ahead);
  if ($("#ticket-current")) $("#ticket-current").textContent = position.currentServing || "—";
  const status = $("#ticket-status");
  if (status && position.status) {
    status.className = "ticket-status-hidden";
    status.textContent = position.status.replace("-", " ");
  }
  updateTicketMessage(position.status, position.ahead);
}

function updateTicketMessage(status, ahead = 0) {
  const count = Math.max(0, Number(ahead) || 0);
  const titles = {
    waiting: count === 0 ? "You are next in the queue" : `You are ${count}${count === 1 ? "st" : count === 2 ? "nd" : count === 3 ? "rd" : "th"} in the queue`,
    serving: "It's your turn!",
    completed: "Your clearance is complete",
    "no-show": "Your ticket has expired",
  };
  const tags = { waiting: count <= 1 ? "Almost there!" : "You're in line", serving: "Now serving", completed: "Completed", "no-show": "Queue ended" };
  const copy = { waiting: count <= 1 ? "Please stay nearby — you're up next." : "We'll let you know when your turn is close.", serving: "Please proceed to the service desk.", completed: "Thank you. You may safely close this page.", "no-show": "Please return to the queue desk for assistance." };
  $("#ticket-message-title").textContent = titles[status] || titles.waiting;
  $("#ticket-message-tag").textContent = tags[status] || tags.waiting;
  $("#ticket-message-copy").textContent = copy[status] || copy.waiting;
  $("#ticket-next-label").textContent = count === 0 ? "Next" : `${count}${count === 1 ? "st" : count === 2 ? "nd" : count === 3 ? "rd" : "th"} Next`;
  $("#ticket-progress-fill").style.width = `${Math.max(12, Math.min(100, 100 / (count + 1)))}%`;
}

async function enableTicketNotifications() {
  const button = $("#ticket-notify");
  if (!("Notification" in window)) { button.textContent = "Notifications unavailable"; return; }
  const permission = await Notification.requestPermission();
  button.textContent = permission === "granted" ? "Notifications enabled" : "Notifications blocked";
}

async function initLoginPage() {
  const form = $("#login-form");
  const password = form.elements.password;
  const togglePassword = $("#toggle-password");
  togglePassword?.addEventListener("click", () => {
    const showing = password.type === "password";
    password.type = showing ? "text" : "password";
    togglePassword.textContent = showing ? "Hide" : "Show";
    togglePassword.setAttribute("aria-pressed", String(showing));
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const { user } = await request("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          identity: form.elements.identity.value.trim(),
          password: form.elements.password.value,
        }),
      });
      location.assign(user.mustChangePassword ? "/change-password" : user.role === "admin" ? "/admin/dashboard" : "/staff/dashboard");
    } catch (error) {
      showAlert($("#login-alert"), error.message);
      button.disabled = false;
    }
  });
}

async function initChangePasswordPage() {
  let user;
  try {
    ({ user } = await request("/api/auth/me"));
  } catch {
    location.replace("/");
    return;
  }
  const form = $("#password-change-form");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    if (values.newPassword !== values.confirmPassword) {
      showAlert($("#password-change-alert"), "The new passwords do not match.");
      return;
    }
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      await request("/api/auth/password/change", {
        method: "POST",
        body: JSON.stringify({ currentPassword: values.currentPassword, newPassword: values.newPassword }),
      });
      location.assign(user.role === "admin" ? "/admin/dashboard" : "/staff/dashboard");
    } catch (error) {
      showAlert($("#password-change-alert"), error.message);
      button.disabled = false;
    }
  });
}

async function initAccountPage() {
  const user = await requireUser(["admin", "staff"]);
  if (!user) return;
  $("#account-name").textContent = `${user.name} · ${user.role === "admin" ? "Administrator" : "Staff"}`;
  $("#account-email").value = user.email;
  $("#account-back-link").href = user.role === "admin" ? "/admin/dashboard" : "/staff/dashboard";

  $("#account-email-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const { user: updatedUser } = await request("/api/auth/account/email", {
        method: "PATCH",
        body: JSON.stringify({ email: form.elements.email.value.trim(), currentPassword: form.elements.currentPassword.value }),
      });
      $("#account-email").value = updatedUser.email;
      form.elements.currentPassword.value = "";
      showAlert($("#account-email-alert"), "Email updated.", "success");
    } catch (error) {
      showAlert($("#account-email-alert"), error.message);
    } finally { button.disabled = false; }
  });

  $("#account-password-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    if (values.newPassword !== values.confirmPassword) {
      showAlert($("#account-password-alert"), "The new passwords do not match.");
      return;
    }
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      await request("/api/auth/password/change", {
        method: "POST",
        body: JSON.stringify({ currentPassword: values.currentPassword, newPassword: values.newPassword }),
      });
      form.reset();
      showAlert($("#account-password-alert"), "Password updated. Other signed-in sessions have been ended.", "success");
    } catch (error) {
      showAlert($("#account-password-alert"), error.message);
    } finally { button.disabled = false; }
  });
}

async function initForgotPasswordPage() {
  const requestForm = $("#reset-request-form");
  const resetForm = $("#reset-password-form");
  const alert = $("#forgot-password-alert");
  requestForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = requestForm.querySelector('button[type="submit"]');
    const email = requestForm.elements.email.value.trim();
    button.disabled = true;
    try {
      const { message } = await request("/api/auth/password/reset/request", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      $("#reset-email").value = email;
      resetForm.hidden = false;
      showAlert(alert, message || "If an active account uses that email, a reset code will arrive shortly.", "success");
      $("#reset-otp").focus();
    } catch (error) {
      showAlert(alert, error.message);
    } finally { button.disabled = false; }
  });

  resetForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(resetForm));
    if (values.newPassword !== values.confirmPassword) {
      showAlert(alert, "The new passwords do not match.");
      return;
    }
    const button = resetForm.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      await request("/api/auth/password/reset", {
        method: "POST",
        body: JSON.stringify({ email: values.email, otp: values.otp, newPassword: values.newPassword }),
      });
      requestForm.hidden = true;
      resetForm.hidden = true;
      showAlert(alert, "Password reset. You can now sign in with your new password.", "success");
    } catch (error) {
      showAlert(alert, error.message);
    } finally { button.disabled = false; }
  });
}

async function loadDashboard(role) {
  const data = await request("/api/queue/dashboard");
  const timerInput = $("#call-duration");
  if (timerInput && timerInput.dataset.initialized !== "true") {
    timerInput.value = data.noShowDuration;
    timerInput.dataset.initialized = "true";
  }
  $("#waiting-count").textContent = data.stats.waiting;
  $("#completed-count").textContent = data.stats.completed;
  $("#noshow-count").textContent = data.stats.noShow;
  $("#today-label").textContent = new Date().toLocaleDateString([], { dateStyle: "full" });
  const current = data.current;
  dashboardCurrent = current;
  if (role === "admin") renderAdminQueue(current, data.waiting);
  else {
    const tbody = $("#waiting-table");
    tbody.innerHTML = data.waiting.map((ticket, index) => `<tr><td><strong>${escapeHtml(ticket.queueNumber)}</strong></td><td>${escapeHtml(ticket.studentId)}</td><td>${escapeHtml(formatDate(ticket.joinedAt))}</td><td>${index + 1}</td></tr>`).join("");
    $("#waiting-empty").hidden = data.waiting.length !== 0;
  }
  const number = current?.queueNumber || "—";
  const currentStudent = current ? `Student ID ${current.studentId}` : "No student is currently being served";
  if ($("#current-number")) $("#current-number").textContent = number;
  if ($("#current-student")) $("#current-student").textContent = currentStudent;
  const next = data.waiting[0];
  if ($("#next-number")) $("#next-number").textContent = next?.queueNumber || "—";
  if ($("#next-card-number")) $("#next-card-number").textContent = next?.queueNumber || "—";
  if ($("#next-card-student")) $("#next-card-student").textContent = next ? `Student ID ${next.studentId}` : "No students waiting";
  updateCountdown();
  if ($("#complete-button")) $("#complete-button").disabled = !current;
  if ($("#no-show-button")) $("#no-show-button").disabled = !current;
  if ($("#call-next")) $("#call-next").disabled = Boolean(current) || !next;
}

function renderAdminQueue(current, waiting) {
  const tbody = $("#waiting-table");
  const tickets = [...(current ? [{ ...current, status: "serving" }] : []), ...waiting];
  const existing = new Map([...tbody.querySelectorAll("tr[data-ticket-id]")].map((row) => [row.dataset.ticketId, row]));
  [...tbody.children].filter((row) => !row.dataset.ticketId).forEach((row) => row.remove());
  const retained = new Set();
  let cursor = tbody.firstElementChild;
  for (const ticket of tickets) {
    const key = String(ticket.id);
    let row = existing.get(key);
    if (!row) {
      row = document.createElement("tr");
      row.dataset.ticketId = key;
      row.classList.add("admin-row-new");
      row.addEventListener("animationend", () => row.classList.remove("admin-row-new"), { once: true });
    }
    const signature = `${ticket.queueNumber}|${ticket.studentId}|${ticket.joinedAt}|${ticket.status}`;
    if (row.dataset.renderKey !== signature) {
      row.innerHTML = `<td class="numeric"><strong>${escapeHtml(ticket.queueNumber)}</strong></td><td class="numeric">${escapeHtml(ticket.studentId)}</td><td>${escapeHtml(formatDate(ticket.joinedAt))}</td><td>${statusBadge(ticket.status)}</td>`;
      row.dataset.renderKey = signature;
    }
    retained.add(key);
    if (row !== cursor) tbody.insertBefore(row, cursor);
    cursor = row.nextElementSibling;
  }
  existing.forEach((row, key) => { if (!retained.has(key)) row.remove(); });
  $("#waiting-empty").hidden = tickets.length !== 0;
}

function setAdminConnection(state) {
  const indicator = $("#admin-live");
  if (!indicator) return;
  const label = $("#admin-live-label");
  indicator.dataset.state = state;
  label.textContent = state === "live" ? "Live" : state === "offline" ? "Offline" : "Reconnecting";
}

function connectAdminStatus() {
  connectLive({ onConnection: setAdminConnection });
}

async function initDashboard(role) {
  const user = await requireUser(role === "admin" ? "admin" : ["staff", "admin"]);
  if (!user) return;
  const load = () => loadDashboard(role).catch((error) => showAlert($("#page-alert"), error.message));
  await load();
  connectLive({ onDashboard: load, onConnection: setAdminConnection });
  refreshTimer = window.setInterval(load, 5000);
  countdownTimer = window.setInterval(updateCountdown, 1000);
  $("#logout").addEventListener("click", async () => {
    await request("/api/auth/logout", { method: "POST" });
    location.assign("/");
  });
  if (role === "staff") {
    $("#call-next").addEventListener("click", async () => {
      try { await request("/api/queue/next", { method: "POST" }); await load(); }
      catch (error) { showAlert($("#page-alert"), error.message); }
    });
    $("#complete-button").addEventListener("click", () => mutateCurrent("complete", load));
    $("#no-show-button").addEventListener("click", () => mutateCurrent("no-show", load));
    $("#timer-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        const { noShowDuration } = await request("/api/queue/timer", { method: "POST", body: JSON.stringify({ noShowDuration: Number($("#call-duration").value) }) });
        $("#call-duration").value = noShowDuration;
        showAlert($("#page-alert"), "The call timer has been updated.", "success");
      } catch (error) { showAlert($("#page-alert"), error.message); }
    });
  }
}

function updateCountdown() {
  if ($("#countdown")) $("#countdown").textContent = dashboardCurrent?.callExpiresAt
    ? formatCountdown(secondsLeft(dashboardCurrent.callExpiresAt))
    : "--:--";
}

async function mutateCurrent(action, load) {
  try {
    const data = await request("/api/queue/current");
    if (data.ticket) await request(`/api/queue/${encodeURIComponent(data.ticket.id)}/${action}`, { method: "POST" });
    await load();
  } catch (error) { showAlert($("#page-alert"), error.message); }
}

async function initStaffPage() {
  const user = await requireUser("admin");
  if (!user) return;
  connectAdminStatus();
  const list = async () => {
    const { staff } = await request("/api/admin/staff");
    $("#staff-list").innerHTML = staff.length ? staff.map((person) => `<tr><td><strong>${escapeHtml(person.name)}</strong></td><td>${escapeHtml(person.email)}</td><td>${escapeHtml(person.username)}</td><td>${person.isActive ? '<span class="admin-status" data-status="completed">Active</span>' : '<span class="admin-status">Inactive</span>'}${person.mustChangePassword ? '<div class="admin-helper">Temporary password pending</div>' : ""}</td><td class="admin-menu-cell"><details class="admin-row-menu"><summary aria-label="Actions for ${escapeHtml(person.name)}">···</summary><div><button class="admin-button" type="button" data-reset-staff-id="${escapeHtml(person.id)}">Set temporary password</button><button class="admin-button ${person.isActive ? "admin-button-danger" : ""}" type="button" data-staff-id="${escapeHtml(person.id)}" data-active="${person.isActive}">${person.isActive ? "Deactivate" : "Activate"}</button></div></details></td></tr>`).join("") : '<tr><td colspan="5" class="admin-empty">No staff accounts have been added.</td></tr>';
  };
  await list();
  $("#logout").addEventListener("click", async () => { await request("/api/auth/logout", { method: "POST" }); location.assign("/"); });
  $("#staff-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector("button");
    button.disabled = true;
    try {
      await request("/api/admin/staff", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form))) });
      form.reset();
      showAlert($("#page-alert"), "Staff account created.", "success");
      await list();
    } catch (error) { showAlert($("#page-alert"), error.message); }
    finally { button.disabled = false; }
  });
  $("#staff-list").addEventListener("click", async (event) => {
    const resetButton = event.target.closest("[data-reset-staff-id]");
    if (resetButton) {
      const temporaryPassword = prompt("Enter a temporary password with at least 12 characters. The staff member must change it at next sign-in:");
      if (!temporaryPassword) return;
      try {
        await request(`/api/admin/staff/${encodeURIComponent(resetButton.dataset.resetStaffId)}`, {
          method: "PATCH",
          body: JSON.stringify({ temporaryPassword }),
        });
        showAlert($("#page-alert"), "Temporary password set. Share it privately with the staff member.", "success");
        await list();
      } catch (error) { showAlert($("#page-alert"), error.message); }
      return;
    }
    const button = event.target.closest("[data-staff-id]");
    if (!button) return;
    try {
      await request(`/api/admin/staff/${encodeURIComponent(button.dataset.staffId)}`, { method: "PATCH", body: JSON.stringify({ isActive: button.dataset.active !== "true" }) });
      await list();
    } catch (error) { showAlert($("#page-alert"), error.message); }
  });
}

async function initSettingsPage() {
  const user = await requireUser("admin");
  if (!user) return;
  connectAdminStatus();
  $("#logout").addEventListener("click", async () => { await request("/api/auth/logout", { method: "POST" }); location.assign("/"); });
  const { settings } = await request("/api/admin/settings");
  $("#duration").value = settings.noShowDuration;
  $("#queue-status").value = settings.systemStatus;
  $("#system-status").textContent = settings.systemStatus;
  $("#system-status").dataset.status = settings.systemStatus;
  $("#settings-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const { settings: saved } = await request("/api/admin/settings", { method: "PUT", body: JSON.stringify({ noShowDuration: Number($("#duration").value), systemStatus: $("#queue-status").value }) });
      $("#duration").value = saved.noShowDuration;
      $("#queue-status").value = saved.systemStatus;
      $("#system-status").textContent = saved.systemStatus;
      $("#system-status").dataset.status = saved.systemStatus;
      showAlert($("#page-alert"), "Queue settings saved.", "success");
    } catch (error) { showAlert($("#page-alert"), error.message); }
  });
  $("#reset-queue").addEventListener("click", async () => {
    if (!confirm("Reset today's queue? Active tickets will be marked No Show.")) return;
    try { await request("/api/admin/queue/reset", { method: "POST" }); showAlert($("#page-alert"), "Today's queue has been reset.", "success"); }
    catch (error) { showAlert($("#page-alert"), error.message); }
  });
}

async function initHistoryPage() {
  const roles = page === "staff-history" ? ["staff", "admin"] : "admin";
  const user = await requireUser(roles);
  if (!user) return;
  connectAdminStatus();
  $("#logout").addEventListener("click", async () => { await request("/api/auth/logout", { method: "POST" }); location.assign("/"); });
  const date = $("#history-date");
  const search = page === "admin-history" ? $("#history-search") : null;
  const tbody = $("#history-table");
  let records = [];
  let currentPage = 0;
  const pageSize = 20;
  const render = () => {
    const query = search?.value.trim().toLowerCase() || "";
    const filtered = records.filter((row) => !query || `${row.queueNumber} ${row.studentId} ${row.action} ${row.performedBy || ""}`.toLowerCase().includes(query));
    const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
    currentPage = Math.min(currentPage, pageCount - 1);
    const visible = filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
    tbody.innerHTML = visible.map((row) => `<tr><td><strong>${escapeHtml(row.queueNumber)}</strong></td><td class="numeric">${escapeHtml(row.studentId)}</td><td>${page === "admin-history" ? statusBadge(row.action) : escapeHtml(row.action.replaceAll("_", " "))}</td><td>${escapeHtml(row.performedBy || "System")}</td><td>${escapeHtml(formatDate(row.timestamp))}</td></tr>`).join("");
    $("#history-empty").hidden = filtered.length !== 0;
    if (page === "admin-history") {
      $("#history-page-label").textContent = filtered.length ? `${currentPage * pageSize + 1}–${Math.min((currentPage + 1) * pageSize, filtered.length)} of ${filtered.length}` : "0 records";
      $("#history-prev").disabled = currentPage === 0;
      $("#history-next").disabled = currentPage >= pageCount - 1;
    }
  };
  date.value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const load = async () => {
    try {
      const { history } = await request(`/api/admin/history?date=${encodeURIComponent(date.value)}`);
      records = history;
      currentPage = 0;
      render();
    } catch (error) { showAlert($("#page-alert"), error.message); }
  };
  date.addEventListener("change", load);
  search?.addEventListener("input", () => { currentPage = 0; render(); });
  $("#history-prev")?.addEventListener("click", () => { currentPage -= 1; render(); });
  $("#history-next")?.addEventListener("click", () => { currentPage += 1; render(); });
  await load();
}

async function initQrPage() {
  const user = await requireUser("admin");
  if (!user) return;
  connectAdminStatus();
  $("#logout").addEventListener("click", async () => { await request("/api/auth/logout", { method: "POST" }); location.assign("/"); });
  $("#print-qr").addEventListener("click", () => window.print());
  try {
    const { url, dataUrl } = await request("/api/qr");
    $("#qr-loading").hidden = true;
    $("#qr-image").src = dataUrl;
    $("#qr-image").hidden = false;
    $("#qr-link").href = url;
    $("#qr-link").textContent = url;
  } catch (error) { $("#qr-loading").textContent = error.message; }
}

const handlers = {
  "student-join": initJoinPage,
  login: initLoginPage,
  account: initAccountPage,
  "change-password": initChangePasswordPage,
  "forgot-password": initForgotPasswordPage,
  "staff-dashboard": () => initDashboard("staff"),
  "admin-dashboard": () => initDashboard("admin"),
  "admin-staff": initStaffPage,
  "admin-settings": initSettingsPage,
  "admin-history": initHistoryPage,
  "staff-history": initHistoryPage,
  "student-status": initStatusPage,
  "admin-qr": initQrPage,
};

document.querySelectorAll(".sidebar-toggle").forEach((button) => {
  button.addEventListener("click", () => {
    const sidebar = button.closest(".sidebar");
    const expanded = sidebar.classList.toggle("sidebar-open");
    button.setAttribute("aria-expanded", String(expanded));
    button.setAttribute("aria-label", expanded ? "Close navigation" : "Open navigation");
  });
});

const adminSidebar = $("#admin-sidebar");
const adminMenuToggle = $("#admin-menu-toggle");
adminMenuToggle?.addEventListener("click", () => {
  const expanded = adminSidebar.classList.toggle("admin-sidebar-open");
  adminMenuToggle.setAttribute("aria-expanded", String(expanded));
  adminMenuToggle.setAttribute("aria-label", expanded ? "Close navigation" : "Open navigation");
});

const adminUserToggle = $("#admin-user-toggle");
const adminUserMenu = $("#admin-user-menu");
adminUserToggle?.addEventListener("click", () => {
  const expanded = adminUserToggle.getAttribute("aria-expanded") !== "true";
  adminUserToggle.setAttribute("aria-expanded", String(expanded));
  adminUserMenu.hidden = !expanded;
});
document.addEventListener("click", (event) => {
  if (adminUserToggle && !event.target.closest(".admin-user-wrap")) {
    adminUserToggle.setAttribute("aria-expanded", "false");
    adminUserMenu.hidden = true;
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && adminUserMenu && !adminUserMenu.hidden) {
    adminUserMenu.hidden = true;
    adminUserToggle.setAttribute("aria-expanded", "false");
    adminUserToggle.focus();
  }
});

if (page === "" && $("#join-form")) initJoinPage();
else if (handlers[page]) handlers[page]();

window.addEventListener("pagehide", () => {
  if (refreshTimer) clearInterval(refreshTimer);
  if (countdownTimer) clearInterval(countdownTimer);
  if (socket) socket.disconnect();
});
