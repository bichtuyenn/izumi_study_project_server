const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 8787;
const CLIENT_DIR = path.join(__dirname, "..", "client");
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "db.json");
const STUDY_KEYS = [
  "bjtProgress", "n3Progress", "kanjiProgress",
  "bjtDaily", "n3Daily", "kanjiDaily",
  "bjtMinutes", "n3Minutes", "kanjiMinutes",
  "bjtStudyMode", "n3StudyMode", "kanjiStudyMode",
  "bjtGamePick", "n3GamePick", "kanjiGamePick",
  "bjtGameCount", "n3GameCount", "kanjiGameCount",
  "bjtGameFrom", "n3GameFrom", "kanjiGameFrom",
  "bjtGameTo", "n3GameTo", "kanjiGameTo",
  "bjtEnrolled", "n3Enrolled", "kanjiEnrolled",
  "studyHistory", "dailyStreak", "grammarProgress", "learnedItems", "hardReminders"
];
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString("hex");
}
function randomId(prefix) {
  return prefix + crypto.randomBytes(8).toString("hex");
}
function validUsername(name) {
  return /^[a-zA-Z0-9_]{3,20}$/.test(name);
}
function validNick(nick) {
  const chars = [...String(nick || "").trim()];
  return chars.length >= 2 && chars.length <= 24;
}
function validPass(password) {
  return String(password || "").length >= 6;
}
function parseMaybe(value) {
  if (value == null) return null;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}
