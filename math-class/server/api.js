// REST API: 로그인, 관리자, 학급/학생, 문제 세트, 수업
import express from "express";
import multer from "multer";
import path from "node:path";
import crypto from "node:crypto";
import { q, tx, newId, now, hashPw, checkPw, currentSchoolYear, UPLOAD_DIR } from "./db.js";
import { parseHwpx } from "./hwpx.js";
import { live } from "./realtime.js";

export const api = express.Router();
api.use(express.json({ limit: "2mb" }));

const TOKEN_TTL = 1000 * 60 * 60 * 24 * 30; // 30일

// ---------- 업로드
const IMG_EXT = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif" };
const imageUpload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, newId(16) + (IMG_EXT[file.mimetype] || ".png")),
  }),
  limits: { fileSize: 15 * 1024 * 1024, files: 60 },
  fileFilter: (req, file, cb) => cb(null, !!IMG_EXT[file.mimetype]),
});
const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024 } });

// ---------- 공통
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };
const h = (fn) => async (req, res) => {
  try {
    const r = await fn(req, res);
    if (!res.headersSent) res.json(r ?? { ok: true });
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    res.status(e.status || 500).json({ error: e instanceof HttpError ? e.message : "서버 오류가 발생했습니다." });
  }
};

export function userFromToken(token) {
  if (!token) return null;
  const t = q.get("SELECT * FROM auth_tokens WHERE token = ?", token);
  if (!t || now() - t.created_at > TOKEN_TTL) return null;
  if (t.kind === "teacher") {
    const u = q.get("SELECT id, login_id, name, is_admin FROM teachers WHERE id = ?", t.user_id);
    return u && { kind: "teacher", ...u };
  }
  const s = q.get(
    `SELECT s.id, s.student_no, s.name, s.class_id, c.name AS class_name
     FROM students s JOIN classes c ON c.id = s.class_id WHERE s.id = ?`, t.user_id);
  return s && { kind: "student", ...s };
}

function auth(kind) {
  return (req, res, next) => {
    const token = (req.headers.authorization || "").replace(/^Bearer /, "");
    const u = userFromToken(token);
    if (!u || (kind && u.kind !== kind)) return res.status(401).json({ error: "로그인이 필요합니다." });
    req.user = u;
    req.token = token;
    next();
  };
}
const teacher = auth("teacher");
const student = auth("student");
const admin = [teacher, (req, res, next) => (req.user.is_admin ? next() : res.status(403).json({ error: "관리자만 가능합니다." }))];

function issueToken(kind, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  q.run("INSERT INTO auth_tokens (token, kind, user_id, created_at) VALUES (?,?,?,?)", token, kind, userId, now());
  return token;
}

// 4자리 비밀번호 무차별 대입 방지: 같은 IP+아이디 10분에 10회
const attempts = new Map();
function throttle(key) {
  const t = now();
  const a = (attempts.get(key) || []).filter((x) => t - x < 10 * 60 * 1000);
  if (a.length >= 10) fail(429, "로그인 시도가 너무 많습니다. 10분 후 다시 시도하세요.");
  a.push(t);
  attempts.set(key, a);
}

const pin4 = () => String(crypto.randomInt(0, 10000)).padStart(4, "0");

function canAccessClass(user, classId) {
  if (user.is_admin) return true;
  return !!q.get("SELECT 1 FROM class_teachers WHERE class_id = ? AND teacher_id = ?", classId, user.id);
}
function requireClass(user, classId) {
  const c = q.get("SELECT * FROM classes WHERE id = ?", classId);
  if (!c) fail(404, "학급을 찾을 수 없습니다.");
  if (!canAccessClass(user, classId)) fail(403, "담당 학급이 아닙니다.");
  return c;
}
function requireSet(user, setId, { write = false } = {}) {
  const s = q.get("SELECT * FROM problem_sets WHERE id = ?", setId);
  if (!s) fail(404, "문제 세트를 찾을 수 없습니다.");
  const mine = s.owner_id === user.id;
  if (write && !mine) fail(403, "내 문제 세트만 수정할 수 있습니다. (복사해서 사용하세요)");
  if (!write && !mine && !s.shared && !user.is_admin) fail(403, "공유되지 않은 문제 세트입니다.");
  return s;
}
export function canAccessLesson(user, lessonId) {
  const l = q.get("SELECT * FROM lessons WHERE id = ?", lessonId);
  if (!l) return null;
  if (l.teacher_id === user.id || canAccessClass(user, l.class_id)) return l;
  return null;
}
function requireLesson(user, lessonId) {
  const l = canAccessLesson(user, lessonId);
  if (!l) fail(404, "수업을 찾을 수 없습니다.");
  return l;
}

