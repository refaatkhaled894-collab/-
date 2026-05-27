require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const express = require("express");

process.on('uncaughtException', (err) => {
  console.error(' UNCAUGHT EXCEPTION:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error(' UNHANDLED REJECTION:', reason);
});

const app = express();
// Port من متغيرات البيئة أو 3000 افتراضياً
const port = Number(process.env.PORT) || 3000;
const mongoose = require("mongoose");
const http = require("http");
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  maxHttpBufferSize: 30e6 // 30 MB
});
const whiteboardStates = new Map();
const whiteboardPersistTimers = new Map();
const codeEditorStates = new Map();
const codeEditorPersistTimers = new Map();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "sharik_secret_key_2026_secure";

app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: "30mb" }));

const cors = require("cors");
app.use(cors());
app.use((req, res, next) => {
  req.traceId = genTraceId(req.headers["x-trace-id"]);
  res.setHeader("x-trace-id", req.traceId);
  const startedAt = Date.now();
  res.on("finish", () => {
    structuredLog("http.request", {
      traceId: req.traceId,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      latencyMs: Date.now() - startedAt,
    });
  });
  next();
});

const User = require("./modules/User");
const Message = require("./modules/Message");
const WhiteboardState = require("./modules/WhiteboardState");
const CodeEditorState = require("./modules/CodeEditorState");
const Article = require("./modules/myData");
const Report = require("./modules/Report");
const Match = require("./modules/Match");
const path = require("path");
const objectStorage = require("./services/objectStorage");
const crypto = require("crypto");
const WHITEBOARD_SNAPSHOT_INTERVAL = 25;
const WHITEBOARD_MAX_ACTIONS = 140;
const WHITEBOARD_MAX_RECORDING_EVENTS = 5000;
const WHITEBOARD_LOCK_DURATION_MS = 10 * 60 * 1000;
const METRICS_LOG_INTERVAL_MS = 60000;
const REDIS_RETRY_ATTEMPTS = 5;
const EVENT_QUEUE_MAX = Number(process.env.EVENT_QUEUE_MAX || 400);
const eventQueues = new Map();
const whiteboardPendingApprovals = new Map();
const whiteboardLockTimers = new Map();
const metrics = {
  socketEvents: {},
  rateLimited: {},
  latency: {},
};

function structuredLog(event, payload = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...payload }));
}

function genTraceId(seed = "") {
  if (seed && typeof seed === "string" && seed.length >= 8) return seed.slice(0, 64);
  return crypto.randomUUID();
}

function escapeHTML(str) {
  if (!str) return "";
  return String(str).replace(/[&<>'"]/g, 
    tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag)
  );
}

function trackEvent(name) {
  metrics.socketEvents[name] = (metrics.socketEvents[name] || 0) + 1;
}

function trackRateLimited(name) {
  metrics.rateLimited[name] = (metrics.rateLimited[name] || 0) + 1;
}

function trackLatency(name, ms) {
  if (!metrics.latency[name]) metrics.latency[name] = { count: 0, totalMs: 0, maxMs: 0 };
  const bucket = metrics.latency[name];
  bucket.count += 1;
  bucket.totalMs += ms;
  bucket.maxMs = Math.max(bucket.maxMs, ms);
}

function enqueueChatTask(chatId, task) {
  if (!eventQueues.has(chatId)) eventQueues.set(chatId, { running: false, items: [] });
  const queue = eventQueues.get(chatId);
  if (queue.items.length >= EVENT_QUEUE_MAX) return false;
  queue.items.push(task);
  if (!queue.running) {
    queue.running = true;
    (async function run() {
      while (queue.items.length > 0) {
        const fn = queue.items.shift();
        try {
          await fn();
        } catch (err) {
          structuredLog("queue.task_failed", { chatId, error: err.message });
        }
      }
      queue.running = false;
    })();
  }
  return true;
}

function parseChatMembers(chatId) {
  if (!chatId || typeof chatId !== "string") return [];
  return chatId.split("_").map((item) => item.trim().toLowerCase()).filter(Boolean);
}

function canAccessChat(socket, chatId) {
  const members = parseChatMembers(chatId);
  return members.includes((socket.user?.email || "").toLowerCase());
}

function ensureJoined(socket, chatId) {
  return Boolean(socket.data.joinedChats && socket.data.joinedChats.has(chatId));
}

function isRateLimited(socket, key, limit, windowMs) {
  if (!socket.data.rl) socket.data.rl = {};
  const now = Date.now();
  const bucket = socket.data.rl[key] || [];
  const filtered = bucket.filter((ts) => now - ts < windowMs);
  filtered.push(now);
  socket.data.rl[key] = filtered;
  const blocked = filtered.length > limit;
  if (blocked) trackRateLimited(key);
  return blocked;
}

function sanitizeAction(action) {
  if (!action || typeof action !== "object") return null;
  if (action.type === "stroke") {
    const points = Array.isArray(action.points) ? action.points.slice(0, 1200) : [];
    return {
      id: String(action.id || `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`),
      type: "stroke",
      mode: action.mode === "erase" ? "erase" : "draw",
      color: typeof action.color === "string" ? action.color : "#2563eb",
      size: Math.max(1, Math.min(50, Number(action.size) || 4)),
      points: points
        .map((p) => ({ x: Number(p.x) || 0, y: Number(p.y) || 0 }))
        .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)),
    };
  }
  if (action.type === "text") {
    return {
      id: String(action.id || `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`),
      type: "text",
      x: Number(action.x) || 0,
      y: Number(action.y) || 0,
      text: String(action.text || "").slice(0, 300),
      color: typeof action.color === "string" ? action.color : "#2563eb",
      size: Math.max(10, Math.min(80, Number(action.size) || 16)),
    };
  }
  return null;
}

function defaultPermission(canControl = false) {
  return {
    canDraw: true,
    canUseText: true,
    canUpload: true,
    canControl,
  };
}

function ensureSessionMeta(state = {}, chatId = "") {
  if (!state.sessionMeta || typeof state.sessionMeta !== "object") {
    state.sessionMeta = {
      teacher: "",
      learner: "",
      permissions: {},
      boardLocked: false,
      followMode: false,
      activeTemplate: "blank",
      recordingActive: false,
      recordingStartedAt: null,
      roleModeActive: false,
      lockExpiresAt: null,
    };
  }
  if (!state.sessionMeta.permissions || typeof state.sessionMeta.permissions !== "object") {
    state.sessionMeta.permissions = {};
  }
  if (!state.assets || !Array.isArray(state.assets)) state.assets = [];
  if (!state.recordingLog || !Array.isArray(state.recordingLog)) state.recordingLog = [];

  const members = parseChatMembers(chatId);
  if (members.length >= 2) {
    const [memberA, memberB] = members;
    if (!state.sessionMeta.permissions[memberA]) state.sessionMeta.permissions[memberA] = defaultPermission(false);
    if (!state.sessionMeta.permissions[memberB]) state.sessionMeta.permissions[memberB] = defaultPermission(false);
  }
  return state;
}

function normalizeSessionEmail(email = "") {
  return String(email || "").trim().toLowerCase();
}

function canControlSession(state, email) {
  const userEmail = normalizeSessionEmail(email);
  const teacher = normalizeSessionEmail(state?.sessionMeta?.teacher);
  if (teacher && teacher === userEmail) return true;
  return Boolean(state?.sessionMeta?.permissions?.[userEmail]?.canControl);
}

function canUserDraw(state, email) {
  const userEmail = normalizeSessionEmail(email);
  if (state?.sessionMeta?.boardLocked) {
    const teacher = normalizeSessionEmail(state?.sessionMeta?.teacher);
    return teacher && userEmail === teacher;
  }
  const permission = state?.sessionMeta?.permissions?.[userEmail];
  if (!permission) return true;
  return Boolean(permission.canDraw);
}

function getPeerEmail(chatId, email) {
  const members = parseChatMembers(chatId);
  const current = normalizeSessionEmail(email);
  return members.find((m) => m !== current) || "";
}

function getApprovalState(chatId) {
  if (!whiteboardPendingApprovals.has(chatId)) {
    whiteboardPendingApprovals.set(chatId, { role: null, lock: null });
  }
  return whiteboardPendingApprovals.get(chatId);
}

function clearLockTimer(chatId) {
  const timer = whiteboardLockTimers.get(chatId);
  if (timer) clearTimeout(timer);
  whiteboardLockTimers.delete(chatId);
}

function scheduleLockExpiry(chatId) {
  clearLockTimer(chatId);
  const timer = setTimeout(async () => {
    const state = await loadWhiteboardState(chatId);
    ensureSessionMeta(state, chatId);
    state.sessionMeta.boardLocked = false;
    state.sessionMeta.lockExpiresAt = null;
    state.sessionMeta.roleModeActive = false;
    state.sessionMeta.teacher = "";
    state.sessionMeta.learner = "";
    whiteboardStates.set(chatId, state);
    queueWhiteboardPersist(chatId);
    io.to(chatId).emit("whiteboardLockExpired", {
      chatId,
      sessionMeta: state.sessionMeta,
    });
    io.to(chatId).emit("whiteboardSession", {
      chatId,
      sessionMeta: state.sessionMeta,
    });
  }, WHITEBOARD_LOCK_DURATION_MS);
  whiteboardLockTimers.set(chatId, timer);
}

function appendRecordingEvent(state, eventName, sender, payload = {}) {
  ensureSessionMeta(state);
  const shouldRecord = state.sessionMeta.recordingActive || eventName.startsWith("recording:");
  if (!shouldRecord) return;
  state.recordingLog.push({
    ts: Date.now(),
    event: eventName,
    sender: normalizeSessionEmail(sender),
    payload,
  });
  if (state.recordingLog.length > WHITEBOARD_MAX_RECORDING_EVENTS) {
    state.recordingLog = state.recordingLog.slice(-WHITEBOARD_MAX_RECORDING_EVENTS);
  }
}

