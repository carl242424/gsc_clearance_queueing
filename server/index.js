import "dotenv/config";
import express from "express";
import session from "express-session";
import MongoStore from "connect-mongo";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { Server } from "socket.io";
import QRCode from "qrcode";
import { z } from "zod";
import { setServers } from "node:dns";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  QueueCounter,
  QueueHistory,
  QueueSettings,
  QueueTicket,
  User,
} from "./models.js";

const port = Number(process.env.PORT || 3001);
const mongoUri = process.env.MONGODB_URI;
const sessionSecret = process.env.SESSION_SECRET;
const publicAppUrl = (process.env.PUBLIC_APP_URL || "http://localhost:4321").replace(/\/+$/, "");
const publicApiOrigin = new URL(process.env.PUBLIC_API_URL || publicAppUrl).origin;
const queueTimeZone = process.env.QUEUE_TIME_ZONE || "Asia/Manila";
const isProduction = process.env.NODE_ENV === "production";

if (!mongoUri || !sessionSecret || sessionSecret.length < 32) {
  throw new Error("MONGODB_URI and a SESSION_SECRET of at least 32 characters are required.");
}

const mongoDnsServers = process.env.MONGODB_DNS_SERVERS?.split(",").map((server) => server.trim()).filter(Boolean);
if (mongoDnsServers?.length) setServers(mongoDnsServers);

await mongoose.connect(mongoUri);
await Promise.all([
  User.init(),
  QueueTicket.init(),
  QueueHistory.init(),
  QueueSettings.init(),
  QueueCounter.init(),
]);
await QueueSettings.findByIdAndUpdate("global", { $setOnInsert: {
  noShowDuration: Number(process.env.NO_SHOW_DURATION || 180),
  dailyQueueReset: true,
  systemStatus: "active",
  updatedAt: new Date(),
} }, { upsert: true, new: true, setDefaultsOnInsert: true });

const app = express();
const httpServer = (await import("node:http")).createServer(app);
const io = new Server(httpServer, {
  cors: { origin: publicAppUrl, credentials: true },
});
const sessionMiddleware = session({
  name: "clearance.sid",
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: mongoUri, collectionName: "sessions", ttl: 60 * 60 * 8 }),
  cookie: {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    maxAge: 1000 * 60 * 60 * 8,
  },
});

app.set("trust proxy", isProduction ? 1 : false);
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: { directives: { connectSrc: ["'self'", publicApiOrigin] } },
}));
app.use((req, res, next) => {
  const origin = req.get("origin");
  if (origin === publicAppUrl) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.sendStatus(204);
  }
  next();
});
app.use(express.json({ limit: "20kb" }));
app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);
io.use(async (socket, next) => {
  try {
    const sessionUser = socket.request.session?.user;
    if (!sessionUser) {
      socket.data.role = "student";
      return next();
    }
    const user = await ensureActive(sessionUser.id);
    if (!user || !["staff", "admin"].includes(user.role)) return next(new Error("Session is no longer active."));
    socket.data.user = { id: String(user._id), name: user.name, role: user.role };
    socket.data.role = user.role;
    return next();
  } catch (error) {
    return next(error);
  }
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many sign-in attempts. Try again in 15 minutes." },
});
const joinLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 12,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many queue requests. Please wait before trying again." },
});
const idSchema = z.uuid();
const studentSchema = z.object({
  studentId: z.string().trim().min(3).max(48)
    .regex(/^\d+(?:-\d+)*$/)
    .refine((value) => value.replace(/-/g, "").length <= 40),
});
const loginSchema = z.object({
  identity: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(200),
});

function dayKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: queueTimeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const part = (type) => parts.find((value) => value.type === type).value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function fail(res, status, message) {
  return res.status(status).json({ error: message });
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user) {
      if (req.path.startsWith("/api/")) return fail(res, 401, "Please sign in to continue.");
      return res.redirect("/login");
    }
    ensureActive(req.session.user.id).then((user) => {
      if (!user) {
        req.session.destroy(() => {});
        if (req.path.startsWith("/api/")) return fail(res, 401, "This account is inactive.");
        return res.redirect("/login");
      }
      if (!roles.includes(user.role)) return fail(res, 403, "You do not have permission to view this page.");
      req.session.user.role = user.role;
      req.session.user.name = user.name;
      next();
    }).catch(next);
  };
}

async function ensureActive(userId) {
  return User.findOne({ _id: userId, isActive: true }).select("name email username role isActive").lean();
}