export function lessonProblems(lessonId) {
  return q.all(
    `SELECT p.id, p.label, p.kind, p.image, p.body, p.answer, ps.title AS set_title
     FROM lesson_problems lp JOIN problems p ON p.id = lp.problem_id
     JOIN problem_sets ps ON ps.id = p.set_id
     WHERE lp.lesson_id = ? ORDER BY lp.ord`, lessonId);
}
// 학생에게는 정답을 보내지 않음
export const publicProblem = ({ answer, ...p }) => p;

// ================= 로그인 =================
api.post("/login/teacher", h((req) => {
  const { loginId, password } = req.body || {};
  throttle(`t:${req.ip}:${loginId}`);
  const t = q.get("SELECT * FROM teachers WHERE login_id = ?", String(loginId || "").trim());
  if (!t || !checkPw(password, t.pw_hash)) fail(401, "아이디 또는 비밀번호가 맞지 않습니다.");
  return { token: issueToken("teacher", t.id), user: { kind: "teacher", id: t.id, name: t.name, login_id: t.login_id, is_admin: !!t.is_admin } };
}));

api.post("/login/student", h((req) => {
  const { studentNo, password } = req.body || {};
  const no = String(studentNo || "").trim();
  throttle(`s:${req.ip}:${no}`);
  const s = q.get("SELECT * FROM students WHERE school_year = ? AND student_no = ?", currentSchoolYear(), no);
  if (!s || !checkPw(password, s.pw_hash)) fail(401, "학번 또는 비밀번호가 맞지 않습니다.");
  const token = issueToken("student", s.id);
  return { token, user: userFromToken(token) };
}));

api.post("/logout", auth(), h((req) => { q.run("DELETE FROM auth_tokens WHERE token = ?", req.token); }));
api.get("/me", auth(), h((req) => ({ user: req.user })));

api.post("/me/password", teacher, h((req) => {
  const { oldPassword, newPassword } = req.body || {};
  const t = q.get("SELECT * FROM teachers WHERE id = ?", req.user.id);
  if (!checkPw(oldPassword, t.pw_hash)) fail(400, "현재 비밀번호가 맞지 않습니다.");
  if (!newPassword || String(newPassword).length < 6) fail(400, "새 비밀번호는 6자 이상이어야 합니다.");
  q.run("UPDATE teachers SET pw_hash = ? WHERE id = ?", hashPw(newPassword), t.id);
}));

// ================= 관리자: 교사 계정 =================
api.get("/admin/teachers", admin, h(() => ({
  teachers: q.all("SELECT id, login_id, name, is_admin, created_at FROM teachers ORDER BY created_at"),
})));
api.post("/admin/teachers", admin, h((req) => {
  const { loginId, name, password } = req.body || {};
  if (!loginId || !name || !password) fail(400, "아이디, 이름, 비밀번호를 모두 입력하세요.");
  if (q.get("SELECT 1 FROM teachers WHERE login_id = ?", loginId)) fail(400, "이미 있는 아이디입니다.");
  const id = newId();
  q.run("INSERT INTO teachers (id, login_id, name, pw_hash, is_admin, created_at) VALUES (?,?,?,?,0,?)",
    id, String(loginId).trim(), String(name).trim(), hashPw(password), now());
  return { id };
}));
api.post("/admin/teachers/:id/password", admin, h((req) => {
  const { password } = req.body || {};
  if (!password || String(password).length < 6) fail(400, "비밀번호는 6자 이상이어야 합니다.");
  q.run("UPDATE teachers SET pw_hash = ? WHERE id = ?", hashPw(password), req.params.id);
  q.run("DELETE FROM auth_tokens WHERE kind='teacher' AND user_id = ?", req.params.id);
}));

// ================= 학급 / 학생 =================
api.get("/classes", teacher, h((req) => ({
  schoolYear: currentSchoolYear(),
  classes: q.all(
    `SELECT c.*, (SELECT COUNT(*) FROM students s WHERE s.class_id = c.id) AS student_count,
       (SELECT GROUP_CONCAT(t.name, ', ') FROM class_teachers ct2 JOIN teachers t ON t.id = ct2.teacher_id WHERE ct2.class_id = c.id) AS teacher_names,
       (SELECT l.id FROM lessons l WHERE l.class_id = c.id AND l.status = 'live') AS live_lesson_id
     FROM classes c JOIN class_teachers ct ON ct.class_id = c.id
     WHERE ct.teacher_id = ? ORDER BY c.school_year DESC, c.grade, c.class_no`, req.user.id),
})));