async function initRedisAdapterIfEnabled() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return;
  for (let attempt = 1; attempt <= REDIS_RETRY_ATTEMPTS; attempt++) {
    try {
      const { createAdapter } = require("@socket.io/redis-adapter");
      const { createClient } = require("redis");
      const pubClient = createClient({ url: redisUrl });
      const subClient = pubClient.duplicate();
      await Promise.all([pubClient.connect(), subClient.connect()]);
      io.adapter(createAdapter(pubClient, subClient));
      structuredLog("socket.redis_adapter_enabled", { redisUrl: "***", attempt });
      return;
    } catch (err) {
      structuredLog("socket.redis_adapter_failed", { error: err.message, attempt });
      await new Promise((r) => setTimeout(r, attempt * 1000));
    }
  }
  structuredLog("socket.redis_fallback_memory_adapter");
}

async function loadWhiteboardState(chatId) {
  if (!chatId) return { snapshot: null, actions: [], redoStack: [] };
  if (whiteboardStates.has(chatId)) return whiteboardStates.get(chatId);
  const doc = await WhiteboardState.findOne({ chatId });
  let snapshot = null;
  if (doc?.snapshot?.key) {
    if (objectStorage.isRemoteStorage) {
      snapshot = {
        mime: doc.snapshot.mime || "image/jpeg",
        signedUrl: await objectStorage.getSignedReadUrl(doc.snapshot.key),
        updatedAt: doc.snapshot.updatedAt || null,
      };
    } else {
      const dataUrl = await objectStorage.readDataUrl(doc.snapshot.key);
      if (dataUrl) {
        snapshot = {
          mime: doc.snapshot.mime || "image/jpeg",
          data: dataUrl,
          updatedAt: doc.snapshot.updatedAt || null,
        };
      }
    }
  }
  const state = doc
    ? {
      snapshot,
      actions: doc.actions || [],
      redoStack: doc.redoStack || [],
      sessionMeta: doc.sessionMeta || {},
      assets: doc.assets || [],
      recordingLog: doc.recordingLog || [],
    }
    : { snapshot: null, actions: [], redoStack: [], sessionMeta: {}, assets: [], recordingLog: [] };
  ensureSessionMeta(state, chatId);
  whiteboardStates.set(chatId, state);
  return state;
}

function queueWhiteboardPersist(chatId) {
  if (!chatId) return;
  const existing = whiteboardPersistTimers.get(chatId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(async () => {
    const state = whiteboardStates.get(chatId) || { snapshot: null, actions: [], redoStack: [], sessionMeta: {}, assets: [], recordingLog: [] };
    ensureSessionMeta(state, chatId);
    try {
      let snapshotKey = "";
      if (state.snapshot?.data) {
        snapshotKey = await objectStorage.saveDataUrl(chatId, state.snapshot.data);
      }
      await WhiteboardState.findOneAndUpdate(
        { chatId },
        {
          chatId,
          lastActivity: new Date(),
          snapshot: state.snapshot
            ? {
              mime: state.snapshot.mime || "image/jpeg",
              key: snapshotKey,
              updatedAt: state.snapshot.updatedAt || new Date(),
            }
            : { mime: "", key: "", updatedAt: null },
          actions: state.actions,
          redoStack: state.redoStack,
          sessionMeta: state.sessionMeta,
          assets: state.assets,
          recordingLog: state.recordingLog,
        },
        { upsert: true, new: true }
      );
    } catch (err) {
      console.error("Whiteboard persist error:", err.message);
    } finally {
      whiteboardPersistTimers.delete(chatId);
    }
  }, 220);
  whiteboardPersistTimers.set(chatId, timer);
}

async function loadCodeEditorState(chatId) {
  if (!chatId) return { content: "// ابدأ الكتابة...\n", language: "javascript", revision: 0 };
  if (codeEditorStates.has(chatId)) return codeEditorStates.get(chatId);
  const doc = await CodeEditorState.findOne({ chatId });
  const state = doc
    ? { content: doc.content || "", language: doc.language || "javascript", revision: doc.revision || 0 }
    : { content: "// ابدأ الكتابة...\n", language: "javascript", revision: 0 };
  codeEditorStates.set(chatId, state);
  return state;
}

function queueCodeEditorPersist(chatId) {
  if (!chatId) return;
  const existing = codeEditorPersistTimers.get(chatId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(async () => {
    const state = codeEditorStates.get(chatId);
    if (!state) return;
    try {
      await CodeEditorState.findOneAndUpdate(
        { chatId },
        {
          chatId,
          lastActivity: new Date(),
          content: state.content,
          language: state.language,
          revision: state.revision,
        },
        { upsert: true, new: true }
      );
    } catch (err) {
      console.error("CodeEditor persist error:", err.message);
    } finally {
      codeEditorPersistTimers.delete(chatId);
    }
  }, 1000);
  codeEditorPersistTimers.set(chatId, timer);
}

// ═══════════════════════════════════════════════
// Serve Static Frontend
// ═══════════════════════════════════════════════
app.use(express.static(path.join(__dirname, "../public")));

// ═══════════════════════════════════════════════
// JWT Auth Middleware
// ═══════════════════════════════════════════════
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "يجب تسجيل الدخول أولاً" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.id;
    next();
  } catch {
    return res.status(401).json({ error: "جلسة غير صالحة، سجل الدخول مرة أخرى" });
  }
}



// ═══════════════════════════════════════════════
// 1) AUTH APIs - Register & Login
// ═══════════════════════════════════════════════
app.post("/api/register", async (req, res) => {
  try {
    const { username1, username2, email, password } = req.body;
    if (!username1 || !username2 || !email || !password) {
      return res.status(400).json({ error: "جميع الحقول مطلوبة" });
    }
    const existing = await User.findOne({ email: email.toLowerCase().trim() });
    if (existing) {
      return res.status(400).json({ error: "هذا البريد مسجل بالفعل" });
    }
    const user = new User({
      username1: username1.trim(),
      username2: username2.trim(),
      email: email.toLowerCase().trim(),
      password: password,
    });
    await user.save();
    const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: "7d" });
    const safeUser = user.toSafeObject();
    safeUser.name = safeUser.username1 + " " + safeUser.username2;
    res.status(201).json({ token, user: safeUser });
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "حدث خطأ في التسجيل" });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "البريد وكلمة المرور مطلوبان" });
    }
    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) {
      return res.status(401).json({ error: "البريد الإلكتروني أو كلمة المرور غير صحيحة" });
    }
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ error: "البريد الإلكتروني أو كلمة المرور غير صحيحة" });
    }
    const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: "7d" });
    const safeUser = user.toSafeObject();
    safeUser.name = safeUser.username1 + " " + safeUser.username2;
    res.json({ token, user: safeUser });
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "حدث خطأ في تسجيل الدخول" });
  }
});

app.get("/api/me", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: "مستخدم غير موجود" });
    const safeUser = user.toSafeObject();
    safeUser.name = safeUser.username1 + " " + safeUser.username2;
    res.json({ user: safeUser });
  } catch (err) {
    res.status(500).json({ error: "خطأ في جلب البيانات" });
  }
});

// Update avatar (base64)
app.put("/api/me/avatar", authMiddleware, async (req, res) => {
  try {
    const { avatar } = req.body;
    if (!avatar) return res.status(400).json({ error: "الصورة مطلوبة" });
    // Limit to ~2MB base64
    if (avatar.length > 2.8 * 1024 * 1024) {
      return res.status(413).json({ error: "حجم الصورة كبير جداً (الحد الأقصى 2MB)" });
    }
    const user = await User.findByIdAndUpdate(
      req.userId,
      { avatar },
      { new: true }
    );
    const safeUser = user.toSafeObject();
    safeUser.name = safeUser.username1 + " " + safeUser.username2;
    res.json({ user: safeUser });
  } catch (err) {
    res.status(500).json({ error: "خطأ في تحديث الصورة" });
  }
});

// ═══════════════════════════════════════════════
// 2) SKILLS APIs - Save skills
// ═══════════════════════════════════════════════
app.post("/api/skills", authMiddleware, async (req, res) => {
  try {
    const { learnSkills, teachSkills } = req.body;
    if (!learnSkills || !teachSkills || learnSkills.length === 0 || teachSkills.length === 0) {
      return res.status(400).json({ error: "يجب اختيار مهارة واحدة على الأقل من كل قسم" });
    }
    const user = await User.findByIdAndUpdate(
      req.userId,
      { learnSkills, teachSkills },
      { new: true }
    );
    const safeUser = user.toSafeObject();
    safeUser.name = safeUser.username1 + " " + safeUser.username2;
    res.json({ user: safeUser });
  } catch (err) {
    res.status(500).json({ error: "خطأ في حفظ المهارات" });
  }
});

// ═══════════════════════════════════════════════
// 3) SKILL TEST APIs
// ═══════════════════════════════════════════════
app.post("/api/skill-test/submit", authMiddleware, async (req, res) => {
  try {
    const { skill, score, total, passed, pct } = req.body;
    if (!skill) return res.status(400).json({ error: "المهارة مطلوبة" });

    const update = {};
    update[`skillTestResults.${skill}`] = {
      pct: pct || Math.round((score / total) * 100),
      passed: passed,
      date: new Date().toISOString(),
    };

    if (passed) {
      await User.findByIdAndUpdate(req.userId, {
        $set: update,
        $addToSet: { verifiedSkills: skill },
      });
    } else {
      await User.findByIdAndUpdate(req.userId, { $set: update });
    }

    const user = await User.findById(req.userId);
    const safeUser = user.toSafeObject();
    safeUser.name = safeUser.username1 + " " + safeUser.username2;
    res.json({ user: safeUser, passed });
  } catch (err) {
    res.status(500).json({ error: "خطأ في حفظ نتيجة الاختبار" });
  }
});