function userView(user) {
  return { id: String(user._id), name: user.name, email: user.email, username: user.username, role: user.role, isActive: user.isActive };
}

async function record(ticket, action, actor) {
  await QueueHistory.create({
    ticketId: ticket._id,
    studentId: ticket.studentId,
    queueNumber: ticket.queueNumber,
    queueDate: ticket.queueDate,
    action,
    performedBy: actor || "System",
  });
}

function publishQueueUpdate(changedTicket = null) {
  void (async () => {
    const queueDate = dayKey();
    const [waiting, current, completed, noShow, settings] = await Promise.all([
      QueueTicket.find({ queueDate, status: "waiting" }).sort({ queueSequence: 1 }).lean(),
      QueueTicket.findOne({ queueDate, status: "serving" }).lean(),
      QueueTicket.countDocuments({ queueDate, status: "completed" }),
      QueueTicket.countDocuments({ queueDate, status: "no-show" }),
      QueueSettings.findById("global").lean(),
    ]);
    io.to("staff-room").emit("dashboard:update", {
      waiting: waiting.map(publicTicket),
      current: current ? publicTicket(current) : null,
      stats: { waiting: waiting.length, completed, noShow },
      noShowDuration: settings.noShowDuration,
      updatedAt: Date.now(),
    });

    const studentStatus = {
      queueOpen: settings.systemStatus === "active",
      waitingCount: waiting.length,
      currentServing: current?.queueNumber || null,
    };
    io.to("student-room").emit("queue:status", studentStatus);
    if (changedTicket && !["waiting", "serving"].includes(changedTicket.status)) {
      io.to(`ticket:${changedTicket._id}`).emit("student:position", {
        queueNumber: changedTicket.queueNumber,
        status: changedTicket.status,
        ahead: 0,
        currentServing: current?.queueNumber || null,
      });
    }

    const allActive = [...waiting, ...(current ? [current] : [])];
    for (const ticket of allActive) {
      const ahead = ticket.status === "waiting"
        ? waiting.filter((candidate) => candidate.queueSequence < ticket.queueSequence).length + (current ? 1 : 0)
        : 0;
      io.to(`ticket:${ticket._id}`).emit("student:position", {
        queueNumber: ticket.queueNumber,
        status: ticket.status,
        ahead,
        currentServing: current?.queueNumber || null,
      });
    }
  })().catch((error) => console.error("Could not publish queue updates:", error));
}

async function expireCalls() {
  const now = new Date();
  const expired = await QueueTicket.find({
    status: "serving",
    callExpiresAt: { $lte: now },
  }).lean();
  for (const candidate of expired) {
    const changed = await QueueTicket.findOneAndUpdate(
      { _id: candidate._id, status: "serving", callExpiresAt: { $lte: now } },
      { $set: { status: "no-show", noShowAt: now }, $unset: { callExpiresAt: 1 } },
      { new: true },
    );
    if (changed) {
      await record(changed, "no_show", "System");
      publishQueueUpdate(changed);
    }
  }
}

const expiryTimer = setInterval(() => {
  expireCalls().catch((error) => console.error("Could not process expired queue calls:", error));
}, 1000);
expiryTimer.unref();

app.get("/api/health", (_req, res) => res.json({ status: "ok", database: mongoose.connection.readyState === 1 }));