// 같은 학년도·학년·반이 이미 있으면 그 학급의 담당 교사로 합류 (여러 교사가 한 반 담당)
api.post("/classes", teacher, h((req) => {
  const grade = parseInt(req.body?.grade, 10), classNo = parseInt(req.body?.classNo, 10);
  const year = parseInt(req.body?.schoolYear, 10) || currentSchoolYear();
  if (!(grade >= 1 && grade <= 6) || !(classNo >= 1 && classNo <= 30)) fail(400, "학년과 반을 확인하세요.");
  let c = q.get("SELECT * FROM classes WHERE school_year = ? AND grade = ? AND class_no = ?", year, grade, classNo);
  let joined = false;
  if (!c) {
    const id = newId();
    q.run("INSERT INTO classes (id, school_year, grade, class_no, name, created_by, created_at) VALUES (?,?,?,?,?,?,?)",
      id, year, grade, classNo, `${grade}학년 ${classNo}반`, req.user.id, now());
    c = { id };
  } else joined = true;
  q.run("INSERT OR IGNORE INTO class_teachers (class_id, teacher_id) VALUES (?,?)", c.id, req.user.id);
  return { id: c.id, joined };
}));

api.get("/classes/:id", teacher, h((req) => {
  const c = requireClass(req.user, req.params.id);
  return {
    class: c,
    teachers: q.all("SELECT t.id, t.name FROM class_teachers ct JOIN teachers t ON t.id = ct.teacher_id WHERE ct.class_id = ?", c.id),
    students: q.all("SELECT id, student_no, name FROM students WHERE class_id = ? ORDER BY student_no", c.id),
    lessons: q.all(
      `SELECT l.id, l.title, l.status, l.started_at, l.ended_at, t.name AS teacher_name
       FROM lessons l JOIN teachers t ON t.id = l.teacher_id WHERE l.class_id = ? ORDER BY l.started_at DESC LIMIT 50`, c.id),
  };
}));

api.delete("/classes/:id/me", teacher, h((req) => {
  requireClass(req.user, req.params.id);
  q.run("DELETE FROM class_teachers WHERE class_id = ? AND teacher_id = ?", req.params.id, req.user.id);
}));