// ═══════════════════════════════════════════════
// 4) MATCHING API
// ═══════════════════════════════════════════════
app.get("/api/matches", authMiddleware, async (req, res) => {
  try {
    // جلب بيانات المستخدم الحالي بـ lean() للسرعة
    const currentUser = await User.findById(req.userId)
      .select("email learnSkills teachSkills verifiedSkills")
      .lean();
    if (!currentUser || !currentUser.learnSkills.length || !currentUser.teachSkills.length) {
      return res.json({ matches: [] });
    }

    // field projection: نجيب الحقول اللي محتاجينها بس — أسرع بكتير
    // NOTE: verifiedSkills filter relaxed — users without test results still show up
    // so new / test accounts can discover matches and accept/reject requests.
    const allUsers = await User.find(
      {
        _id: { $ne: currentUser._id },
        learnSkills: { $exists: true, $ne: [] },
        teachSkills: { $exists: true, $ne: [] },
        status: { $ne: "banned" }, // استثناء المستخدمين المحظورين من المطابقة
      },
      "email username1 username2 learnSkills teachSkills verifiedSkills avatar bio"
    ).lean();

    const matches = allUsers
      .filter((user) => {
        // يكفي أن يوجد تقاطع في المهارات (بدون اشتراط التحقق) لأغراض الاكتشاف
        const canTeachMe = user.teachSkills.some((s) =>
          currentUser.learnSkills.includes(s)
        );
        const canLearnFrom = user.learnSkills.some((s) =>
          currentUser.teachSkills.includes(s)
        );
        return canTeachMe && canLearnFrom;
      })
      .map((user) => {
        const uVerified = user.verifiedSkills || [];
        const myVerified = currentUser.verifiedSkills || [];
        const learnM = user.teachSkills.filter((s) => currentUser.learnSkills.includes(s)).length;
        const teachM = user.learnSkills.filter((s) => currentUser.teachSkills.includes(s)).length;
        // Bonus points for verified skills
        const learnMV = user.teachSkills.filter((s) => currentUser.learnSkills.includes(s) && uVerified.includes(s)).length;
        const teachMV = user.learnSkills.filter((s) => currentUser.teachSkills.includes(s) && myVerified.includes(s)).length;
        const total = currentUser.learnSkills.length + currentUser.teachSkills.length || 1;
        const matchScore = Math.min(100, Math.round(((learnM + teachM + learnMV + teachMV) / (total * 2)) * 100) || Math.round(((learnM + teachM) / total) * 100));
        // بناء safe object يدوياً لأن lean() بيشيل الـ methods
        const safe = { ...user };
        delete safe.password;
        safe.name = safe.username1 + " " + safe.username2;
        safe.matchScore = matchScore;
        return safe;
      })
      .sort((a, b) => b.matchScore - a.matchScore);

    res.json({ matches });
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "خطأ في البحث عن شركاء" });
  }
});

// ═══════════════════════════════════════════════
// 5) CHAT APIs
// ═══════════════════════════════════════════════
app.get("/api/messages/:chatId", authMiddleware, async (req, res) => {
  try {
    const { before, limit } = req.query;
    const cappedLimit = Math.max(1, Math.min(Number(limit) || 40, 100));
    const filter = { chatId: req.params.chatId };
    if (before) {
      const beforeDate = new Date(before);
      if (!Number.isNaN(beforeDate.getTime())) {
        filter.createdAt = { $lt: beforeDate };
      }
    }
    const rows = await Message.find(filter)
      .sort({ createdAt: -1 })
      .limit(cappedLimit + 1)
      .lean();
    const hasMore = rows.length > cappedLimit;
    const page = hasMore ? rows.slice(0, cappedLimit) : rows;
    const messages = page.reverse();
    const nextBefore = messages.length ? messages[0].createdAt : null;
    res.json({ messages, hasMore, nextBefore });
  } catch (err) {
    res.status(500).json({ error: "خطأ في جلب الرسائل" });
  }
});

app.post("/api/messages", authMiddleware, async (req, res) => {
  try {
    const { chatId, receiver, text, attachments, messageId } = req.body;
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: "مستخدم غير موجود" });
    if (!messageId || typeof messageId !== "string") {
      return res.status(400).json({ error: "messageId مطلوب" });
    }

    let message = await Message.findOne({ chatId, messageId });
    if (!message) {
      message = new Message({
        chatId,
        messageId,
        sender: user.email,
        receiver,
        text: escapeHTML(text),
        attachments: attachments || [],
      });
      await message.save();
      // Emit only on first creation
      io.to(chatId).emit("newMessage", message);
    }

    res.status(201).json({ message });
  } catch (err) {
    res.status(500).json({ error: "خطأ في إرسال الرسالة" });
  }
});

// Get user by email (for profile/chat)
app.get("/api/user/:email", authMiddleware, async (req, res) => {
  try {
    const user = await User.findOne({ email: req.params.email });
    if (!user) return res.status(404).json({ error: "مستخدم غير موجود" });
    const safeUser = user.toSafeObject();
    safeUser.name = safeUser.username1 + " " + safeUser.username2;
    res.json({ user: safeUser });
  } catch (err) {
    res.status(500).json({ error: "خطأ في جلب بيانات المستخدم" });
  }
});

// ═══════════════════════════════════════════════
// 6) PROFILE EXTENSIONS APIs (Interactions, Reviews, Bio)
// ═══════════════════════════════════════════════

// Session Rating
app.post("/api/session/rate", authMiddleware, async (req, res) => {
  try {
    const { ratedEmail, skill, rating, comment } = req.body;
    if (!ratedEmail || !rating) return res.status(400).json({ error: "البيانات ناقصة" });
    
    const targetUser = await User.findOne({ email: ratedEmail });
    if (!targetUser) return res.status(404).json({ error: "المستخدم غير موجود" });

    // Ensure reviews array exists in the model virtually or dynamically
    if (!targetUser.reviews) targetUser.reviews = [];
    targetUser.reviews.push({
      reviewer: req.userEmail || req.userId,
      skill: skill || "عام",
      rating: Number(rating),
      comment: comment || "",
      date: new Date().toISOString()
    });

    // Recalculate average rating if rating field exists
    if (targetUser.rating !== undefined) {
      const total = targetUser.reviews.reduce((acc, r) => acc + r.rating, 0);
      targetUser.rating = total / targetUser.reviews.length;
    }

    await targetUser.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "خطأ في حفظ التقييم" });
  }
});

// Update Bio
app.put("/api/me/bio", authMiddleware, async (req, res) => {
  try {
    const { bio } = req.body;
    const user = await User.findByIdAndUpdate(req.userId, { bio }, { new: true });
    const safeUser = user.toSafeObject();
    safeUser.name = safeUser.username1 + " " + safeUser.username2;
    res.json({ user: safeUser });
  } catch (err) {
    res.status(500).json({ error: "خطأ في تحديث النبذة" });
  }
});

// Get users interacted with (matches or chatted)
app.get("/api/interactions", authMiddleware, async (req, res) => {
  try {
    const currentUser = await User.findById(req.userId)
      .select("email deletedConnections")
      .lean();
    if (!currentUser) return res.status(404).json({ error: "مستخدم غير موجود" });

    // استخدام distinct بدل جلب كل الرسائل — أسرع بكتير في الذاكرة
    const [senders, receivers] = await Promise.all([
      Message.distinct("sender", { receiver: currentUser.email }),
      Message.distinct("receiver", { sender: currentUser.email }),
    ]);

    const interactedEmails = new Set([...senders, ...receivers]);
    interactedEmails.delete(currentUser.email); // حذف الـ email الخاص

    // Remove deleted connections
    const deleted = new Set(currentUser.deletedConnections || []);
    const validEmails = Array.from(interactedEmails).filter(e => !deleted.has(e));

    // جلب بيانات المستخدمين بـ lean() وبدون password
    const users = await User.find(
      { email: { $in: validEmails } },
      "email username1 username2 avatar bio verifiedSkills learnSkills teachSkills"
    ).lean();

    const safeUsers = users.map(u => {
      u.name = u.username1 + " " + u.username2;
      return u;
    });

    res.json({ interactions: safeUsers });
  } catch (err) {
    res.status(500).json({ error: "خطأ في جلب التفاعلات" });
  }
});

// Delete a connection
app.post("/api/connections/delete", authMiddleware, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "البريد الإلكتروني مطلوب" });

    await User.findByIdAndUpdate(req.userId, {
      $addToSet: { deletedConnections: email }
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "خطأ في حذف الاتصال" });
  }
});

// Add a review
app.post("/api/reviews", authMiddleware, async (req, res) => {
  try {
    const { targetEmail, rating, comment } = req.body;
    if (!targetEmail || !rating) return res.status(400).json({ error: "البيانات مطلوبة" });

    const reviewer = await User.findById(req.userId);
    if (!reviewer) return res.status(404).json({ error: "المراجع غير موجود" });

    const targetUser = await User.findOne({ email: targetEmail });
    if (!targetUser) return res.status(404).json({ error: "المستخدم المستهدف غير موجود" });

    // Check if review already exists
    const existingReviewIndex = targetUser.reviews.findIndex(r => r.reviewerEmail === reviewer.email);
    const newReview = {
      reviewerEmail: reviewer.email,
      reviewerName: reviewer.username1 + " " + reviewer.username2,
      rating: Number(rating),
      comment: comment || "",
      date: new Date()
    };

    if (existingReviewIndex >= 0) {
      targetUser.reviews[existingReviewIndex] = newReview;
    } else {
      targetUser.reviews.push(newReview);
    }

    await targetUser.save();
    res.json({ success: true, reviews: targetUser.reviews });
  } catch (err) {
    res.status(500).json({ error: "خطأ في إضافة التقييم" });
  }
});