function hasLearning(study) {
  if (!study) return false;
  const history = parseMaybe(study.studyHistory);
  if (Array.isArray(history) && history.length) return true;
  for (const key of ["bjtProgress", "n3Progress", "kanjiProgress", "grammarProgress", "learnedItems"]) {
    const value = parseMaybe(study[key]);
    if (value && typeof value === "object" && Object.keys(value).length) return true;
  }
  return false;
}
function asHistory(value) {
  const data = parseMaybe(value);
  return Array.isArray(data) ? data : [];
}
function historySignature(item) {
  if (!item || typeof item !== "object") return "";
  const words = Array.isArray(item.items) ? item.items.map(entry => entry && (entry.id + ":" + (entry.term || ""))).join(",") : "";
  return [item.date, item.time, item.kind, item.type, item.count, item.score, words].join("|");
}
function mergeHistoryLists(prev, next) {
  const seen = new Set();
  const out = [];
  for (const item of [...asHistory(next), ...asHistory(prev)]) {
    if (!item || typeof item !== "object") continue;
    const sig = historySignature(item);
    if (!sig || seen.has(sig)) continue;
    seen.add(sig);
    out.push(item);
  }
  out.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")) || String(b.time || "").localeCompare(String(a.time || "")));
  return out.slice(0, 300);
}
function studyStats(study) {
  const saved = study || {};
  const history = parseMaybe(saved.studyHistory);
  const list = Array.isArray(history) ? history : [];
  let learned = 0;
  const catalog = parseMaybe(saved.learnedItems);
  if (catalog && typeof catalog === "object" && !Array.isArray(catalog) && Object.keys(catalog).length) {
    learned = Object.keys(catalog).length;
  } else {
    for (const key of ["bjtProgress", "n3Progress", "kanjiProgress"]) {
      const value = parseMaybe(saved[key]);
      if (value && typeof value === "object") learned += Object.keys(value).length;
    }
  }
  const streak = parseMaybe(saved.dailyStreak) || {};
  return { learned, streak: streak.current || 0, historyCount: list.length, history: list };
}
function cleanStudy(input) {
  const study = {};
  if (!input || typeof input !== "object") return study;
  for (const key of STUDY_KEYS) {
    if (input[key] == null) continue;
    study[key] = typeof input[key] === "string" ? input[key] : JSON.stringify(input[key]);
  }
  return study;
}
function publicUser(user, study, withHistory) {
  const stats = studyStats(study);
  const row = {
    id: user.id,
    username: user.username,
    nick: user.nick,
    role: user.role,
    active: user.active !== false,
    tempPass: !!user.tempPass,
    createdAt: user.createdAt,
    learned: stats.learned,
    streak: stats.streak,
    historyCount: stats.historyCount
  };
  if (withHistory) row.history = stats.history;
  return row;
}
function checkPassword(user, password) {
  const actual = Buffer.from(hashPassword(password, user.salt), "hex");
  const expected = Buffer.from(user.pass, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
function emptyDb() {
  const salt = crypto.randomBytes(16).toString("hex");
  return {
    legacyClaimed: false,
    users: [{
      id: randomId("u"),
      username: "admin",
      nick: "Quản trị",
      salt,
      pass: hashPassword("admin123", salt),
      role: "admin",
      active: true,
      tempPass: true,
      createdAt: new Date().toISOString()
    }],
    sessions: [],
    study: {}
  };
}
function loadDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    const db = emptyDb();
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
    return db;
  }
  const db = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  db.users ||= [];
  db.sessions ||= [];
  db.study ||= {};
  db.legacyClaimed = !!db.legacyClaimed;
  return db;
}
function saveDb(db) {
  const tmp = DB_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_PATH);
}
function activeAdmins(db, exceptId) {
  return db.users.filter(user => user.role === "admin" && user.active !== false && user.id !== exceptId).length;
}
function userByToken(db, token) {
  if (!token) return null;
  const session = db.sessions.find(item => item.token === token);
  if (!session) return null;
  return db.users.find(user => user.id === session.userId) || null;
}
function tokenFrom(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > 2_000_000) {
        reject(Object.assign(new Error("Dữ liệu quá lớn."), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(Object.assign(new Error("JSON không hợp lệ."), { status: 400 })); }
    });
    req.on("error", reject);
  });
}
function corsHeaders(req) {
  const allow = (process.env.CLIENT_ORIGIN || "*").trim();
  const headers = {
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Max-Age": "86400"
  };
  if (!allow || allow === "*") {
    headers["Access-Control-Allow-Origin"] = "*";
    return headers;
  }
  const list = allow.split(",").map(item => item.trim()).filter(Boolean);
  const origin = req.headers.origin || "";
  if (list.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers.Vary = "Origin";
  }
  return headers;
}
function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, Object.assign({
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  }, res._cors || { "Access-Control-Allow-Origin": "*" }));
  res.end(body);
}
function requireUser(db, req, res) {
  const user = userByToken(db, tokenFrom(req));
  if (!user) {
    send(res, 401, { error: "Bạn cần đăng nhập." });
    return null;
  }
  if (user.active === false) {
    send(res, 403, { error: "Tài khoản đã bị khóa." });
    return null;
  }
  return user;
}
function requireAdmin(db, req, res) {
  const user = requireUser(db, req, res);
  if (!user) return null;
  if (user.role !== "admin") {
    send(res, 403, { error: "Chỉ quản trị viên được vào trang này." });
    return null;
  }
  return user;
}
function applyMigrate(db, user, migrate) {
  if (!migrate || db.legacyClaimed || hasLearning(db.study[user.id])) return false;
  const study = cleanStudy(migrate);
  if (!hasLearning(study)) return false;
  db.study[user.id] = study;
  db.legacyClaimed = true;
  return true;
}
function createSession(db, user) {
  const token = crypto.randomBytes(24).toString("hex");
  db.sessions.push({ token, userId: user.id, createdAt: new Date().toISOString() });
  return token;
}