// 명단 붙여넣기: 한 줄에 "학번 이름 [비밀번호]" (탭/쉼표/공백 구분, 엑셀 복사 가능)
api.post("/classes/:id/students", teacher, h((req) => {
  const c = requireClass(req.user, req.params.id);
  const rows = String(req.body?.rows || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const created = [], updated = [], errors = [];
  tx(() => {
    for (const line of rows) {
      const parts = line.split(/[\t,]+|\s+/).filter(Boolean);
      const [no, name, pw] = parts;
      if (!/^\d{3,8}$/.test(no || "") || !name) { errors.push(`형식 오류: ${line}`); continue; }
      const exists = q.get("SELECT * FROM students WHERE school_year = ? AND student_no = ?", c.school_year, no);
      if (exists && exists.class_id !== c.id) { errors.push(`${no}: 다른 학급(${exists.class_id})에 이미 등록됨`); continue; }
      const password = pw && /^\d{4}$/.test(pw) ? pw : null;
      if (exists) {
        q.run("UPDATE students SET name = ? WHERE id = ?", name, exists.id);
        if (password) q.run("UPDATE students SET pw_hash = ? WHERE id = ?", hashPw(password), exists.id);
        updated.push({ student_no: no, name, password });
      } else {
        const p = password || pin4();
        q.run("INSERT INTO students (id, class_id, school_year, student_no, name, pw_hash, created_at) VALUES (?,?,?,?,?,?,?)",
          newId(), c.id, c.school_year, no, name, hashPw(p), now());
        created.push({ student_no: no, name, password: p });
      }
    }
  });
  return { created, updated, errors };
}));

function requireStudentOfMyClass(user, studentId) {
  const s = q.get("SELECT * FROM students WHERE id = ?", studentId);
  if (!s) fail(404, "학생을 찾을 수 없습니다.");
  requireClass(user, s.class_id);
  return s;
}
api.post("/students/:id/reset", teacher, h((req) => {
  const s = requireStudentOfMyClass(req.user, req.params.id);
  const p = pin4();
  q.run("UPDATE students SET pw_hash = ? WHERE id = ?", hashPw(p), s.id);
  q.run("DELETE FROM auth_tokens WHERE kind='student' AND user_id = ?", s.id);
  return { student_no: s.student_no, name: s.name, password: p };
}));
api.delete("/students/:id", teacher, h((req) => {
  const s = requireStudentOfMyClass(req.user, req.params.id);
  q.run("DELETE FROM auth_tokens WHERE kind='student' AND user_id = ?", s.id);
  q.run("DELETE FROM students WHERE id = ?", s.id);
}));

// ================= 문제 세트 =================
const SET_KINDS = ["textbook", "worksheet", "quick"];
api.get("/sets", teacher, h((req) => ({
  sets: q.all(
    `SELECT ps.*, t.name AS owner_name, (ps.owner_id = ?) AS mine,
       (SELECT COUNT(*) FROM problems p WHERE p.set_id = ps.id) AS problem_count
     FROM problem_sets ps JOIN teachers t ON t.id = ps.owner_id
     WHERE ps.owner_id = ? OR ps.shared = 1
     ORDER BY mine DESC, ps.kind, ps.grade, ps.title`, req.user.id, req.user.id),
})));

api.post("/sets", teacher, h((req) => {
  const { title, kind = "worksheet", grade = "", unit = "", shared = false } = req.body || {};
  if (!title) fail(400, "제목을 입력하세요.");
  if (!SET_KINDS.includes(kind)) fail(400, "종류가 올바르지 않습니다.");
  const id = newId();
  q.run("INSERT INTO problem_sets (id, owner_id, title, kind, grade, unit, shared, created_at) VALUES (?,?,?,?,?,?,?,?)",
    id, req.user.id, title, kind, grade, unit, shared ? 1 : 0, now());
  return { id };
}));

api.get("/sets/:id", teacher, h((req) => {
  const s = requireSet(req.user, req.params.id);
  return {
    set: { ...s, mine: s.owner_id === req.user.id, owner_name: q.get("SELECT name FROM teachers WHERE id = ?", s.owner_id)?.name },
    problems: q.all("SELECT * FROM problems WHERE set_id = ? ORDER BY ord", s.id),
  };
}));

api.patch("/sets/:id", teacher, h((req) => {
  const s = requireSet(req.user, req.params.id, { write: true });
  const b = req.body || {};
  q.run("UPDATE problem_sets SET title = ?, kind = ?, grade = ?, unit = ?, shared = ? WHERE id = ?",
    b.title ?? s.title, SET_KINDS.includes(b.kind) ? b.kind : s.kind, b.grade ?? s.grade, b.unit ?? s.unit,
    b.shared === undefined ? s.shared : b.shared ? 1 : 0, s.id);
}));

api.delete("/sets/:id", teacher, h((req) => {
  const s = requireSet(req.user, req.params.id, { write: true });
  const used = q.get(
    `SELECT COUNT(*) n FROM lesson_problems lp JOIN problems p ON p.id = lp.problem_id
     JOIN lessons l ON l.id = lp.lesson_id WHERE p.set_id = ? AND l.status = 'live'`, s.id).n;
  if (used) fail(400, "진행 중인 수업에서 사용 중인 세트입니다. 수업을 먼저 끝내세요.");
  q.run("DELETE FROM problem_sets WHERE id = ?", s.id);
}));

// 공유 세트를 내 세트로 복사 (교과서 세트를 가져와 수정할 때)
api.post("/sets/:id/copy", teacher, h((req) => {
  const s = requireSet(req.user, req.params.id);
  const id = newId();
  tx(() => {
    q.run("INSERT INTO problem_sets (id, owner_id, title, kind, grade, unit, shared, created_at) VALUES (?,?,?,?,?,?,0,?)",
      id, req.user.id, `${s.title} (복사본)`, s.kind === "quick" ? "worksheet" : s.kind, s.grade, s.unit, now());
    for (const p of q.all("SELECT * FROM problems WHERE set_id = ? ORDER BY ord", s.id)) {
      q.run("INSERT INTO problems (id, set_id, ord, label, kind, image, body, answer, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        newId(), id, p.ord, p.label, p.kind, p.image, p.body, p.answer, now());
    }
  });
  return { id };
}));

const nextOrd = (setId) => (q.get("SELECT MAX(ord) m FROM problems WHERE set_id = ?", setId).m ?? -1) + 1;

// 이미지 문제 추가 (PDF에서 잘라낸 영역, 사진). meta = JSON [{label, answer}] 파일 순서대로
api.post("/sets/:id/problems/images", teacher, imageUpload.array("images", 60), h((req) => {
  const s = requireSet(req.user, req.params.id, { write: true });
  const meta = JSON.parse(req.body?.meta || "[]");
  if (!req.files?.length) fail(400, "이미지가 없습니다.");
  let ord = nextOrd(s.id);
  const ids = [];
  tx(() => {
    req.files.forEach((f, i) => {
      const id = newId();
      const m = meta[i] || {};
      q.run("INSERT INTO problems (id, set_id, ord, label, kind, image, body, answer, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        id, s.id, ord++, String(m.label ?? ord), "image", `/uploads/${f.filename}`, "", m.answer || "", now());
      ids.push(id);
    });
  });
  return { ids };
}));

// 글/수식 문제 추가 (hwpx 가져오기 결과, 직접 입력)
api.post("/sets/:id/problems/rich", teacher, h((req) => {
  const s = requireSet(req.user, req.params.id, { write: true });
  const list = Array.isArray(req.body?.problems) ? req.body.problems : [];
  if (!list.length) fail(400, "추가할 문제가 없습니다.");
  let ord = nextOrd(s.id);
  const ids = [];
  tx(() => {
    for (const p of list) {
      const id = newId();
      q.run("INSERT INTO problems (id, set_id, ord, label, kind, image, body, answer, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        id, s.id, ord++, String(p.label ?? ord), "rich", null, String(p.body || ""), String(p.answer || ""), now());
      ids.push(id);
    }
  });
  return { ids };
}));

api.post("/import/hwpx", teacher, memUpload.single("file"), h((req) => {
  if (!req.file) fail(400, "파일이 없습니다.");
  try {
    return parseHwpx(req.file.buffer, { uploadDir: UPLOAD_DIR, urlPrefix: "/uploads", newId: () => newId(16) });
  } catch (e) {
    console.error(e);
    fail(400, "hwpx 파일을 읽지 못했습니다. (hwp 파일이면 한글에서 hwpx 또는 PDF로 저장해 주세요)");
  }
}));

function requireProblemWrite(user, problemId) {
  const p = q.get("SELECT * FROM problems WHERE id = ?", problemId);
  if (!p) fail(404, "문제를 찾을 수 없습니다.");
  requireSet(user, p.set_id, { write: true });
  return p;
}
api.patch("/problems/:id", teacher, h((req) => {
  const p = requireProblemWrite(req.user, req.params.id);
  const b = req.body || {};
  q.run("UPDATE problems SET label = ?, answer = ?, body = ? WHERE id = ?",
    b.label ?? p.label, b.answer ?? p.answer, b.body ?? p.body, p.id);
}));
api.delete("/problems/:id", teacher, h((req) => {
  const p = requireProblemWrite(req.user, req.params.id);
  q.run("DELETE FROM problems WHERE id = ?", p.id);
}));
api.post("/sets/:id/reorder", teacher, h((req) => {
  const s = requireSet(req.user, req.params.id, { write: true });
  const ids = req.body?.ids || [];
  tx(() => ids.forEach((pid, i) => q.run("UPDATE problems SET ord = ? WHERE id = ? AND set_id = ?", i, pid, s.id)));
}));

// ================= 수업 =================
api.get("/lessons", teacher, h((req) => ({
  lessons: q.all(
    `SELECT l.*, c.name AS class_name, c.school_year,
       (SELECT COUNT(*) FROM lesson_problems lp WHERE lp.lesson_id = l.id) AS problem_count
     FROM lessons l JOIN classes c ON c.id = l.class_id
     WHERE l.teacher_id = ? ORDER BY l.status = 'live' DESC, l.started_at DESC LIMIT 100`, req.user.id),
})));

api.post("/lessons", teacher, h((req) => {
  const { classId, title, problemIds = [] } = req.body || {};
  const c = requireClass(req.user, classId);
  const liveL = q.get("SELECT l.*, t.name AS tname FROM lessons l JOIN teachers t ON t.id = l.teacher_id WHERE class_id = ? AND status = 'live'", c.id);
  if (liveL) fail(400, `이 학급은 이미 수업 중입니다: "${liveL.title}" (${liveL.tname} 선생님). 먼저 끝내 주세요.`);
  for (const pid of problemIds) {
    const p = q.get("SELECT set_id FROM problems WHERE id = ?", pid);
    if (!p) fail(400, "없는 문제가 포함되어 있습니다.");
    requireSet(req.user, p.set_id);
  }
  const id = newId();
  tx(() => {
    q.run("INSERT INTO lessons (id, teacher_id, class_id, title, status, focus_problem_id, started_at) VALUES (?,?,?,?, 'live', ?, ?)",
      id, req.user.id, c.id, title || `${c.name} 수업`, problemIds[0] || null, now());
    problemIds.forEach((pid, i) => q.run("INSERT OR IGNORE INTO lesson_problems (lesson_id, problem_id, ord) VALUES (?,?,?)", id, pid, i));
  });
  live.lessonStarted(id);
  return { id };
}));

api.get("/lessons/:id", teacher, h((req) => {
  const l = requireLesson(req.user, req.params.id);
  return {
    lesson: { ...l, class_name: q.get("SELECT name FROM classes WHERE id = ?", l.class_id)?.name },
    problems: lessonProblems(l.id),
    students: q.all("SELECT id, student_no, name FROM students WHERE class_id = ? ORDER BY student_no", l.class_id),
  };
}));

api.post("/lessons/:id/end", teacher, h((req) => {
  const l = requireLesson(req.user, req.params.id);
  if (l.status !== "live") return;
  live.flush();
  q.run("UPDATE lessons SET status = 'ended', ended_at = ? WHERE id = ?", now(), l.id);
  live.lessonEnded(l.id, l.class_id);
}));

api.post("/lessons/:id/problems", teacher, h((req) => {
  const l = requireLesson(req.user, req.params.id);
  const ids = req.body?.problemIds || [];
  let ord = (q.get("SELECT MAX(ord) m FROM lesson_problems WHERE lesson_id = ?", l.id).m ?? -1) + 1;
  tx(() => {
    for (const pid of ids) {
      const p = q.get("SELECT set_id FROM problems WHERE id = ?", pid);
      if (!p) continue;
      requireSet(req.user, p.set_id);
      q.run("INSERT OR IGNORE INTO lesson_problems (lesson_id, problem_id, ord) VALUES (?,?,?)", l.id, pid, ord++);
    }
  });
  live.problemsChanged(l.id);
}));

// 즉석 문제: 사진/손글씨 이미지를 올리면 '즉석 문제' 세트에 저장 + 수업에 추가 + 모두 이 문제로 이동
api.post("/lessons/:id/quick", teacher, imageUpload.single("image"), h((req) => {
  const l = requireLesson(req.user, req.params.id);
  if (!req.file) fail(400, "이미지가 없습니다.");
  let set = q.get("SELECT * FROM problem_sets WHERE owner_id = ? AND kind = 'quick'", req.user.id);
  if (!set) {
    set = { id: newId() };
    q.run("INSERT INTO problem_sets (id, owner_id, title, kind, shared, created_at) VALUES (?,?,?, 'quick', 0, ?)",
      set.id, req.user.id, "즉석 문제", now());
  }
  const pid = newId();
  const quickCount = q.get(
    `SELECT COUNT(*) n FROM lesson_problems lp JOIN problems p ON p.id = lp.problem_id
     JOIN problem_sets ps ON ps.id = p.set_id WHERE lp.lesson_id = ? AND ps.kind = 'quick'`, l.id).n;
  const label = req.body?.label || `즉석${quickCount + 1}`;
  q.run("INSERT INTO problems (id, set_id, ord, label, kind, image, body, answer, created_at) VALUES (?,?,?,?, 'image', ?, '', ?, ?)",
    pid, set.id, nextOrd(set.id), label, `/uploads/${req.file.filename}`, req.body?.answer || "", now());
  const ord = (q.get("SELECT MAX(ord) m FROM lesson_problems WHERE lesson_id = ?", l.id).m ?? -1) + 1;
  q.run("INSERT INTO lesson_problems (lesson_id, problem_id, ord) VALUES (?,?,?)", l.id, pid, ord);
  live.problemsChanged(l.id);
  live.setFocus(l.id, pid);
  return { id: pid };
}));

// ================= 학생 =================
api.get("/student/lesson", student, h((req) => {
  const l = q.get("SELECT * FROM lessons WHERE class_id = ? AND status = 'live'", req.user.class_id);
  if (!l) return { lesson: null };
  return live.studentState(l, req.user.id);
}));