// Report User
app.post("/api/reports", authMiddleware, async (req, res) => {
  try {
    const { targetEmail, reason, chatId } = req.body;
    if (!targetEmail || !reason) return res.status(400).json({ error: "بيانات البلاغ غير مكتملة" });

    const reporter = await User.findById(req.userId);
    if (!reporter) return res.status(404).json({ error: "المبلغ غير موجود" });

    const report = new Report({
      reporterEmail: reporter.email,
      reportedEmail: targetEmail,
      reason: escapeHTML(reason),
      chatId: chatId || ""
    });
    
    await report.save();
    res.json({ success: true, message: "تم إرسال البلاغ وسيقوم المسؤولون بمراجعته بأقرب وقت" });
  } catch (err) {
    res.status(500).json({ error: "حدث خطأ أثناء إرسال البلاغ" });
  }
});

// ═══════════════════════════════════════════════
// 6b) NOTIFICATIONS API
// ═══════════════════════════════════════════════

// GET /api/notifications — جلب الإشعارات للمستخدم الحالي
app.get("/api/notifications", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select("notifications").lean();
    if (!user) return res.status(404).json({ error: "مستخدم غير موجود" });
    const notifications = (user.notifications || []).slice().reverse(); // الأحدث أولاً
    res.json({ notifications });
  } catch (err) {
    res.status(500).json({ error: "خطأ في جلب الإشعارات" });
  }
});

// PATCH /api/notifications/read — تعليم كل الإشعارات كمقروءة
app.patch("/api/notifications/read", authMiddleware, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.userId, {
      $set: { "notifications.$[].read": true }
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "خطأ في تحديث الإشعارات" });
  }
});

// ═══════════════════════════════════════════════
// 6c) MATCH REQUESTS API (Inbox / Accept / Reject)
// ═══════════════════════════════════════════════

// GET /api/match-requests — جلب طلبات المطابقة الواردة (pending)
app.get("/api/match-requests", authMiddleware, async (req, res) => {
  try {
    const me = await User.findById(req.userId).select("email").lean();
    if (!me) return res.status(404).json({ error: "مستخدم غير موجود" });

    const incoming = await Match.find({
      $or: [{ userA: me.email }, { userB: me.email }],
      initiator: { $ne: me.email },
      status: "pending",
    }).lean();

    // جلب بيانات المرسل لكل طلب
    const requesterEmails = incoming.map(m => m.initiator);
    const requesters = await User.find(
      { email: { $in: requesterEmails } },
      "email username1 username2 avatar learnSkills teachSkills verifiedSkills"
    ).lean();
    const requesterMap = {};
    requesters.forEach(u => {
      requesterMap[u.email] = { ...u, name: u.username1 + " " + u.username2 };
    });

    const result = incoming.map(m => ({
      matchId: m._id,
      chatId: m.chatId,
      status: m.status,
      createdAt: m.createdAt,
      requester: requesterMap[m.initiator] || { email: m.initiator, name: m.initiator },
    }));

    res.json({ requests: result });
  } catch (err) {
    res.status(500).json({ error: "خطأ في جلب طلبات المطابقة" });
  }
});

// POST /api/match-requests — إرسال طلب مطابقة جديد
app.post("/api/match-requests", authMiddleware, async (req, res) => {
  try {
    const me = await User.findById(req.userId).select("email username1 username2").lean();
    if (!me) return res.status(404).json({ error: "مستخدم غير موجود" });
    const { targetEmail } = req.body;
    if (!targetEmail) return res.status(400).json({ error: "البريد المستهدف مطلوب" });
    if (targetEmail.toLowerCase() === me.email) return res.status(400).json({ error: "لا يمكنك إرسال طلب لنفسك" });

    const [userA, userB] = Match.makePair(me.email, targetEmail);
    const existing = await Match.findOne({ userA, userB });
    if (existing) {
      return res.status(409).json({ error: "يوجد طلب مطابقة بالفعل بينكما", status: existing.status });
    }

    const match = await Match.create({
      userA,
      userB,
      initiator: me.email,
      status: "pending",
    });

    // إرسال إشعار للمستخدم المستهدف
    const senderName = me.username1 + " " + me.username2;
    await User.findOneAndUpdate(
      { email: targetEmail },
      {
        $push: {
          notifications: {
            title: "طلب مطابقة جديد",
            message: `أرسل لك ${senderName} طلب مطابقة لتبادل المهارات`,
            type: "info",
            read: false,
            date: new Date(),
          }
        }
      }
    );

    res.status(201).json({ success: true, match });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "خطأ في إرسال طلب المطابقة" });
  }
});

// PATCH /api/match-requests/:matchId — قبول أو رفض طلب مطابقة
app.patch("/api/match-requests/:matchId", authMiddleware, async (req, res) => {
  try {
    const me = await User.findById(req.userId).select("email username1 username2").lean();
    if (!me) return res.status(404).json({ error: "مستخدم غير موجود" });

    const { action } = req.body; // 'accept' or 'reject'
    if (!action || !["accept", "reject"].includes(action)) {
      return res.status(400).json({ error: "action يجب أن تكون accept أو reject" });
    }

    const match = await Match.findById(req.params.matchId);
    if (!match) return res.status(404).json({ error: "الطلب غير موجود" });

    // فقط المستلم (غير المُبادر) يمكنه الرد
    const myEmail = me.email.toLowerCase();
    const isRecipient = (match.userA === myEmail || match.userB === myEmail) && match.initiator !== myEmail;
    if (!isRecipient) return res.status(403).json({ error: "لا يمكنك الرد على هذا الطلب" });
    if (match.status !== "pending") return res.status(409).json({ error: "تم الرد على هذا الطلب مسبقاً" });

    if (action === "accept") {
      match.status = "accepted";
      match.chatId = Match.buildChatId(match.userA, match.userB);

      // إرسال إشعار للمُبادر
      const responderName = me.username1 + " " + me.username2;
      await User.findOneAndUpdate(
        { email: match.initiator },
        {
          $push: {
            notifications: {
              title: "تم قبول طلب المطابقة! 🎉",
              message: `قبل ${responderName} طلبك — يمكنك الآن بدء المحادثة`,
              type: "success",
              read: false,
              date: new Date(),
            }
          }
        }
      );
    } else {
      match.status = "rejected";
    }

    await match.save();
    res.json({ success: true, match });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "خطأ في الرد على الطلب" });
  }
});

// ═══════════════════════════════════════════════
// 7) ADMIN & GAMIFICATION APIs
// ═══════════════════════════════════════════════

// Get all users for admin dashboard (محمي بالـ role)
app.get("/api/admin/users", authMiddleware, async (req, res) => {
  try {
    const admin = await User.findById(req.userId);
    if (!admin || admin.role !== "admin") {
      return res.status(403).json({ error: "غير مصرح لك — يجب أن تكون مسؤولاً" });
    }

    // Pagination لتجنب جلب آلاف المستخدمين دفعة واحدة
    const page = Number(req.query.page) || 1;
    const limit = 50;
    const rawUsers = await User.find({}, "-password -notifications -reviews")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    const totalCount = await User.countDocuments();

    // Normalize old users that don't have status field yet
    const users = rawUsers.map(u => {
      if (!u.status) u.status = "active";
      if (!u.role)   u.role   = "user";
      return u;
    });

    // Real active sessions: distinct chatIds in Message collection
    let activeSessions = 0;
    try {
      activeSessions = await Message.distinct("chatId").then(r => r.length);
    } catch(_) { activeSessions = 0; }

    const stats = {
      totalUsers: totalCount,
      verifiedSkills: users.reduce((acc, u) => acc + (u.verifiedSkills?.length || 0), 0),
      activeSessions,
      page,
      totalPages: Math.ceil(totalCount / limit)
    };
    res.json({ users, stats });
  } catch (err) {
    res.status(500).json({ error: "Error fetching admin data" });
  }
});

// Update user status (ban/unban) — محمي بالـ role
app.put("/api/admin/users/:userId/status", authMiddleware, async (req, res) => {
  try {
    const admin = await User.findById(req.userId);
    if (!admin || admin.role !== "admin") {
      return res.status(403).json({ error: "غير مصرح لك" });
    }
    const { status } = req.body;
    if (!['active', 'banned'].includes(status)) {
      return res.status(400).json({ error: "حالة غير صحيحة" });
    }
    const targetUser = await User.findByIdAndUpdate(req.params.userId, { status }, { new: true });
    if (!targetUser) return res.status(404).json({ error: "المستخدم غير موجود" });
    res.json({ success: true, status: targetUser.status });
  } catch (err) {
    res.status(500).json({ error: "Error updating status" });
  }
});

// Get user notifications
app.get("/api/notifications", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ notifications: user.notifications || [] });
  } catch (err) {
    res.status(500).json({ error: "Error fetching notifications" });
  }
});

// Admin: Get Chats — محمي بالـ role
app.get("/api/admin/chats", authMiddleware, async (req, res) => {
  try {
    const admin = await User.findById(req.userId);
    if (!admin || admin.role !== "admin") {
      return res.status(403).json({ error: "غير مصرح لك" });
    }
    // Group messages by chatId to find unique sessions
    const chatStats = await Message.aggregate([
      { $group: { _id: "$chatId", msgCount: { $sum: 1 }, lastMessage: { $max: "$createdAt" }, members: { $addToSet: "$sender" } } },
      { $sort: { lastMessage: -1 } },
      { $limit: 50 }
    ]);
    res.json({ chats: chatStats });
  } catch (err) {
    res.status(500).json({ error: "Error fetching admin chats" });
  }
});

// Admin: Get Blogs — محمي بالـ role
app.get("/api/admin/blogs", authMiddleware, async (req, res) => {
  try {
    const admin = await User.findById(req.userId);
    if (!admin || admin.role !== "admin") {
      return res.status(403).json({ error: "غير مصرح لك" });
    }
    const blogs = await Article.find().sort({ createdAt: -1 }).limit(50).lean();
    res.json({ blogs });
  } catch (err) {
    res.status(500).json({ error: "Error fetching admin blogs" });
  }
});

// Admin: Get Reports
app.get("/api/admin/reports", authMiddleware, async (req, res) => {
  try {
    const admin = await User.findById(req.userId);
    if (!admin || admin.role !== "admin") {
      return res.status(403).json({ error: "غير مصرح لك" });
    }
    const reports = await Report.find().sort({ createdAt: -1 }).limit(100).lean();
    res.json({ reports });
  } catch (err) {
    res.status(500).json({ error: "خطأ في جلب البلاغات" });
  }
});