app.post("/api/auth/login", loginLimiter, asyncRoute(async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "Enter a valid username/email and password.");
  const identity = parsed.data.identity.toLowerCase();
  const user = await User.findOne({ $or: [{ email: identity }, { username: identity }] }).select("+passwordHash");
  if (!user || !user.isActive || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) {
    return fail(res, 401, "Invalid sign-in details or account is inactive.");
  }
  await new Promise((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
  req.session.user = { id: String(user._id), role: user.role, name: user.name };
  await new Promise((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
  res.json({ user: userView(user) });
}));

app.get("/api/auth/me", asyncRoute(async (req, res) => {
  if (!req.session.user) return fail(res, 401, "Please sign in to continue.");
  const user = await ensureActive(req.session.user.id);
  if (!user) {
    req.session.destroy(() => {});
    return fail(res, 401, "This account is inactive.");
  }
  res.json({ user: userView(user) });
}));

app.post("/api/auth/logout", (req, res, next) => {
  req.session.destroy((error) => {
    if (error) return next(error);
    res.clearCookie("clearance.sid", { httpOnly: true, secure: isProduction, sameSite: "lax" });
    res.json({ success: true });
  });
});

app.get("/api/qr", asyncRoute(async (_req, res) => {
  const url = `${publicAppUrl}/join`;
  res.json({ url, dataUrl: await QRCode.toDataURL(url, { errorCorrectionLevel: "H", margin: 2, width: 600 }) });
}));

async function publicQueueStatus() {
  const queueDate = dayKey();
  const [waitingCount, current, settings] = await Promise.all([
    QueueTicket.countDocuments({ queueDate, status: "waiting" }),
    QueueTicket.findOne({ queueDate, status: "serving" }).select("queueNumber").lean(),
    QueueSettings.findById("global").select("systemStatus").lean(),
  ]);
  return {
    queueOpen: settings.systemStatus === "active",
    waitingCount,
    currentServing: current?.queueNumber || null,
  };
}

app.get("/api/queue/public", asyncRoute(async (_req, res) => {
  res.json(await publicQueueStatus());
}));

app.post("/api/queue/join", joinLimiter, asyncRoute(async (req, res) => {
  const parsed = studentSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "Enter a valid numeric Student ID Number.");
  const settings = await QueueSettings.findById("global").lean();
  if (settings.systemStatus !== "active") return fail(res, 503, "The clearance queue is temporarily paused.");
  await expireCalls();
  const studentId = parsed.data.studentId.replace(/-/g, "");
  const queueDate = dayKey();
  const existing = await QueueTicket.findOne({
    studentId, queueDate, status: { $in: ["waiting", "serving"] },
  }).lean();
  if (existing) return res.json({ ticket: publicTicket(existing), existing: true });

  let counter;
  try {
    counter = await QueueCounter.findOneAndUpdate(
      { _id: queueDate },
      { $inc: { sequence: 1 } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
  } catch (error) {
    if (error.code !== 11000) throw error;
    counter = await QueueCounter.findOneAndUpdate({ _id: queueDate }, { $inc: { sequence: 1 } }, { new: true });
  }
  const queueNumber = `Q${String(counter.sequence).padStart(3, "0")}`;
  let ticket;
  try {
    ticket = await QueueTicket.create({ studentId, queueNumber, queueSequence: counter.sequence, queueDate, status: "waiting" });
  } catch (error) {
    if (error.code === 11000) {
      const current = await QueueTicket.findOne({ studentId, queueDate, status: { $in: ["waiting", "serving"] } }).lean();
      if (current) return res.json({ ticket: publicTicket(current), existing: true });
      return fail(res, 409, "The queue changed while joining. Please try again.");
    }
    throw error;
  }
  await record(ticket, "joined", "Student");
  publishQueueUpdate();
  res.status(201).json({ ticket: publicTicket(ticket), existing: false });
}));

function publicTicket(ticket) {
  return {
    id: String(ticket._id),
    studentId: ticket.studentId,
    queueNumber: ticket.queueNumber,
    queueDate: ticket.queueDate,
    status: ticket.status,
    joinedAt: ticket.joinedAt,
    calledAt: ticket.calledAt || null,
    completedAt: ticket.completedAt || null,
    noShowAt: ticket.noShowAt || null,
    callExpiresAt: ticket.callExpiresAt || null,
  };
}

async function ticketPosition(ticket) {
  const queueDate = ticket.queueDate;
  const [current, waitingAhead] = await Promise.all([
    QueueTicket.findOne({ queueDate, status: "serving" }).select("queueNumber").lean(),
    ticket.status === "waiting"
      ? QueueTicket.countDocuments({
        queueDate,
        status: "waiting",
        queueSequence: { $lt: ticket.queueSequence },
      })
      : 0,
  ]);
  const ahead = ticket.status === "waiting" ? waitingAhead + (current ? 1 : 0) : 0;
  return {
    queueNumber: ticket.queueNumber,
    status: ticket.status,
    currentServing: current?.queueNumber || null,
    ahead,
    estimatedWaitMinutes: ticket.status === "serving" ? 0 : ahead * 5,
  };
}

io.on("connection", (socket) => {
  const isStaff = ["staff", "admin"].includes(socket.data.role);
  if (isStaff) socket.join("staff-room");
  else socket.join("student-room");
  if (isStaff) publishQueueUpdate();

  if (!isStaff) {
    publicQueueStatus().then((status) => socket.emit("queue:status", status))
      .catch((error) => console.error("Could not send initial student queue status:", error));

    socket.on("student:watch", async ({ ticketId } = {}, acknowledge) => {
      try {
        if (!idSchema.safeParse(ticketId).success) throw new Error("Invalid ticket.");
        const ticket = await QueueTicket.findById(ticketId).lean();
        if (!ticket) throw new Error("Ticket not found.");
        const room = `ticket:${ticket._id}`;
        socket.join(room);
        const position = await ticketPosition(ticket);
        if (typeof acknowledge === "function") acknowledge({ position });
        socket.emit("student:position", position);
      } catch (error) {
        if (typeof acknowledge === "function") acknowledge({ error: error.message });
      }
    });
  }

  const rejectNonStaff = (acknowledge) => {
    if (socket.rooms.has("staff-room")) return false;
    if (typeof acknowledge === "function") acknowledge({ error: "Unauthorized." });
    return true;
  };

  socket.on("queue:call-next", async (_payload, acknowledge) => {
    if (rejectNonStaff(acknowledge)) return;
    try {
      const ticket = await callNextTicket(socket.data.user.name);
      if (typeof acknowledge === "function") acknowledge({ ticket });
    } catch (error) {
      if (typeof acknowledge === "function") acknowledge({ error: error.message });
    }
  });
  socket.on("queue:complete", async ({ ticketId } = {}, acknowledge) => {
    if (rejectNonStaff(acknowledge)) return;
    try {
      const ticket = await finishTicketById(ticketId, "completed", socket.data.user.name);
      if (typeof acknowledge === "function") acknowledge({ ticket });
    } catch (error) {
      if (typeof acknowledge === "function") acknowledge({ error: error.message });
    }
  });
  socket.on("queue:no-show", async ({ ticketId } = {}, acknowledge) => {
    if (rejectNonStaff(acknowledge)) return;
    try {
      const ticket = await finishTicketById(ticketId, "no-show", socket.data.user.name);
      if (typeof acknowledge === "function") acknowledge({ ticket });
    } catch (error) {
      if (typeof acknowledge === "function") acknowledge({ error: error.message });
    }
  });
  socket.on("queue:set-timer", async ({ noShowDuration } = {}, acknowledge) => {
    if (rejectNonStaff(acknowledge)) return;
    try {
      const settings = await setNoShowDuration(noShowDuration);
      if (typeof acknowledge === "function") acknowledge({ noShowDuration: settings.noShowDuration });
    } catch (error) {
      if (typeof acknowledge === "function") acknowledge({ error: error.message });
    }
  });
});

app.get("/api/queue/:id/position", asyncRoute(async (req, res) => {
  if (!idSchema.safeParse(req.params.id).success) return fail(res, 404, "Ticket not found.");
  await expireCalls();
  const ticket = await QueueTicket.findById(req.params.id).lean();
  if (!ticket) return fail(res, 404, "Ticket not found.");
  res.json(await ticketPosition(ticket));
}));

app.get("/api/queue/current", requireRole("staff", "admin"), asyncRoute(async (_req, res) => {
  await expireCalls();
  const ticket = await QueueTicket.findOne({ queueDate: dayKey(), status: "serving" }).lean();
  res.json({ ticket: ticket ? publicTicket(ticket) : null });
}));

app.get("/api/queue/dashboard", requireRole("staff", "admin"), asyncRoute(async (_req, res) => {
  await expireCalls();
  const queueDate = dayKey();
  const [waiting, current, completed, noShow, settings] = await Promise.all([
    QueueTicket.find({ queueDate, status: "waiting" }).sort({ queueSequence: 1 }).lean(),
    QueueTicket.findOne({ queueDate, status: "serving" }).lean(),
    QueueTicket.countDocuments({ queueDate, status: "completed" }),
    QueueTicket.countDocuments({ queueDate, status: "no-show" }),
    QueueSettings.findById("global").select("noShowDuration").lean(),
  ]);
  res.json({
    waiting: waiting.map(publicTicket),
    current: current ? publicTicket(current) : null,
    stats: { waiting: waiting.length, completed, noShow },
    noShowDuration: settings.noShowDuration,
  });
}));

app.get("/api/queue/:id", asyncRoute(async (req, res) => {
  if (!idSchema.safeParse(req.params.id).success) return fail(res, 404, "Ticket not found.");
  await expireCalls();
  const ticket = await QueueTicket.findById(req.params.id).lean();
  if (!ticket) return fail(res, 404, "Ticket not found.");
  res.json({ ticket: publicTicket(ticket) });
}));

function operationError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function callNextTicket(actor) {
  await expireCalls();
  const active = await QueueTicket.findOne({ queueDate: dayKey(), status: "serving" }).lean();
  if (active) throw operationError("Complete or resolve the current student before calling the next.", 409);
  const settings = await QueueSettings.findById("global").lean();
  const now = new Date();
  let ticket;
  try {
    ticket = await QueueTicket.findOneAndUpdate(
      { queueDate: dayKey(), status: "waiting" },
      { $set: {
        status: "serving",
        calledAt: now,
        callExpiresAt: new Date(now.getTime() + settings.noShowDuration * 1000),
      } },
      { sort: { queueSequence: 1 }, new: true },
    );
  } catch (error) {
    if (error.code === 11000) {
      throw operationError("A student has already been called.", 409);
    }
    throw error;
  }
  if (!ticket) throw operationError("There are no students waiting.", 404);
  await record(ticket, "called", actor);
  publishQueueUpdate(ticket);
  return publicTicket(ticket);
}

app.post("/api/queue/next", requireRole("staff", "admin"), asyncRoute(async (req, res) => {
  res.json({ ticket: await callNextTicket(req.session.user.name) });
}));

async function finishTicketById(id, status, actor) {
  if (!idSchema.safeParse(id).success) throw operationError("Ticket not found.", 404);
  await expireCalls();
  const now = new Date();
  const updates = status === "completed" ? { status, completedAt: now } : { status, noShowAt: now };
  const ticket = await QueueTicket.findOneAndUpdate(
    { _id: id, status: "serving" },
    { $set: updates, $unset: { callExpiresAt: 1 } },
    { new: true },
  );
  if (!ticket) throw operationError("This ticket is no longer being served.", 409);
  await record(ticket, status === "completed" ? "completed" : "no_show", actor);
  publishQueueUpdate(ticket);
  return publicTicket(ticket);
}

app.post("/api/queue/:id/complete", requireRole("staff", "admin"), asyncRoute(async (req, res) => {
  res.json({ ticket: await finishTicketById(req.params.id, "completed", req.session.user.name) });
}));
app.post("/api/queue/:id/no-show", requireRole("staff", "admin"), asyncRoute(async (req, res) => {
  res.json({ ticket: await finishTicketById(req.params.id, "no-show", req.session.user.name) });
}));

async function setNoShowDuration(duration) {
  const parsed = z.number().int().min(30).max(3600).safeParse(duration);
  if (!parsed.success) throw operationError("The timeout must be between 30 and 3600 seconds.", 400);
  const settings = await QueueSettings.findByIdAndUpdate(
    "global",
    { $set: { noShowDuration: parsed.data, updatedAt: new Date() } },
    { new: true },
  ).lean();
  publishQueueUpdate();
  return settings;
}

app.post("/api/queue/timer", requireRole("staff", "admin"), asyncRoute(async (req, res) => {
  const settings = await setNoShowDuration(req.body?.noShowDuration);
  res.json({ noShowDuration: settings.noShowDuration });
}));

app.get("/api/admin/staff", requireRole("admin"), asyncRoute(async (_req, res) => {
  const staff = await User.find({ role: "staff" }).sort({ name: 1 }).lean();
  res.json({ staff: staff.map(userView) });
}));

const createStaffSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.email().max(254),
  username: z.string().trim().min(3).max(40).regex(/^[A-Za-z0-9._-]+$/),
  password: z.string().min(10).max(200),
});
app.post("/api/admin/staff", requireRole("admin"), asyncRoute(async (req, res) => {
  const parsed = createStaffSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "Enter a valid name, email, username, and password (at least 10 characters).");
  try {
    const staff = await User.create({
      ...parsed.data,
      email: parsed.data.email.toLowerCase(),
      username: parsed.data.username.toLowerCase(),
      passwordHash: await bcrypt.hash(parsed.data.password, 12),
      role: "staff",
      isActive: true,
    });
    res.status(201).json({ staff: userView(staff) });
  } catch (error) {
    if (error.code === 11000) return fail(res, 409, "That email or username is already registered.");
    throw error;
  }
}));

