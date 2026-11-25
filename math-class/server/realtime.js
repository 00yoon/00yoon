// 실시간: 학생 필기(획 단위) → 서버 저장 → 교사 화면으로 즉시 전달
import { Server } from "socket.io";
import { q, now } from "./db.js";

let io = null;
let apiMod = null; // 순환 import 방지용 지연 로드

const MAX_STROKES = 4000;
const MAX_POINTS = 5000;

// ---- 진행 중 풀이 캐시 (메모리) + 주기적 DB 저장
const works = new Map(); // key → work
const dirty = new Set();
const current = new Map(); // `${lessonId}:${studentId}` → problemId (학생이 보고 있는 문제)
const online = new Map(); // `${lessonId}:${studentId}` → 접속 소켓 수
const lessonProblemIds = new Map(); // lessonId → Set(problemId)

const endedLessons = new Set(); // 끝난 수업: 학생 소켓이 아직 모르고 보내는 필기를 막음

const wkey = (l, s, p) => `${l}:${s}:${p}`;

// 좌표 [x, y, 경과ms] 만 받음 (그 외 값은 버림)
const cleanPoints = (p, max) => {
  const out = [];
  for (const pt of p) {
    if (out.length >= max) break;
    if (!Array.isArray(pt)) continue;
    const [x, y, t] = pt.map(Number);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(t)) out.push([x, y, t]);
  }
  return out;
};

function loadWork(lessonId, studentId, problemId, create) {
  const key = wkey(lessonId, studentId, problemId);
  let w = works.get(key);
  if (w) return w;
  const row = q.get("SELECT * FROM works WHERE lesson_id = ? AND student_id = ? AND problem_id = ?", lessonId, studentId, problemId);
  if (row) {
    w = { ...row, strokes: JSON.parse(row.strokes) };
  } else if (create) {
    const t = now();
    w = { lesson_id: lessonId, student_id: studentId, problem_id: problemId, strokes: [], started_at: t, last_activity: t,
      answer: "", submitted_at: null, submit_count: 0, auto_correct: null };
    dirty.add(key);
  } else return null;
  works.set(key, w);
  return w;
}

export function flush() {
  if (!dirty.size) return;
  const stmt = q;
  for (const key of dirty) {
    const w = works.get(key);
    if (!w) continue;
    stmt.run(
      `INSERT INTO works (lesson_id, student_id, problem_id, strokes, started_at, last_activity, answer, submitted_at, submit_count, auto_correct)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (lesson_id, student_id, problem_id) DO UPDATE SET
         strokes = excluded.strokes, last_activity = excluded.last_activity, answer = excluded.answer,
         submitted_at = excluded.submitted_at, submit_count = excluded.submit_count, auto_correct = excluded.auto_correct`,
      w.lesson_id, w.student_id, w.problem_id, JSON.stringify(w.strokes), w.started_at, w.last_activity,
      w.answer, w.submitted_at, w.submit_count, w.auto_correct);
  }
  dirty.clear();
}
setInterval(flush, 2000).unref();
// 오래된 캐시 정리 (끝난 수업)
setInterval(() => {
  flush();
  const liveIds = new Set(q.all("SELECT id FROM lessons WHERE status = 'live'").map((r) => r.id));
  for (const [k, w] of works) if (!liveIds.has(w.lesson_id)) works.delete(k);
}, 10 * 60 * 1000).unref();

export function summary(w) {
  return {
    studentId: w.student_id, problemId: w.problem_id, startedAt: w.started_at, lastActivity: w.last_activity,
    submittedAt: w.submitted_at, submitCount: w.submit_count, answer: w.answer, autoCorrect: w.auto_correct,
    strokeCount: w.strokes.filter((s) => !s.del).length, erasedCount: w.strokes.filter((s) => s.del).length,
  };
}
const full = (w) => ({ ...summary(w), strokes: w.strokes });