// ═══════════════════════════════════════════════
// 8) E2E TESTING HELPERS (Not protected)
// ═══════════════════════════════════════════════

app.put("/api/test/reset-user", async (req, res) => {
  try {
    // Allows resetting the test user account between E2E runs
    const testEmail = "sharik@gmail.com";
    await User.deleteMany({ email: testEmail });
    await Match.deleteMany({ $or: [{ userA: testEmail }, { userB: testEmail }] });
    res.json({ success: true, message: `Deleted testing records for ${testEmail}` });
  } catch (err) {
    res.status(500).json({ error: "خطأ في الجلب" });
  }
});

app.post("/api/test/seed-match", async (req, res) => {
  try {
    const testEmail = "sharik@gmail.com";
    const partnerEmail = "helper@sharik.com";
    
    // تأكد من وجود حساب المساعد للتشات
    let helper = await User.findOne({ email: partnerEmail });
    if (!helper) {
      helper = await User.create({
        username1: "المعلم", username2: "الآلي", email: partnerEmail, password: "NotARealPassword123",
        learnSkills: ["Test"], teachSkills: ["JavaScript"]
      });
    }

    const [userA, userB] = Match.makePair(testEmail, partnerEmail);
    const existing = await Match.findOne({ userA, userB });
    if (!existing) {
        await Match.create({
           userA, userB, initiator: partnerEmail, status: "pending"
        });
    } else {
        await Match.updateOne({ userA, userB }, { status: "pending", initiator: partnerEmail });
    }
    res.json({ success: true, message: "تم إنشاء طلب مطابقة وهمي" });
  } catch (err) {
    res.status(500).json({ error: "خطأ في حقن المطابقة" });
  }
});

// Forgot Password Request (Mock/Demo Logic)
app.post("/api/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email: email?.toLowerCase() });
    if (!user) return res.status(404).json({ error: "البريد غير صحيح" });
    // In real app: Generate token, send email via Nodemailer
    res.json({ success: true, message: "تم إرسال رابط التعيين على البريد بنجاح!" });
  } catch (err) {
    res.status(500).json({ error: "Server Error" });
  }
});

app.get("/api/metrics", authMiddleware, async (req, res) => {
  const latency = {};
  Object.keys(metrics.latency).forEach((key) => {
    const bucket = metrics.latency[key];
    latency[key] = {
      count: bucket.count,
      avgMs: bucket.count ? Math.round((bucket.totalMs / bucket.count) * 100) / 100 : 0,
      maxMs: bucket.maxMs,
    };
  });
  res.json({
    socketEvents: metrics.socketEvents,
    rateLimited: metrics.rateLimited,
    latency,
    storageMode: objectStorage.mode,
  });
});


// ═══════════════════════════════════════════════
// SOCKET.IO - Real-time Chat
// ═══════════════════════════════════════════════
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("UNAUTHORIZED"));
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.id);
    if (!user) return next(new Error("UNAUTHORIZED"));
    socket.user = { id: String(user._id), email: user.email };
    socket.data.joinedChats = new Set();
    socket.data.rl = {};
    next();
  } catch {
    next(new Error("UNAUTHORIZED"));
  }
});

setInterval(() => {
  const latency = {};
  Object.keys(metrics.latency).forEach((key) => {
    const bucket = metrics.latency[key];
    latency[key] = {
      count: bucket.count,
      avgMs: bucket.count ? Math.round((bucket.totalMs / bucket.count) * 100) / 100 : 0,
      maxMs: bucket.maxMs,
    };
  });
  structuredLog("metrics.snapshot", {
    socketEvents: metrics.socketEvents,
    rateLimited: metrics.rateLimited,
    latency,
  });
}, METRICS_LOG_INTERVAL_MS);