app.patch("/api/admin/staff/:id", requireRole("admin"), asyncRoute(async (req, res) => {
  const parsed = z.object({ isActive: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "Provide a valid account status.");
  const staff = await User.findOneAndUpdate(
    { _id: req.params.id, role: "staff" },
    { $set: { isActive: parsed.data.isActive } },
    { new: true },
  );
  if (!staff) return fail(res, 404, "Staff account not found.");
  res.json({ staff: userView(staff) });
}));

app.get("/api/admin/settings", requireRole("admin"), asyncRoute(async (_req, res) => {
  const settings = await QueueSettings.findById("global").lean();
  res.json({ settings });
}));

app.put("/api/admin/settings", requireRole("admin"), asyncRoute(async (req, res) => {
  const parsed = z.object({
    noShowDuration: z.number().int().min(30).max(3600),
    systemStatus: z.enum(["active", "paused"]),
  }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "Enter a valid timeout and queue status.");
  const settings = await QueueSettings.findByIdAndUpdate(
    "global",
    { $set: { ...parsed.data, updatedAt: new Date() } },
    { new: true },
  ).lean();
  publishQueueUpdate();
  res.json({ settings });
}));

app.get("/api/admin/history", requireRole("admin", "staff"), asyncRoute(async (req, res) => {
  const parsed = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).safeParse(req.query.date || dayKey());
  if (!parsed.success) return fail(res, 400, "Enter a valid history date.");
  const history = await QueueHistory.find({ queueDate: parsed.data }).sort({ timestamp: -1 }).limit(500).lean();
  res.json({ history });
}));