async function handleApi(req, res, url) {
  const db = loadDb();
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && url.pathname === "/api/health") {
    const admin = db.users.find(user => user.username === "admin");
    return send(res, 200, { ok: true, defaultAdmin: !!(admin && admin.tempPass) });
  }

  if (req.method === "POST" && url.pathname === "/api/register") {
    return send(res, 403, { error: "Đăng ký đã đóng. Liên hệ quản trị viên để được cấp tài khoản." });
  }

  if (req.method === "POST" && url.pathname === "/api/login") {
    const body = await readBody(req);
    const username = String(body.username || "").trim().toLowerCase();
    const password = String(body.password || "");
    const user = db.users.find(item => item.username === username);
    if (!user || !checkPassword(user, password)) return send(res, 401, { error: "Sai tên đăng nhập hoặc mật khẩu." });
    if (user.active === false) return send(res, 403, { error: "Tài khoản đã bị khóa. Hãy liên hệ quản trị viên." });
    const migrated = applyMigrate(db, user, body.migrate);
    const token = createSession(db, user);
    saveDb(db);
    return send(res, 200, { token, user: publicUser(user, db.study[user.id]), migrated, legacyClaimed: db.legacyClaimed });
  }

  if (req.method === "POST" && url.pathname === "/api/logout") {
    const token = tokenFrom(req);
    db.sessions = db.sessions.filter(session => session.token !== token);
    saveDb(db);
    return send(res, 200, { ok: true });
  }

  if (url.pathname === "/api/me" && req.method === "GET") {
    const user = requireUser(db, req, res);
    if (!user) return;
    return send(res, 200, { user: publicUser(user, db.study[user.id]) });
  }

  if (url.pathname === "/api/me" && req.method === "PATCH") {
    const user = requireUser(db, req, res);
    if (!user) return;
    const body = await readBody(req);
    if (body.nick != null) {
      if (!validNick(body.nick)) return send(res, 400, { error: "Nickname cần từ 2 đến 24 ký tự." });
      user.nick = String(body.nick).trim();
    }
    if (body.newPassword != null) {
      if (!checkPassword(user, body.currentPassword || "")) return send(res, 400, { error: "Mật khẩu hiện tại chưa đúng." });
      if (!validPass(body.newPassword)) return send(res, 400, { error: "Mật khẩu cần ít nhất 6 ký tự." });
      if (String(body.currentPassword) === String(body.newPassword)) return send(res, 400, { error: "Mật khẩu mới cần khác mật khẩu hiện tại." });
      user.salt = crypto.randomBytes(16).toString("hex");
      user.pass = hashPassword(body.newPassword, user.salt);
      user.tempPass = false;
    }
    saveDb(db);
    return send(res, 200, { user: publicUser(user, db.study[user.id]) });
  }

  if (url.pathname === "/api/me/study" && req.method === "GET") {
    const user = requireUser(db, req, res);
    if (!user) return;
    return send(res, 200, { user: publicUser(user, db.study[user.id]), study: db.study[user.id] || {} });
  }

  if (url.pathname === "/api/me/study" && req.method === "PUT") {
    const user = requireUser(db, req, res);
    if (!user) return;
    const body = await readBody(req);
    const prev = db.study[user.id] || {};
    const incoming = cleanStudy(body.study);
    const merged = mergeHistoryLists(prev.studyHistory, incoming.studyHistory);
    if (merged.length) incoming.studyHistory = JSON.stringify(merged);
    else delete incoming.studyHistory;
    db.study[user.id] = Object.assign({}, prev, incoming);
    saveDb(db);
    return send(res, 200, { ok: true });
  }

  if (req.method === "GET" && url.pathname === "/api/admin/users") {
    const admin = requireAdmin(db, req, res);
    if (!admin) return;
    const users = db.users
      .slice()
      .sort((a, b) => (a.role === b.role ? 0 : a.role === "admin" ? -1 : 1) || String(a.createdAt).localeCompare(String(b.createdAt)))
      .map(user => publicUser(user, db.study[user.id], true));
    return send(res, 200, { users });
  }

  if (req.method === "POST" && url.pathname === "/api/admin/users") {
    const admin = requireAdmin(db, req, res);
    if (!admin) return;
    const body = await readBody(req);
    const username = String(body.username || "").trim().toLowerCase();
    const nick = String(body.nick || "");
    const password = String(body.password || "");
    if (!validUsername(username)) return send(res, 400, { error: "Tên đăng nhập 3–20 ký tự, chỉ gồm chữ, số và dấu _." });
    if (!validNick(nick)) return send(res, 400, { error: "Nickname cần từ 2 đến 24 ký tự." });
    if (!validPass(password)) return send(res, 400, { error: "Mật khẩu cần ít nhất 6 ký tự." });
    if (body.role != null && body.role !== "admin" && body.role !== "student") {
      return send(res, 400, { error: "Vai trò không hợp lệ." });
    }
    if (db.users.some(user => user.username === username)) return send(res, 409, { error: "Tên đăng nhập này đã được dùng." });
    const salt = crypto.randomBytes(16).toString("hex");
    const user = {
      id: randomId("u"),
      username,
      nick: nick.trim(),
      salt,
      pass: hashPassword(password, salt),
      role: body.role === "admin" ? "admin" : "student",
      active: true,
      tempPass: false,
      createdAt: new Date().toISOString()
    };
    db.users.push(user);
    saveDb(db);
    return send(res, 201, { user: publicUser(user, db.study[user.id]) });
  }

  if (parts[0] === "api" && parts[1] === "admin" && parts[2] === "users" && parts[3]) {
    const admin = requireAdmin(db, req, res);
    if (!admin) return;
    const user = db.users.find(item => item.id === decodeURIComponent(parts[3]));
    if (!user) return send(res, 404, { error: "Không tìm thấy tài khoản." });

    if (req.method === "DELETE") {
      if (user.id === admin.id) return send(res, 400, { error: "Không thể xóa tài khoản đang đăng nhập." });
      if (user.role === "admin" && activeAdmins(db, user.id) === 0) return send(res, 400, { error: "Không thể xóa quản trị viên cuối cùng." });
      db.users = db.users.filter(item => item.id !== user.id);
      db.sessions = db.sessions.filter(session => session.userId !== user.id);
      delete db.study[user.id];
      saveDb(db);
      return send(res, 200, { ok: true });
    }

    if (req.method === "PATCH") {
      const body = await readBody(req);
      if (body.nick != null) {
        if (!validNick(body.nick)) return send(res, 400, { error: "Nickname cần từ 2 đến 24 ký tự." });
        user.nick = String(body.nick).trim();
      }
      if (body.password != null) {
        if (!validPass(body.password)) return send(res, 400, { error: "Mật khẩu cần ít nhất 6 ký tự." });
        user.salt = crypto.randomBytes(16).toString("hex");
        user.pass = hashPassword(body.password, user.salt);
        if (user.id === admin.id) user.tempPass = false;
      }
      if (body.role != null) {
        if (body.role !== "admin" && body.role !== "student") return send(res, 400, { error: "Vai trò không hợp lệ." });
        if (body.role === "student" && user.role === "admin" && activeAdmins(db, user.id) === 0) {
          return send(res, 400, { error: "Cần giữ ít nhất một quản trị viên." });
        }
        user.role = body.role;
      }
      if (body.active != null) {
        if (user.id === admin.id) return send(res, 400, { error: "Không thể khóa tài khoản đang đăng nhập." });
        const next = !!body.active;
        if (!next && user.role === "admin" && user.active !== false && activeAdmins(db, user.id) === 0) {
          return send(res, 400, { error: "Không thể khóa quản trị viên cuối cùng." });
        }
        user.active = next;
        if (!next) db.sessions = db.sessions.filter(session => session.userId !== user.id);
      }
      saveDb(db);
      return send(res, 200, { user: publicUser(user, db.study[user.id], true) });
    }
  }

  send(res, 404, { error: "Không tìm thấy API." });
}

