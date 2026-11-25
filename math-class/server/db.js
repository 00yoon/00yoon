// SQLite (Node 내장 node:sqlite) — 별도 DB 서버 없이 파일 하나로 동작
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// 기본값: math-class/data (실행 위치와 무관)
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(import.meta.dirname, "..", "data"));
export const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, "app.db"));
db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`);

db.exec(`
CREATE TABLE IF NOT EXISTS teachers (
  id TEXT PRIMARY KEY,
  login_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  pw_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
-- 학급 (예: 2026학년도 2학년 3반)
CREATE TABLE IF NOT EXISTS classes (
  id TEXT PRIMARY KEY,
  school_year INTEGER NOT NULL,
  grade INTEGER NOT NULL,
  class_no INTEGER NOT NULL,
  name TEXT NOT NULL,
  created_by TEXT REFERENCES teachers(id),
  created_at INTEGER NOT NULL,
  UNIQUE (school_year, grade, class_no)
);
-- 교사 ↔ 학급 (여러 교사가 여러 반)
CREATE TABLE IF NOT EXISTS class_teachers (
  class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  teacher_id TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  PRIMARY KEY (class_id, teacher_id)
);
-- 학생: 학번(예 20315) + 4자리 비밀번호, 학년도별로 학번 유일
CREATE TABLE IF NOT EXISTS students (
  id TEXT PRIMARY KEY,
  class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  school_year INTEGER NOT NULL,
  student_no TEXT NOT NULL,
  name TEXT NOT NULL,
  pw_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (school_year, student_no)
);
CREATE TABLE IF NOT EXISTS auth_tokens (
  token TEXT PRIMARY KEY,
  kind TEXT NOT NULL,          -- 'teacher' | 'student'
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
-- 문제 세트: textbook(교과서) / worksheet(학습지) / quick(즉석)
CREATE TABLE IF NOT EXISTS problem_sets (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES teachers(id),
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'worksheet',
  grade TEXT DEFAULT '',
  unit TEXT DEFAULT '',
  shared INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
-- 문제: image(PDF/사진 잘라낸 원본) 또는 rich(hwpx에서 읽은 글+수식+그림)
CREATE TABLE IF NOT EXISTS problems (
  id TEXT PRIMARY KEY,
  set_id TEXT NOT NULL REFERENCES problem_sets(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL,
  label TEXT DEFAULT '',
  kind TEXT NOT NULL,
  image TEXT,
  body TEXT,
  answer TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);
-- 수업: 교사 + 학급 + 고른 문제들
CREATE TABLE IF NOT EXISTS lessons (
  id TEXT PRIMARY KEY,
  teacher_id TEXT NOT NULL REFERENCES teachers(id),
  class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'live',
  focus_problem_id TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE TABLE IF NOT EXISTS lesson_problems (
  lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  problem_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL,
  PRIMARY KEY (lesson_id, problem_id)
);
-- 풀이: 획(stroke) 단위 + 시간 기록 → 재생/지운 흔적/멈춤 분석, 2차 AI 분석 입력
CREATE TABLE IF NOT EXISTS works (
  lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  problem_id TEXT NOT NULL,
  strokes TEXT NOT NULL DEFAULT '[]',
  started_at INTEGER NOT NULL,
  last_activity INTEGER NOT NULL,
  answer TEXT DEFAULT '',
  submitted_at INTEGER,
  submit_count INTEGER NOT NULL DEFAULT 0,
  auto_correct INTEGER,
  PRIMARY KEY (lesson_id, student_id, problem_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  student_id TEXT,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);

// ---- 이전 버전 DB에 새 컬럼 추가 (있으면 건너뜀)
function addColumn(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumn("teachers", "disabled", "INTEGER NOT NULL DEFAULT 0");

export const newId = (n = 12) => crypto.randomBytes(16).toString("base64url").slice(0, n);
export const now = () => Date.now();

// ---- 비밀번호 (scrypt, 외부 라이브러리 없음)
export function hashPw(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  const h = crypto.scryptSync(String(pw), salt, 32).toString("hex");
  return `${salt}:${h}`;
}
export function checkPw(pw, stored) {
  const [salt, h] = String(stored).split(":");
  if (!salt || !h) return false;
  const test = crypto.scryptSync(String(pw), salt, 32);
  return crypto.timingSafeEqual(test, Buffer.from(h, "hex"));
}

export const q = {
  get: (sql, ...a) => db.prepare(sql).get(...a),
  all: (sql, ...a) => db.prepare(sql).all(...a),
  run: (sql, ...a) => db.prepare(sql).run(...a),
};

export function tx(fn) {
  db.exec("BEGIN");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function currentSchoolYear(d = new Date()) {
  // 한국 학년도: 3월 시작 (1~2월은 전년도)
  return d.getMonth() < 2 ? d.getFullYear() - 1 : d.getFullYear();
}

// 최초 실행 시 관리자 계정 생성
export function ensureAdmin() {
  const c = q.get("SELECT COUNT(*) n FROM teachers").n;
  if (c > 0) return;
  const loginId = process.env.ADMIN_ID || "admin";
  const pw = process.env.ADMIN_PASSWORD || "admin1234";
  q.run(
    "INSERT INTO teachers (id, login_id, name, pw_hash, is_admin, created_at) VALUES (?,?,?,?,1,?)",
    newId(), loginId, "관리자", hashPw(pw), now()
  );
  console.log(`[초기 설정] 관리자 계정 생성: ${loginId} / ${process.env.ADMIN_PASSWORD ? "(환경변수 비밀번호)" : pw}  ← 로그인 후 꼭 변경하세요`);
}