app.post("/api/admin/queue/reset", requireRole("admin"), asyncRoute(async (req, res) => {
  const now = new Date();
  const active = await QueueTicket.find({ queueDate: dayKey(), status: { $in: ["waiting", "serving"] } }).lean();
  for (const candidate of active) {
    const ticket = await QueueTicket.findOneAndUpdate(
      { _id: candidate._id, status: { $in: ["waiting", "serving"] } },
      { $set: { status: "no-show", noShowAt: now }, $unset: { callExpiresAt: 1 } },
      { new: true },
    );
    if (ticket) {
      await record(ticket, "no_show", req.session.user.name);
      io.to(`ticket:${ticket._id}`).emit("student:position", {
        queueNumber: ticket.queueNumber,
        status: ticket.status,
        ahead: 0,
        currentServing: null,
      });
    }
  }
  publishQueueUpdate();
  res.json({ success: true, affected: active.length });
}));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(__dirname, "../dist");
if (isProduction) {
  const protectedPageRoles = new Map([
    ["/staff/dashboard", ["staff", "admin"]],
    ["/staff/history", ["staff", "admin"]],
    ["/admin/dashboard", ["admin"]],
    ["/admin/staff", ["admin"]],
    ["/admin/settings", ["admin"]],
    ["/admin/history", ["admin"]],
    ["/qr", ["admin"]],
  ]);
  app.use((req, res, next) => {
    let route;
    try {
      route = decodeURIComponent(req.path).replace(/\/index\.html$/, "").replace(/\/+$/, "") || "/";
    } catch {
      return fail(res, 400, "Invalid route.");
    }
    const roles = protectedPageRoles.get(route);
    if (!roles) return next();
    return requireRole(...roles)(req, res, next);
  });
  app.get("/", (_req, res) => res.redirect(302, "/join"));
  app.get("/join/clearance", (_req, res) => res.redirect(302, "/join"));
  app.get(["/staff/login", "/admin/login"], (_req, res) => res.redirect(302, "/login"));
  for (const [route] of protectedPageRoles) {
    app.get(route, (_req, res, next) => {
      const file = path.join(distPath, route.slice(1), "index.html");
      res.sendFile(file, (error) => error ? next(error) : undefined);
    });
  }
  app.get("/join", (_req, res) => res.sendFile(path.join(distPath, "join", "index.html")));
  app.use(express.static(distPath, { index: false }));
  app.get("/status/:id", (_req, res) => res.sendFile(path.join(distPath, "status", "index.html")));
  app.get("*", (req, res, next) => {
    const route = path.join(distPath, req.path.replace(/^\/+/, ""), "index.html");
    res.sendFile(route, (error) => error ? next() : undefined);
  });
}

app.use((req, res) => fail(res, 404, `Route not found: ${req.method} ${req.path}`));
app.use((error, _req, res, _next) => {
  console.error("Request failed:", error);
  if (res.headersSent) return;
  res.status(error.status || 500).json({ error: error.status ? error.message : "An unexpected server error occurred." });
});

httpServer.listen(port, () => {
  console.log(`Clearance queue API listening on http://localhost:${port}`);
  if (isProduction) console.log(`Serving Astro frontend from ${distPath}`);
});

process.on("SIGINT", () => { clearInterval(expiryTimer); httpServer.close(() => mongoose.disconnect().finally(() => process.exit(0))); });
process.on("SIGTERM", () => { clearInterval(expiryTimer); httpServer.close(() => mongoose.disconnect().finally(() => process.exit(0))); });