function problemIdsOf(lessonId) {
  let set = lessonProblemIds.get(lessonId);
  if (!set) {
    set = new Set(q.all("SELECT problem_id FROM lesson_problems WHERE lesson_id = ?", lessonId).map((r) => r.problem_id));
    lessonProblemIds.set(lessonId, set);
  }
  return set;
}

// 정답 자동 비교: 공백 무시, 여러 정답은 | 로 구분
const norm = (s) => String(s || "").replace(/\s+/g, "").replace(/[，]/g, ",").toLowerCase();
function autoCheck(problemId, answer) {
  const p = q.get("SELECT answer FROM problems WHERE id = ?", problemId);
  if (!p || !p.answer?.trim()) return null;
  return p.answer.split("|").map(norm).filter(Boolean).includes(norm(answer)) ? 1 : 0;
}

const teachersRoom = (lessonId) => `lesson:${lessonId}:t`;
const studentsRoom = (lessonId) => `lesson:${lessonId}:s`;

function liveLessonOfClass(classId) {
  return q.get("SELECT * FROM lessons WHERE class_id = ? AND status = 'live'", classId);
}

function presenceOf(lessonId, studentId) {
  const k = `${lessonId}:${studentId}`;
  return { studentId, online: (online.get(k) || 0) > 0, current: current.get(k) || null };
}

// ---------- 외부(API)에서 호출
export const live = {
  flush,
  lessonStarted(lessonId) {
    const l = q.get("SELECT * FROM lessons WHERE id = ?", lessonId);
    if (!io || !l) return;
    lessonProblemIds.delete(lessonId);
    io.in(`class:${l.class_id}`).socketsJoin(studentsRoom(lessonId));
    io.to(`class:${l.class_id}`).emit("lesson:start", { lessonId });
  },
  lessonEnded(lessonId, classId) {
    endedLessons.add(lessonId);
    lessonProblemIds.delete(lessonId);
    if (!io) return;
    io.to(`class:${classId}`).emit("lesson:end", { lessonId });
    io.to(teachersRoom(lessonId)).emit("lesson:end", { lessonId });
    io.in(studentsRoom(lessonId)).socketsLeave(studentsRoom(lessonId));
  },
  problemsChanged(lessonId) {
    lessonProblemIds.delete(lessonId);
    if (!io) return;
    const problems = apiMod.lessonProblems(lessonId);
    io.to(studentsRoom(lessonId)).emit("lesson:problems", { problems: problems.map(apiMod.publicProblem) });
    io.to(teachersRoom(lessonId)).emit("lesson:problems", { problems });
  },
  setFocus(lessonId, problemId) {
    q.run("UPDATE lessons SET focus_problem_id = ? WHERE id = ?", problemId, lessonId);
    io?.to(studentsRoom(lessonId)).emit("lesson:focus", { problemId });
    io?.to(teachersRoom(lessonId)).emit("lesson:focus", { problemId });
  },
  studentState(lesson, studentId) {
    flush();
    const problems = apiMod.lessonProblems(lesson.id).map(apiMod.publicProblem);
    const mine = q.all("SELECT problem_id, answer, submitted_at FROM works WHERE lesson_id = ? AND student_id = ?", lesson.id, studentId);
    return {
      lesson: { id: lesson.id, title: lesson.title, focus_problem_id: lesson.focus_problem_id },
      problems,
      submitted: Object.fromEntries(mine.filter((w) => w.submitted_at).map((w) => [w.problem_id, w.answer])),
    };
  },
};

// ---------- 소켓
export async function attachRealtime(httpServer) {
  apiMod = await import("./api.js");
  io = new Server(httpServer, { maxHttpBufferSize: 1e6, pingInterval: 20000, pingTimeout: 20000 });

  io.use((socket, next) => {
    const u = apiMod.userFromToken(socket.handshake.auth?.token);
    if (!u) return next(new Error("unauthorized"));
    socket.data.user = u;
    next();
  });

  io.on("connection", (socket) => {
    const u = socket.data.user;
    if (u.kind === "student") onStudent(socket, u);
    else onTeacher(socket, u);
  });
}