io.on("connection", (socket) => {
  console.log("🟢 User connected:", socket.id);
  socket.data.connectionTraceId = genTraceId();
  structuredLog("socket.connected", {
    socketId: socket.id,
    user: socket.user?.email,
    traceId: socket.data.connectionTraceId,
  });

  const ackOk = (ack, traceId, payload = {}) => {
    if (typeof ack === "function") ack({ ok: true, traceId, ...payload });
  };
  const ackErr = (ack, traceId, code, message) => {
    if (typeof ack === "function") ack({ ok: false, traceId, code, message });
  };
  const startEvent = (name, traceId) => {
    trackEvent(name);
    structuredLog("socket.event.start", { eventName: name, socketId: socket.id, user: socket.user?.email, traceId });
    return Date.now();
  };
  const endEvent = (name, startedAt, traceId) => {
    trackLatency(name, Date.now() - startedAt);
    structuredLog("socket.event.end", { eventName: name, traceId, latencyMs: Date.now() - startedAt });
  };

  socket.on("joinChat", async (chatId, ack) => {
    const traceId = genTraceId();
    const startedAt = startEvent("joinChat", traceId);
    if (isRateLimited(socket, "joinChat", 12, 15000)) {
      ackErr(ack, traceId, "RATE_LIMITED", "rate_limited");
      endEvent("joinChat", startedAt, traceId);
      return;
    }
    if (!canAccessChat(socket, chatId)) {
      socket.emit("socketError", { code: "FORBIDDEN_CHAT", message: "غير مسموح بالدخول لهذه الغرفة" });
      ackErr(ack, traceId, "FORBIDDEN_CHAT", "forbidden");
      endEvent("joinChat", startedAt, traceId);
      return;
    }
    socket.join(chatId);
    socket.data.joinedChats.add(chatId);
    console.log(`📌 Socket ${socket.id} joined chat: ${chatId}`);
    const state = await loadWhiteboardState(chatId);
    socket.emit("whiteboardState", {
      chatId,
      snapshot: state.snapshot || null,
      actions: state.actions,
      sessionMeta: state.sessionMeta,
      assets: state.assets,
      recordingLog: state.recordingLog,
    });
    ackOk(ack, traceId);
    endEvent("joinChat", startedAt, traceId);
  });

  socket.on("sendMessage", async (data, ack) => {
    const traceId = genTraceId(data?.traceId);
    const startedAt = startEvent("sendMessage", traceId);
    try {
      if (!data?.chatId || !ensureJoined(socket, data.chatId) || !canAccessChat(socket, data.chatId)) {
        ackErr(ack, traceId, "FORBIDDEN_CHAT", "forbidden");
        endEvent("sendMessage", startedAt, traceId);
        return;
      }
      if (isRateLimited(socket, "sendMessage", 20, 10000)) {
        ackErr(ack, traceId, "RATE_LIMITED", "rate_limited");
        endEvent("sendMessage", startedAt, traceId);
        return;
      }
      if (!data.messageId || typeof data.messageId !== "string") {
        ackErr(ack, traceId, "INVALID_MESSAGE_ID", "invalid_message_id");
        endEvent("sendMessage", startedAt, traceId);
        return;
      }
      let message = await Message.findOne({
        chatId: data.chatId,
        messageId: data.messageId,
      });
      if (!message) {
        message = new Message({
          chatId: data.chatId,
          messageId: data.messageId,
          sender: socket.user.email,
          receiver: data.receiver,
          text: data.text || "",
          attachments: data.attachments || [],
          traceId,
        });
        await message.save();
        io.to(data.chatId).emit("newMessage", message);
      }
      ackOk(ack, traceId, { message });
      endEvent("sendMessage", startedAt, traceId);
    } catch (err) {
      console.log("Socket message error:", err);
      ackErr(ack, traceId, "MESSAGE_SAVE_FAILED", "failed");
      endEvent("sendMessage", startedAt, traceId);
    }
  });

  socket.on("typing", (data) => {
    if (!data?.chatId || !ensureJoined(socket, data.chatId) || !canAccessChat(socket, data.chatId)) return;
    if (isRateLimited(socket, "typing", 40, 10000)) return;
    socket.to(data.chatId).emit("userTyping", { email: data.email });
  });

  socket.on("stopTyping", (data) => {
    if (!data?.chatId || !ensureJoined(socket, data.chatId) || !canAccessChat(socket, data.chatId)) return;
    socket.to(data.chatId).emit("userStopTyping", { email: data.email });
  });

  socket.on("requestWhiteboardState", async ({ chatId, traceId: reqTraceId }, ack) => {
    const traceId = genTraceId(reqTraceId);
    const startedAt = startEvent("requestWhiteboardState", traceId);
    if (!chatId || !ensureJoined(socket, chatId) || !canAccessChat(socket, chatId)) {
      ackErr(ack, traceId, "FORBIDDEN_CHAT", "forbidden");
      endEvent("requestWhiteboardState", startedAt, traceId);
      return;
    }
    if (isRateLimited(socket, "requestWhiteboardState", 25, 10000)) {
      ackErr(ack, traceId, "RATE_LIMITED", "rate_limited");
      endEvent("requestWhiteboardState", startedAt, traceId);
      return;
    }
    const state = await loadWhiteboardState(chatId);
    socket.emit("whiteboardState", {
      chatId,
      snapshot: state.snapshot || null,
      actions: state.actions,
      sessionMeta: state.sessionMeta,
      assets: state.assets,
      recordingLog: state.recordingLog,
    });
    ackOk(ack, traceId);
    endEvent("requestWhiteboardState", startedAt, traceId);
  });

  socket.on("whiteboardAction", async ({ chatId, senderName, action, traceId: reqTraceId }, ack) => {
    const traceId = genTraceId(reqTraceId);
    const startedAt = startEvent("whiteboardAction", traceId);
    if (!chatId || !ensureJoined(socket, chatId) || !canAccessChat(socket, chatId)) {
      ackErr(ack, traceId, "FORBIDDEN_CHAT", "forbidden");
      endEvent("whiteboardAction", startedAt, traceId);
      return;
    }
    if (isRateLimited(socket, "whiteboardAction", 80, 10000)) {
      ackErr(ack, traceId, "RATE_LIMITED", "rate_limited");
      endEvent("whiteboardAction", startedAt, traceId);
      return;
    }
    const safeAction = sanitizeAction(action);
    if (!safeAction) {
      ackErr(ack, traceId, "INVALID_ACTION", "invalid_action");
      endEvent("whiteboardAction", startedAt, traceId);
      return;
    }
    const preState = await loadWhiteboardState(chatId);
    ensureSessionMeta(preState, chatId);
    if (!canUserDraw(preState, socket.user.email)) {
      ackErr(ack, traceId, "DRAW_FORBIDDEN", "draw_forbidden");
      endEvent("whiteboardAction", startedAt, traceId);
      return;
    }
    const enqueued = enqueueChatTask(chatId, async () => {
      const state = await loadWhiteboardState(chatId);
      ensureSessionMeta(state, chatId);
      state.actions.push(safeAction);
      state.redoStack = [];
      appendRecordingEvent(state, "action", socket.user.email, { action: safeAction });
      if (state.actions.length % WHITEBOARD_SNAPSHOT_INTERVAL === 0) {
        state.snapshot = null;
        if (state.actions.length > WHITEBOARD_MAX_ACTIONS) {
          state.actions = state.actions.slice(-WHITEBOARD_MAX_ACTIONS);
        }
      }
      whiteboardStates.set(chatId, state);
      queueWhiteboardPersist(chatId);
      socket.to(chatId).emit("whiteboardAction", {
        chatId,
        sender: socket.user.email,
        senderName,
        action: safeAction,
        traceId,
      });
    });
    if (!enqueued) {
      ackErr(ack, traceId, "OVERLOADED", "queue_overloaded");
      endEvent("whiteboardAction", startedAt, traceId);
      return;
    }
    ackOk(ack, traceId);
    endEvent("whiteboardAction", startedAt, traceId);
  });

  socket.on("whiteboardCommand", async ({ chatId, command, snapshot, traceId: reqTraceId }, ack) => {
    const traceId = genTraceId(reqTraceId);
    const startedAt = startEvent("whiteboardCommand", traceId);
    if (!chatId || !ensureJoined(socket, chatId) || !canAccessChat(socket, chatId)) {
      ackErr(ack, traceId, "FORBIDDEN_CHAT", "forbidden");
      endEvent("whiteboardCommand", startedAt, traceId);
      return;
    }
    if (isRateLimited(socket, "whiteboardCommand", 45, 10000)) {
      ackErr(ack, traceId, "RATE_LIMITED", "rate_limited");
      endEvent("whiteboardCommand", startedAt, traceId);
      return;
    }
    if (!command) {
      ackErr(ack, traceId, "INVALID_COMMAND", "invalid_command");
      endEvent("whiteboardCommand", startedAt, traceId);
      return;
    }
    const enqueued = enqueueChatTask(chatId, async () => {
      const state = await loadWhiteboardState(chatId);

      if (command === "undo" && state.actions.length > 0) {
        state.redoStack.push(state.actions.pop());
      } else if (command === "redo" && state.redoStack.length > 0) {
        state.actions.push(state.redoStack.pop());
      } else if (command === "clear") {
        state.actions = [];
        state.redoStack = [];
        state.snapshot = null;
      } else if (command === "snapshot" && snapshot?.data && snapshot?.mime) {
        if (typeof snapshot.data === "string" && snapshot.data.length < 3_000_000) {
          state.snapshot = {
            mime: snapshot.mime,
            data: snapshot.data,
            updatedAt: new Date(),
          };
          state.actions = [];
          state.redoStack = [];
        }
      }
      appendRecordingEvent(state, `command:${command}`, socket.user.email, { snapshot: command === "snapshot" ? Boolean(snapshot) : false });

      whiteboardStates.set(chatId, state);
      queueWhiteboardPersist(chatId);
      socket.to(chatId).emit("whiteboardCommand", {
        chatId,
        sender: socket.user.email,
        command,
        snapshot: command === "snapshot" ? state.snapshot : undefined,
        traceId,
      });
    });
    if (!enqueued) {
      ackErr(ack, traceId, "OVERLOADED", "queue_overloaded");
      endEvent("whiteboardCommand", startedAt, traceId);
      return;
    }
    ackOk(ack, traceId);
    endEvent("whiteboardCommand", startedAt, traceId);
  });

  socket.on("whiteboardCursor", (payload) => {
    const traceId = genTraceId(payload?.traceId);
    const startedAt = startEvent("whiteboardCursor", traceId);
    if (!payload || !payload.chatId || !ensureJoined(socket, payload.chatId) || !canAccessChat(socket, payload.chatId)) return;
    if (isRateLimited(socket, "whiteboardCursor", 70, 10000)) {
      endEvent("whiteboardCursor", startedAt, traceId);
      return;
    }
    socket.to(payload.chatId).emit("whiteboardCursor", {
      chatId: payload.chatId,
      sender: socket.user.email,
      senderName: payload.senderName,
      point: payload.point,
      traceId,
    });
    endEvent("whiteboardCursor", startedAt, traceId);
  });

  socket.on("whiteboardPointer", (payload) => {
    const traceId = genTraceId(payload?.traceId);
    const startedAt = startEvent("whiteboardPointer", traceId);
    if (!payload || !payload.chatId || !ensureJoined(socket, payload.chatId) || !canAccessChat(socket, payload.chatId)) return;
    if (isRateLimited(socket, "whiteboardPointer", 90, 10000)) {
      endEvent("whiteboardPointer", startedAt, traceId);
      return;
    }
    socket.to(payload.chatId).emit("whiteboardPointer", {
      chatId: payload.chatId,
      sender: socket.user.email,
      senderName: payload.senderName,
      point: payload.point,
      color: payload.color || "#ef4444",
      traceId,
    });
    enqueueChatTask(payload.chatId, async () => {
      const state = await loadWhiteboardState(payload.chatId);
      appendRecordingEvent(state, "pointer", socket.user.email, {
        point: payload.point,
        color: payload.color || "#ef4444",
      });
      whiteboardStates.set(payload.chatId, state);
      queueWhiteboardPersist(payload.chatId);
    });
    endEvent("whiteboardPointer", startedAt, traceId);
  });

  socket.on("whiteboardPresence", async (payload, ack) => {
    const traceId = genTraceId(payload?.traceId);
    const startedAt = startEvent("whiteboardPresence", traceId);
    if (!payload?.chatId || !ensureJoined(socket, payload.chatId) || !canAccessChat(socket, payload.chatId)) {
      ackErr(ack, traceId, "FORBIDDEN_CHAT", "forbidden");
      endEvent("whiteboardPresence", startedAt, traceId);
      return;
    }
    if (isRateLimited(socket, "whiteboardPresence", 60, 10000)) {
      ackErr(ack, traceId, "RATE_LIMITED", "rate_limited");
      endEvent("whiteboardPresence", startedAt, traceId);
      return;
    }
    socket.to(payload.chatId).emit("whiteboardPresence", {
      chatId: payload.chatId,
      sender: socket.user.email,
      senderName: payload.senderName,
      status: payload.status || "viewing",
      traceId,
    });
    ackOk(ack, traceId);
    endEvent("whiteboardPresence", startedAt, traceId);
  });

  socket.on("whiteboardControl", async (payload, ack) => {
    const traceId = genTraceId(payload?.traceId);
    const startedAt = startEvent("whiteboardControl", traceId);
    if (!payload?.chatId || !ensureJoined(socket, payload.chatId) || !canAccessChat(socket, payload.chatId)) {
      ackErr(ack, traceId, "FORBIDDEN_CHAT", "forbidden");
      endEvent("whiteboardControl", startedAt, traceId);
      return;
    }
    const preState = await loadWhiteboardState(payload.chatId);
    ensureSessionMeta(preState, payload.chatId);
    const enqueued = enqueueChatTask(payload.chatId, async () => {
      const state = await loadWhiteboardState(payload.chatId);
      ensureSessionMeta(state, payload.chatId);
      const action = payload.action || "";
      const target = normalizeSessionEmail(payload.targetEmail);
      const approvals = getApprovalState(payload.chatId);

      if (action === "requestRoleMode") {
        const requestId = String(payload.requestId || genTraceId());
        const targetEmail = target || getPeerEmail(payload.chatId, socket.user.email);
        if (!targetEmail) return;
        approvals.role = {
          requestId,
          requester: normalizeSessionEmail(socket.user.email),
          target: targetEmail,
          createdAt: Date.now(),
        };
        io.to(payload.chatId).emit("whiteboardRoleProposal", {
          chatId: payload.chatId,
          requestId,
          requester: socket.user.email,
          requesterName: payload.requesterName || socket.user.email,
          target: targetEmail,
          traceId,
        });
      } else if (action === "respondRoleMode") {
        const req = approvals.role;
        if (!req || req.requestId !== payload.requestId) return;
        if (normalizeSessionEmail(socket.user.email) !== req.target) return;
        if (payload.approved) {
          state.sessionMeta.roleModeActive = true;
          state.sessionMeta.teacher = req.requester;
          state.sessionMeta.learner = req.target;
        } else {
          state.sessionMeta.roleModeActive = false;
          state.sessionMeta.teacher = "";
          state.sessionMeta.learner = "";
        }
        approvals.role = null;
      } else if (action === "requestLock") {
        if (!state.sessionMeta.roleModeActive) return;
        const requestId = String(payload.requestId || genTraceId());
        const targetEmail = target || getPeerEmail(payload.chatId, socket.user.email);
        if (!targetEmail) return;
        approvals.lock = {
          requestId,
          requester: normalizeSessionEmail(socket.user.email),
          target: targetEmail,
          createdAt: Date.now(),
        };
        io.to(payload.chatId).emit("whiteboardLockProposal", {
          chatId: payload.chatId,
          requestId,
          requester: socket.user.email,
          requesterName: payload.requesterName || socket.user.email,
          target: targetEmail,
          durationMs: WHITEBOARD_LOCK_DURATION_MS,
          traceId,
        });
      } else if (action === "respondLock") {
        const req = approvals.lock;
        if (!req || req.requestId !== payload.requestId) return;
        if (normalizeSessionEmail(socket.user.email) !== req.target) return;
        if (payload.approved) {
          state.sessionMeta.boardLocked = true;
          state.sessionMeta.lockExpiresAt = new Date(Date.now() + WHITEBOARD_LOCK_DURATION_MS);
          scheduleLockExpiry(payload.chatId);
        }
        approvals.lock = null;
      } else if (action === "clearRoleMode") {
        if (normalizeSessionEmail(socket.user.email) !== normalizeSessionEmail(state.sessionMeta.teacher)) return;
        state.sessionMeta.roleModeActive = false;
        state.sessionMeta.teacher = "";
        state.sessionMeta.learner = "";
        state.sessionMeta.boardLocked = false;
        state.sessionMeta.lockExpiresAt = null;
        clearLockTimer(payload.chatId);
      } else if (action === "setRole" && target && (payload.role === "teacher" || payload.role === "learner")) {
        state.sessionMeta[payload.role] = target;
      } else if (action === "setPermission" && target) {
        if (!canControlSession(state, socket.user.email)) return;
        const current = state.sessionMeta.permissions[target] || defaultPermission(false);
        state.sessionMeta.permissions[target] = {
          ...current,
          ...payload.permission,
        };
      } else if (action === "lockBoard") {
        if (!canControlSession(state, socket.user.email)) return;
        state.sessionMeta.boardLocked = Boolean(payload.locked);
        state.sessionMeta.lockExpiresAt = state.sessionMeta.boardLocked ? new Date(Date.now() + WHITEBOARD_LOCK_DURATION_MS) : null;
        if (state.sessionMeta.boardLocked) scheduleLockExpiry(payload.chatId);
        else clearLockTimer(payload.chatId);
      } else if (action === "followMode") {
        if (!canControlSession(state, socket.user.email)) return;
        state.sessionMeta.followMode = Boolean(payload.enabled);
      } else if (action === "kick" && target) {
        if (!canControlSession(state, socket.user.email)) return;
        io.to(payload.chatId).emit("whiteboardControl", {
          chatId: payload.chatId,
          action: "kicked",
          targetEmail: target,
          by: socket.user.email,
          traceId,
        });
      } else if (action === "setTemplate") {
        state.sessionMeta.activeTemplate = String(payload.template || "blank");
      }
      appendRecordingEvent(state, "control", socket.user.email, { action, target, payload });
      whiteboardStates.set(payload.chatId, state);
      queueWhiteboardPersist(payload.chatId);
      io.to(payload.chatId).emit("whiteboardSession", {
        chatId: payload.chatId,
        sessionMeta: state.sessionMeta,
        sender: socket.user.email,
        traceId,
      });
    });
    if (!enqueued) {
      ackErr(ack, traceId, "OVERLOADED", "queue_overloaded");
      endEvent("whiteboardControl", startedAt, traceId);
      return;
    }
    ackOk(ack, traceId);
    endEvent("whiteboardControl", startedAt, traceId);
  });

  socket.on("whiteboardAssetUpload", async (payload, ack) => {
    const traceId = genTraceId(payload?.traceId);
    const startedAt = startEvent("whiteboardAssetUpload", traceId);
    if (!payload?.chatId || !ensureJoined(socket, payload.chatId) || !canAccessChat(socket, payload.chatId)) {
      ackErr(ack, traceId, "FORBIDDEN_CHAT", "forbidden");
      endEvent("whiteboardAssetUpload", startedAt, traceId);
      return;
    }
    const preState = await loadWhiteboardState(payload.chatId);
    ensureSessionMeta(preState, payload.chatId);
    const uploadPerm = preState.sessionMeta.permissions?.[normalizeSessionEmail(socket.user.email)]?.canUpload;
    if (uploadPerm === false && !canControlSession(preState, socket.user.email)) {
      ackErr(ack, traceId, "UPLOAD_FORBIDDEN", "upload_forbidden");
      endEvent("whiteboardAssetUpload", startedAt, traceId);
      return;
    }
    const enqueued = enqueueChatTask(payload.chatId, async () => {
      const state = await loadWhiteboardState(payload.chatId);
      ensureSessionMeta(state, payload.chatId);
      const asset = payload.asset || {};
      const safeAsset = {
        id: String(asset.id || `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`),
        type: asset.type === "pdf-page" ? "pdf-page" : "image",
        name: String(asset.name || ""),
        mime: String(asset.mime || ""),
        key: String(asset.key || asset.data || ""),
        data: String(asset.data || asset.key || ""),
        page: Number(asset.page) || 1,
        width: Number(asset.width) || 0,
        height: Number(asset.height) || 0,
        x: Number(asset.x) || 0,
        y: Number(asset.y) || 0,
        rotation: Number(asset.rotation) || 0,
        scaleX: Number(asset.scaleX) || 1,
        scaleY: Number(asset.scaleY) || 1,
        z: Number(asset.z) || 1,
        version: Number(asset.version) || 1,
        createdBy: socket.user.email,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      };
      const existingIdx = state.assets.findIndex((a) => a.id === safeAsset.id);
      if (existingIdx >= 0) state.assets[existingIdx] = { ...state.assets[existingIdx], ...safeAsset };
      else state.assets.push(safeAsset);
      appendRecordingEvent(state, "asset:upload", socket.user.email, { assetId: safeAsset.id, type: safeAsset.type });
      whiteboardStates.set(payload.chatId, state);
      queueWhiteboardPersist(payload.chatId);
      io.to(payload.chatId).emit("whiteboardAssetUpload", {
        chatId: payload.chatId,
        sender: socket.user.email,
        asset: safeAsset,
        traceId,
      });
    });
    if (!enqueued) {
      ackErr(ack, traceId, "OVERLOADED", "queue_overloaded");
      endEvent("whiteboardAssetUpload", startedAt, traceId);
      return;
    }
    ackOk(ack, traceId);
    endEvent("whiteboardAssetUpload", startedAt, traceId);
  });

  socket.on("whiteboardAssetAnnotate", async (payload, ack) => {
    const traceId = genTraceId(payload?.traceId);
    const startedAt = startEvent("whiteboardAssetAnnotate", traceId);
    if (!payload?.chatId || !ensureJoined(socket, payload.chatId) || !canAccessChat(socket, payload.chatId)) {
      ackErr(ack, traceId, "FORBIDDEN_CHAT", "forbidden");
      endEvent("whiteboardAssetAnnotate", startedAt, traceId);
      return;
    }
    socket.to(payload.chatId).emit("whiteboardAssetAnnotate", {
      chatId: payload.chatId,
      sender: socket.user.email,
      annotation: payload.annotation || {},
      traceId,
    });
    ackOk(ack, traceId);
    endEvent("whiteboardAssetAnnotate", startedAt, traceId);
  });

  socket.on("whiteboardAssetUpdate", async (payload, ack) => {
    const traceId = genTraceId(payload?.traceId);
    const startedAt = startEvent("whiteboardAssetUpdate", traceId);
    if (!payload?.chatId || !ensureJoined(socket, payload.chatId) || !canAccessChat(socket, payload.chatId)) {
      ackErr(ack, traceId, "FORBIDDEN_CHAT", "forbidden");
      endEvent("whiteboardAssetUpdate", startedAt, traceId);
      return;
    }
    const enqueued = enqueueChatTask(payload.chatId, async () => {
      const state = await loadWhiteboardState(payload.chatId);
      ensureSessionMeta(state, payload.chatId);
      const idx = state.assets.findIndex((a) => a.id === payload.assetId && !a.deletedAt);
      if (idx < 0) return;
      const current = state.assets[idx];
      const incomingVersion = Number(payload.version) || current.version + 1;
      if (incomingVersion <= Number(current.version || 0)) return;
      state.assets[idx] = {
        ...current,
        x: Number(payload.x ?? current.x) || 0,
        y: Number(payload.y ?? current.y) || 0,
        width: Number(payload.width ?? current.width) || 0,
        height: Number(payload.height ?? current.height) || 0,
        rotation: Number(payload.rotation ?? current.rotation) || 0,
        scaleX: Number(payload.scaleX ?? current.scaleX) || 1,
        scaleY: Number(payload.scaleY ?? current.scaleY) || 1,
        z: Number(payload.z ?? current.z) || 1,
        version: incomingVersion,
        updatedAt: new Date(),
      };
      whiteboardStates.set(payload.chatId, state);
      queueWhiteboardPersist(payload.chatId);
      io.to(payload.chatId).emit("whiteboardAssetUpdate", {
        chatId: payload.chatId,
        asset: state.assets[idx],
        traceId,
      });
    });
    if (!enqueued) {
      ackErr(ack, traceId, "OVERLOADED", "queue_overloaded");
      endEvent("whiteboardAssetUpdate", startedAt, traceId);
      return;
    }
    ackOk(ack, traceId);
    endEvent("whiteboardAssetUpdate", startedAt, traceId);
  });

  socket.on("whiteboardAssetDelete", async (payload, ack) => {
    const traceId = genTraceId(payload?.traceId);
    const startedAt = startEvent("whiteboardAssetDelete", traceId);
    if (!payload?.chatId || !ensureJoined(socket, payload.chatId) || !canAccessChat(socket, payload.chatId)) {
      ackErr(ack, traceId, "FORBIDDEN_CHAT", "forbidden");
      endEvent("whiteboardAssetDelete", startedAt, traceId);
      return;
    }
    const enqueued = enqueueChatTask(payload.chatId, async () => {
      const state = await loadWhiteboardState(payload.chatId);
      ensureSessionMeta(state, payload.chatId);
      state.assets = state.assets.map((asset) =>
        asset.id === payload.assetId ? { ...asset, deletedAt: new Date(), version: Number(asset.version || 1) + 1 } : asset
      );
      whiteboardStates.set(payload.chatId, state);
      queueWhiteboardPersist(payload.chatId);
      io.to(payload.chatId).emit("whiteboardAssetDelete", {
        chatId: payload.chatId,
        assetId: payload.assetId,
        traceId,
      });
    });
    if (!enqueued) {
      ackErr(ack, traceId, "OVERLOADED", "queue_overloaded");
      endEvent("whiteboardAssetDelete", startedAt, traceId);
      return;
    }
    ackOk(ack, traceId);
    endEvent("whiteboardAssetDelete", startedAt, traceId);
  });

  socket.on("whiteboardRecording", async (payload, ack) => {
    const traceId = genTraceId(payload?.traceId);
    const startedAt = startEvent("whiteboardRecording", traceId);
    if (!payload?.chatId || !ensureJoined(socket, payload.chatId) || !canAccessChat(socket, payload.chatId)) {
      ackErr(ack, traceId, "FORBIDDEN_CHAT", "forbidden");
      endEvent("whiteboardRecording", startedAt, traceId);
      return;
    }
    const enqueued = enqueueChatTask(payload.chatId, async () => {
      const state = await loadWhiteboardState(payload.chatId);
      ensureSessionMeta(state, payload.chatId);
      if (!canControlSession(state, socket.user.email)) return;
      const command = payload.command || "";
      if (command === "start") {
        state.sessionMeta.recordingActive = true;
        state.sessionMeta.recordingStartedAt = new Date();
        appendRecordingEvent(state, "recording:start", socket.user.email, {});
      } else if (command === "stop") {
        appendRecordingEvent(state, "recording:stop", socket.user.email, {});
        state.sessionMeta.recordingActive = false;
      } else if (command === "clear") {
        state.recordingLog = [];
      } else if (command === "save") {
        appendRecordingEvent(state, "recording:save", socket.user.email, { total: state.recordingLog.length });
      }
      whiteboardStates.set(payload.chatId, state);
      queueWhiteboardPersist(payload.chatId);
      io.to(payload.chatId).emit("whiteboardRecording", {
        chatId: payload.chatId,
        sender: socket.user.email,
        command,
        sessionMeta: state.sessionMeta,
        recordingLog: state.recordingLog,
        traceId,
      });
    });
    if (!enqueued) {
      ackErr(ack, traceId, "OVERLOADED", "queue_overloaded");
      endEvent("whiteboardRecording", startedAt, traceId);
      return;
    }
    ackOk(ack, traceId);
    endEvent("whiteboardRecording", startedAt, traceId);
  });

  socket.on("webrtcSignal", (payload, ack) => {
    const traceId = genTraceId(payload?.traceId);
    const startedAt = startEvent("webrtcSignal", traceId);
    if (!payload?.chatId || !ensureJoined(socket, payload.chatId) || !canAccessChat(socket, payload.chatId)) {
      ackErr(ack, traceId, "FORBIDDEN_CHAT", "forbidden");
      endEvent("webrtcSignal", startedAt, traceId);
      return;
    }
    if (isRateLimited(socket, "webrtcSignal", 150, 10000)) {
      ackErr(ack, traceId, "RATE_LIMITED", "rate_limited");
      endEvent("webrtcSignal", startedAt, traceId);
      return;
    }
    socket.to(payload.chatId).emit("webrtcSignal", {
      chatId: payload.chatId,
      sender: socket.user.email,
      senderName: payload.senderName,
      signalType: payload.signalType,
      signal: payload.signal,
      muted: payload.muted,
      traceId,
    });
    ackOk(ack, traceId);
    endEvent("webrtcSignal", startedAt, traceId);
  });

  socket.on("screenShareSignal", (payload) => {
    if (!payload?.chatId || !ensureJoined(socket, payload.chatId) || !canAccessChat(socket, payload.chatId)) return;
    socket.to(payload.chatId).emit("screenShareSignal", {
      chatId: payload.chatId,
      sender: socket.user.email,
      senderName: payload.senderName,
      type: payload.type,
      data: payload.data
    });
  });

  socket.on("lessonStart", (payload) => {
    if (!payload?.chatId || !ensureJoined(socket, payload.chatId)) return;
    io.to(payload.chatId).emit("lessonStarted", {
      chatId: payload.chatId,
      senderEmail: socket.user.email,
      senderName: payload.senderName,
      skill: payload.skill
    });
  });

  socket.on("sessionConfirm", (payload) => {
    if (!payload?.chatId || !ensureJoined(socket, payload.chatId) || !canAccessChat(socket, payload.chatId)) return;
    io.to(payload.chatId).emit("sessionConfirmed", {
      chatId: payload.chatId,
      confirmerEmail: socket.user.email,
      senderName: payload.senderName,
      skill: payload.skill
    });
    socket.to(payload.chatId).emit("sessionStartRequest", {
      chatId: payload.chatId,
      senderEmail: socket.user.email,
      senderName: payload.senderName,
      skill: payload.skill
    });
  });

  socket.on("whiteboardCursorLeave", (payload) => {
    const traceId = genTraceId(payload?.traceId);
    const startedAt = startEvent("whiteboardCursorLeave", traceId);
    if (!payload || !payload.chatId || !ensureJoined(socket, payload.chatId) || !canAccessChat(socket, payload.chatId)) return;
    socket.to(payload.chatId).emit("whiteboardCursorLeave", {
      chatId: payload.chatId,
      sender: socket.user.email,
      traceId,
    });
    endEvent("whiteboardCursorLeave", startedAt, traceId);
  });

  // ═══════════════════════════════════════════════
  // Code Editor Events
  // ═══════════════════════════════════════════════
  socket.on("codeEditorJoin", async (payload, ack) => {
    const traceId = genTraceId(payload?.traceId);
    if (!payload?.chatId || !ensureJoined(socket, payload.chatId) || !canAccessChat(socket, payload.chatId)) return;
    const state = await loadCodeEditorState(payload.chatId);
    socket.emit("codeEditorState", {
      chatId: payload.chatId,
      content: state.content,
      language: state.language,
      revision: state.revision,
      traceId,
    });
    ackOk(ack, traceId);
  });

  socket.on("codeEditorSync", async (payload) => {
    if (!payload?.chatId || !ensureJoined(socket, payload.chatId) || !canAccessChat(socket, payload.chatId)) return;
    if (isRateLimited(socket, "codeEditorSync", 40, 1000)) return; // rate limit per sec
    const state = await loadCodeEditorState(payload.chatId);
    state.content = payload.content || state.content;
    state.revision = Math.max(state.revision, payload.revision || 0);
    codeEditorStates.set(payload.chatId, state);
    
    socket.to(payload.chatId).emit("codeEditorSync", {
      chatId: payload.chatId,
      sender: socket.user.email,
      content: state.content,
      revision: state.revision,
    });
  });

  socket.on("codeEditorSave", async (payload) => {
    if (!payload?.chatId || !ensureJoined(socket, payload.chatId) || !canAccessChat(socket, payload.chatId)) return;
    const state = await loadCodeEditorState(payload.chatId);
    state.content = payload.content || state.content;
    state.revision = Math.max(state.revision, payload.revision || 0);
    codeEditorStates.set(payload.chatId, state);
    queueCodeEditorPersist(payload.chatId);
    socket.emit("codeEditorSaved", { chatId: payload.chatId });
    socket.to(payload.chatId).emit("codeEditorSaved", { chatId: payload.chatId });
  });

  socket.on("codeEditorTyping", (payload) => {
    if (!payload?.chatId || !ensureJoined(socket, payload.chatId) || !canAccessChat(socket, payload.chatId)) return;
    socket.to(payload.chatId).emit("codeEditorTyping", {
      chatId: payload.chatId,
      sender: socket.user.email,
      typing: payload.typing,
    });
  });

  socket.on("codeEditorCursor", (payload) => {
    if (!payload?.chatId || !ensureJoined(socket, payload.chatId) || !canAccessChat(socket, payload.chatId)) return;
    socket.to(payload.chatId).emit("codeEditorCursor", {
      chatId: payload.chatId,
      sender: socket.user.email,
      position: payload.position,
    });
  });

  socket.on("codeEditorLanguage", async (payload) => {
    if (!payload?.chatId || !ensureJoined(socket, payload.chatId) || !canAccessChat(socket, payload.chatId)) return;
    const state = await loadCodeEditorState(payload.chatId);
    state.language = payload.language || state.language;
    codeEditorStates.set(payload.chatId, state);
    queueCodeEditorPersist(payload.chatId);
    socket.to(payload.chatId).emit("codeEditorLanguage", {
      chatId: payload.chatId,
      sender: socket.user.email,
      language: state.language,
    });
  });

  socket.on("codeEditorLeave", (payload) => {
    if (!payload?.chatId) return;
  });

  socket.on("disconnect", () => {
    if (socket.data.joinedChats && socket.user?.email) {
      socket.data.joinedChats.forEach((chatId) => {
        socket.to(chatId).emit("whiteboardCursorLeave", { chatId, sender: socket.user.email });
        // Emit offline event silently to peers (to handle lesson interruptions or chat offline states)
        socket.to(chatId).emit("peerDisconnected", { chatId, sender: socket.user.email });
      });
    }
    console.log("🔴 User disconnected:", socket.id);
  });
});

// ═══════════════════════════════════════════════
// MongoDB Connection & Server Start
// ═══════════════════════════════════════════════
initRedisAdapterIfEnabled();
// Start server first so Railway doesn't timeout
server.listen(port, "0.0.0.0", () => {
  console.log(`🚀 Sharik server running on port ${port}`);
});

// الاتصال بـ MongoDB من متغيرات البيئة (.env) — الـ URI مش مكشوفة في الكود
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    console.log("✅ Connected to MongoDB");
  })
  .catch((err) => {
    console.error("❌ MongoDB Connection Error:", err.message);
  });