function serveStatic(req, res, url) {
  if (!fs.existsSync(CLIENT_DIR)) {
    const headers = Object.assign({ "Content-Type": "text/plain; charset=utf-8" }, res._cors || {});
    if (url.pathname === "/" || url.pathname === "/home.html") {
      res.writeHead(200, headers);
      res.end("Izumi API đang chạy.");
      return;
    }
    res.writeHead(404, headers);
    res.end("Không tìm thấy trang.");
    return;
  }
  const requested = decodeURIComponent(url.pathname);
  const relative = requested === "/" ? "home.html" : requested.replace(/^\/+/, "");
  const root = path.resolve(CLIENT_DIR);
  const filePath = path.resolve(root, relative);
  if (filePath !== root && !filePath.startsWith(root + path.sep)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.stat(filePath, (error, stat) => {
    if (error || !stat.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Không tìm thấy trang.");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  res._cors = corsHeaders(req);
  if (req.method === "OPTIONS") {
    res.writeHead(204, res._cors);
    res.end();
    return;
  }
  try {
    if (url.pathname.startsWith("/api/")) await handleApi(req, res, url);
    else serveStatic(req, res, url);
  } catch (error) {
    if (!res.headersSent) send(res, error.status || 500, { error: error.message || "Lỗi máy chủ." });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  loadDb();
  console.log(`Izumi API listening on port ${PORT}`);
});