function onStudent(socket, u) {
  socket.join(`class:${u.class_id}`);
  socket.join(`student:${u.id}`);
  let lessonId = null;

  const enter = () => {
    const l = liveLessonOfClass(u.class_id);
    if (lessonId && (!l || l.id !== lessonId)) leave();
    if (!l || lessonId === l.id) return;
    lessonId = l.id;
    socket.join(studentsRoom(lessonId));
    const k = `${lessonId}:${u.id}`;
    online.set(k, (online.get(k) || 0) + 1);
    io.to(teachersRoom(lessonId)).emit("presence", presenceOf(lessonId, u.id));
  };
  const leave = () => {
    if (!lessonId) return;
    const k = `${lessonId}:${u.id}`;
    online.set(k, Math.max(0, (online.get(k) || 1) - 1));
    io.to(teachersRoom(lessonId)).emit("presence", presenceOf(lessonId, u.id));
    socket.leave(studentsRoom(lessonId));
    lessonId = null;
  };
  enter();

  // 수업이 새로 시작/종료되면 클라이언트가 다시 상태를 요청 → 방 재가입
  socket.on("lesson:sync", (_, ack) => { enter(); ack?.({ lessonId }); });
  socket.on("disconnect", leave);

  const guard = (problemId) => {
    if (!lessonId || endedLessons.has(lessonId)) enter();
    return lessonId && problemIdsOf(lessonId).has(problemId);
  };
  const touch = (w) => {
    w.last_activity = now();
    dirty.add(wkey(w.lesson_id, w.student_id, w.problem_id));
  };
  const toTeachers = (ev, payload) => io.to(teachersRoom(lessonId)).emit(ev, { studentId: u.id, ...payload });

  socket.on("work:open", ({ problemId } = {}, ack) => {
    if (!guard(problemId)) return ack?.({ error: "문제를 찾을 수 없습니다." });
    current.set(`${lessonId}:${u.id}`, problemId);
    const w = loadWork(lessonId, u.id, problemId, true);
    io.to(teachersRoom(lessonId)).emit("presence", presenceOf(lessonId, u.id));
    toTeachers("work:summary", { work: full(w) });
    ack?.({ strokes: w.strokes, answer: w.answer, submittedAt: w.submitted_at });
  });

  socket.on("stroke:begin", ({ problemId, stroke } = {}) => {
    if (!guard(problemId) || !stroke?.id || !Array.isArray(stroke.p)) return;
    const w = loadWork(lessonId, u.id, problemId, true);
    if (w.strokes.length >= MAX_STROKES) return;
    const s = {
      id: String(stroke.id).slice(0, 24), c: String(stroke.c || "#111").slice(0, 9),
      w: Math.min(30, Math.max(1, +stroke.w || 3)), st: now(), p: cleanPoints(stroke.p, MAX_POINTS), del: null,
    };
    w.strokes.push(s);
    touch(w);
    toTeachers("stroke:begin", { problemId, stroke: s });
  });

  socket.on("stroke:add", ({ problemId, id, p } = {}) => {
    if (!guard(problemId) || !Array.isArray(p)) return;
    const w = loadWork(lessonId, u.id, problemId, false);
    const s = w?.strokes.findLast((x) => x.id === id);
    if (!s) return;
    const pts = cleanPoints(p, MAX_POINTS - s.p.length);
    if (!pts.length) return;
    s.p.push(...pts);
    touch(w);
    toTeachers("stroke:add", { problemId, id, p: pts });
  });

  const setDeleted = (ev, problemId, ids, value) => {
    if (!guard(problemId) || !Array.isArray(ids)) return;
    const w = loadWork(lessonId, u.id, problemId, false);
    if (!w) return;
    const set = new Set(ids);
    for (const s of w.strokes) if (set.has(s.id)) s.del = value;
    touch(w);
    toTeachers(ev, { problemId, ids, at: value });
  };
  socket.on("stroke:erase", ({ problemId, ids } = {}) => setDeleted("stroke:erase", problemId, ids, now()));
  socket.on("stroke:restore", ({ problemId, ids } = {}) => setDeleted("stroke:restore", problemId, ids, null));

  socket.on("work:submit", ({ problemId, answer } = {}, ack) => {
    if (!guard(problemId)) return ack?.({ error: "수업이 끝났거나 문제를 찾을 수 없습니다." });
    const w = loadWork(lessonId, u.id, problemId, true);
    w.answer = String(answer ?? "").slice(0, 200);
    w.submitted_at = now();
    w.submit_count += 1;
    w.auto_correct = autoCheck(problemId, w.answer);
    touch(w);
    flush();
    toTeachers("work:summary", { work: summary(w) });
    ack?.({ ok: true, submittedAt: w.submitted_at });
  });
}

function onTeacher(socket, u) {
  let lessonId = null;

  socket.on("monitor:join", ({ lessonId: id } = {}, ack) => {
    const l = apiMod.canAccessLesson(u, id);
    if (!l) return ack?.({ error: "수업을 찾을 수 없습니다." });
    if (lessonId) socket.leave(teachersRoom(lessonId));
    lessonId = l.id;
    socket.join(teachersRoom(lessonId));
    flush();
    const students = q.all("SELECT id, student_no, name FROM students WHERE class_id = ? ORDER BY student_no", l.class_id)
      .map((s) => ({ ...s, ...presenceOf(l.id, s.id) }));
    // 처음에는 요약만 + 각 학생이 '지금 보는 문제'(또는 마지막 활동 문제)의 필기만 보내서 가볍게
    const rows = q.all("SELECT * FROM works WHERE lesson_id = ?", l.id);
    const latest = {};
    for (const r of rows) if (!latest[r.student_id] || latest[r.student_id].last_activity < r.last_activity) latest[r.student_id] = r;
    const out = rows.map((r) => {
      const w = works.get(wkey(r.lesson_id, r.student_id, r.problem_id)) || { ...r, strokes: JSON.parse(r.strokes) };
      const cur = current.get(`${l.id}:${r.student_id}`) || latest[r.student_id]?.problem_id;
      return cur === r.problem_id ? full(w) : summary(w);
    });
    ack?.({ lesson: l, problems: apiMod.lessonProblems(l.id), students, works: out, serverNow: now() });
  });

  socket.on("work:get", ({ studentId, problemId } = {}, ack) => {
    if (!lessonId) return ack?.({ error: "수업에 먼저 접속하세요." });
    const w = loadWork(lessonId, studentId, problemId, false);
    ack?.({ work: w ? full(w) : null });
  });

  socket.on("lesson:focus", ({ problemId } = {}) => {
    if (!lessonId || !problemIdsOf(lessonId).has(problemId)) return;
    live.setFocus(lessonId, problemId);
  });

  socket.on("message:send", ({ studentId, text } = {}, ack) => {
    if (!lessonId || !String(text ?? "").trim()) return ack?.({ error: "내용을 입력하세요." });
    const l = q.get("SELECT class_id FROM lessons WHERE id = ?", lessonId);
    if (studentId && !q.get("SELECT 1 FROM students WHERE id = ? AND class_id = ?", studentId, l?.class_id))
      return ack?.({ error: "이 수업의 학생이 아닙니다." });
    const msg = { text: String(text).slice(0, 500), at: now(), from: u.name };
    q.run("INSERT INTO messages (lesson_id, student_id, text, created_at) VALUES (?,?,?,?)", lessonId, studentId || null, msg.text, msg.at);
    if (studentId) io.to(`student:${studentId}`).emit("message", msg);
    else io.to(studentsRoom(lessonId)).emit("message", msg);
    ack?.({ ok: true });
  });
}
