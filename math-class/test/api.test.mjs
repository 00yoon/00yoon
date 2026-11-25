// 서버 통합 테스트: 실제 서버를 빈 DB로 띄워서 로그인 → 학급/명단 → 문제 세트/공유 → 수업 → 실시간 필기·제출 흐름 확인
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { io as ioc } from "socket.io-client";

const ROOT = path.resolve(import.meta.dirname, "..");
let server, base, dataDir;
const sockets = [];

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "math-class-test-"));
  server = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server/index.js"], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: dataDir, PORT: "0", ADMIN_ID: "admin", ADMIN_PASSWORD: "admin-pass" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  base = await new Promise((resolve, reject) => {
    let out = "", timer;
    server.stdout.on("data", (d) => {
      out += d;
      const m = out.match(/http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timer); resolve(`http://localhost:${m[1]}`); }
    });
    server.on("exit", (code) => reject(new Error(`server exited ${code}: ${out}`)));
    timer = setTimeout(() => reject(new Error(`server start timeout: ${out}`)), 10000);
  });
});

after(() => {
  for (const s of sockets) s.close();
  server?.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function call(method, url, { token, body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await fetch(base + "/api" + url, { method, headers, body: payload });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const ok = async (...a) => {
  const r = await call(...a);
  assert.equal(r.status, 200, `${a[0]} ${a[1]} → ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
};
const connect = (token) => new Promise((resolve, reject) => {
  const s = ioc(base, { auth: { token }, transports: ["websocket"], reconnection: false });
  sockets.push(s);
  s.on("connect", () => resolve(s));
  s.on("connect_error", reject);
});
const emit = (s, ev, data) => new Promise((resolve) => s.emit(ev, data, resolve));
const waitFor = (s, ev, pred = () => true, ms = 3000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => { s.off(ev, fn); reject(new Error(`timeout waiting ${ev}`)); }, ms);
  const fn = (d) => { if (pred(d)) { clearTimeout(t); s.off(ev, fn); resolve(d); } };
  s.on(ev, fn);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("healthz", async () => {
  const r = await fetch(base + "/healthz");
  assert.equal(await r.text(), "ok");
});

test("전체 수업 흐름", async (t) => {
  const st = {};

  await t.test("관리자 로그인과 교사 계정 생성", async () => {
    const bad = await call("POST", "/login/teacher", { body: { loginId: "admin", password: "wrong" } });
    assert.equal(bad.status, 401);
    st.admin = (await ok("POST", "/login/teacher", { body: { loginId: "admin", password: "admin-pass" } })).token;
    await ok("POST", "/admin/teachers", { token: st.admin, body: { loginId: "kim", name: "김선생", password: "kim-pass" } });
    await ok("POST", "/admin/teachers", { token: st.admin, body: { loginId: "lee", name: "이선생", password: "lee-pass" } });
    const dup = await call("POST", "/admin/teachers", { token: st.admin, body: { loginId: "kim", name: "x", password: "123456" } });
    assert.equal(dup.status, 400);
    st.kim = (await ok("POST", "/login/teacher", { body: { loginId: "kim", password: "kim-pass" } })).token;
    st.lee = (await ok("POST", "/login/teacher", { body: { loginId: "lee", password: "lee-pass" } })).token;
    const notAdmin = await call("GET", "/admin/teachers", { token: st.kim });
    assert.equal(notAdmin.status, 403);
  });

  await t.test("여러 교사가 같은 학급을 담당", async () => {
    const a = await ok("POST", "/classes", { token: st.kim, body: { grade: 2, classNo: 3 } });
    assert.equal(a.joined, false);
    const b = await ok("POST", "/classes", { token: st.lee, body: { grade: 2, classNo: 3 } });
    assert.equal(b.joined, true);
    assert.equal(a.id, b.id);
    st.classId = a.id;
    st.otherClassId = (await ok("POST", "/classes", { token: st.lee, body: { grade: 2, classNo: 4 } })).id;
    const forbidden = await call("GET", `/classes/${st.otherClassId}`, { token: st.kim });
    assert.equal(forbidden.status, 403);
    const { classes } = await ok("GET", "/classes", { token: st.lee });
    assert.equal(classes.length, 2);
  });

  await t.test("명단 붙여넣기 (학번 + 4자리 비밀번호)", async () => {
    const r = await ok("POST", `/classes/${st.classId}/students`, {
      token: st.kim, body: { rows: "20301\t김가람\t1234\n20302, 이나래\n잘못된 줄\n" },
    });
    assert.equal(r.created.length, 2);
    assert.equal(r.errors.length, 1);
    assert.match(r.created[1].password, /^\d{4}$/);
    const other = await ok("POST", `/classes/${st.otherClassId}/students`, { token: st.lee, body: { rows: "20301 다른학생 1111\n20401 박다솜 5555" } });
    assert.equal(other.created.length, 1);
    assert.match(other.errors[0], /2학년 3반/);
  });

  await t.test("학생 로그인", async () => {
    const bad = await call("POST", "/login/student", { body: { studentNo: "20301", password: "0000" } });
    assert.equal(bad.status, 401);
    const r = await ok("POST", "/login/student", { body: { studentNo: "20301", password: "1234" } });
    assert.equal(r.user.kind, "student");
    assert.equal(r.user.class_name, "2학년 3반");
    st.s1 = r.token;
    st.s1Id = r.user.id;
    st.s2 = (await ok("POST", "/login/student", { body: { studentNo: "20401", password: "5555" } })).token;
    const asTeacher = await call("GET", "/classes", { token: st.s1 });
    assert.equal(asTeacher.status, 401);
  });

  await t.test("문제 세트 공유와 복사", async () => {
    st.setId = (await ok("POST", "/sets", { token: st.kim, body: { title: "일차방정식", kind: "worksheet" } })).id;
    const { ids } = await ok("POST", `/sets/${st.setId}/problems/rich`, {
      token: st.kim, body: { problems: [{ label: "1", body: "$\\frac{19}{10}$ 을 소수로", answer: "19/10|1.9" }, { label: "2", body: "x+1=3", answer: "" }] },
    });
    st.p1 = ids[0]; st.p2 = ids[1];
    assert.equal((await call("GET", `/sets/${st.setId}`, { token: st.lee })).status, 403);
    await ok("PATCH", `/sets/${st.setId}`, { token: st.kim, body: { shared: true } });
    const shared = await ok("GET", `/sets/${st.setId}`, { token: st.lee });
    assert.equal(shared.problems.length, 2);
    assert.equal((await call("PATCH", `/sets/${st.setId}`, { token: st.lee, body: { title: "x" } })).status, 403);
    const copy = await ok("POST", `/sets/${st.setId}/copy`, { token: st.lee });
    const copied = await ok("GET", `/sets/${copy.id}`, { token: st.lee });
    assert.equal(copied.set.mine, true);
    assert.equal(copied.problems.length, 2);
  });

  await t.test("이미지 문제 업로드", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
    const form = new FormData();
    form.append("images", new Blob([png], { type: "image/png" }), "crop.png");
    form.append("meta", JSON.stringify([{ label: "3", answer: "5" }]));
    const { ids } = await ok("POST", `/sets/${st.setId}/problems/images`, { token: st.kim, form });
    const { problems } = await ok("GET", `/sets/${st.setId}`, { token: st.kim });
    const p = problems.find((x) => x.id === ids[0]);
    assert.equal(p.kind, "image");
    const img = await fetch(base + p.image);
    assert.equal(img.status, 200);
  });

  await t.test("hwpx 가져오기", async () => {
    const form = new FormData();
    form.append("file", new Blob([fs.readFileSync(path.join(ROOT, "test/sample.hwpx"))]), "sample.hwpx");
    const r = await ok("POST", "/import/hwpx", { token: st.kim, form });
    assert.ok(r.problems.length >= 1, JSON.stringify(r));
    const broken = new FormData();
    broken.append("file", new Blob([Buffer.from("not a zip")]), "x.hwpx");
    assert.equal((await call("POST", "/import/hwpx", { token: st.kim, form: broken })).status, 400);
  });

  await t.test("수업 시작 (학급당 하나)", async () => {
    st.lessonId = (await ok("POST", "/lessons", { token: st.kim, body: { classId: st.classId, title: "3월 첫 수업", problemIds: [st.p1, st.p2] } })).id;
    const again = await call("POST", "/lessons", { token: st.lee, body: { classId: st.classId, problemIds: [st.p1] } });
    assert.equal(again.status, 400);
    const s = await ok("GET", "/student/lesson", { token: st.s1 });
    assert.equal(s.lesson.id, st.lessonId);
    assert.equal(s.problems.length, 2);
    for (const p of s.problems) assert.equal("answer" in p, false, "학생에게 정답이 가면 안 됨");
    const none = await ok("GET", "/student/lesson", { token: st.s2 });
    assert.equal(none.lesson, null);
  });

  await t.test("실시간 필기와 제출, 교사 모니터링", async () => {
    const teacherSock = await connect(st.kim);
    const join = await emit(teacherSock, "monitor:join", { lessonId: st.lessonId });
    assert.equal(join.students.length, 2);
    assert.equal(join.problems[0].answer, "19/10|1.9");

    const coTeacher = await connect(st.lee);
    assert.ok((await emit(coTeacher, "monitor:join", { lessonId: st.lessonId })).lesson, "공동 담당 교사도 모니터링 가능");

    const stu = await connect(st.s1);
    const opened = await emit(stu, "work:open", { problemId: st.p1 });
    assert.deepEqual(opened.strokes, []);
    assert.ok((await emit(stu, "work:open", { problemId: "없는문제" })).error);

    const gotStroke = waitFor(teacherSock, "stroke:begin");
    stu.emit("stroke:begin", { problemId: st.p1, stroke: { id: "s1", c: "#111", w: 3, p: [[10, 10, 0]] } });
    assert.equal((await gotStroke).stroke.id, "s1");

    const gotAdd = waitFor(teacherSock, "stroke:add");
    stu.emit("stroke:add", { problemId: st.p1, id: "s1", p: [[20, 20, 16], "junk", [1, "x", 3], [30, 30, 32]] });
    assert.deepEqual((await gotAdd).p, [[20, 20, 16], [30, 30, 32]], "잘못된 좌표는 버림");

    const summary = waitFor(teacherSock, "work:summary", (d) => d.work.submittedAt);
    const ack = await emit(stu, "work:submit", { problemId: st.p1, answer: " 1.9 " });
    assert.equal(ack.ok, true);
    const w = (await summary).work;
    assert.equal(w.autoCorrect, 1);
    assert.equal(w.strokeCount, 1);

    const wrong = waitFor(teacherSock, "work:summary", (d) => d.work.problemId === st.p1 && d.work.submitCount === 2);
    await emit(stu, "work:submit", { problemId: st.p1, answer: "2" });
    assert.equal((await wrong).work.autoCorrect, 0);

    const got = await emit(teacherSock, "work:get", { studentId: st.s1Id, problemId: st.p1 });
    assert.equal(got.work.strokes[0].p.length, 3);

    const state = await ok("GET", "/student/lesson", { token: st.s1 });
    assert.equal(state.submitted[st.p1], "2");

    // 메시지: 이 수업의 학생에게만
    const msg = waitFor(stu, "message");
    assert.equal((await emit(teacherSock, "message:send", { studentId: st.s1Id, text: "잘했어요" })).ok, true);
    assert.equal((await msg).text, "잘했어요");
    const otherClass = await ok("GET", `/classes/${st.otherClassId}`, { token: st.lee });
    const r = await emit(teacherSock, "message:send", { studentId: otherClass.students[0].id, text: "x" });
    assert.ok(r.error);

    // 문제 이동
    const focus = waitFor(stu, "lesson:focus");
    teacherSock.emit("lesson:focus", { problemId: st.p2 });
    assert.equal((await focus).problemId, st.p2);

    st.stu = stu; st.teacherSock = teacherSock;
  });

  await t.test("수업 종료 후 필기는 저장되지 않음", async () => {
    const ended = waitFor(st.stu, "lesson:end");
    await ok("POST", `/lessons/${st.lessonId}/end`, { token: st.kim });
    await ended;
    // 학생 화면이 아직 종료를 반영하기 전에 보낸 획
    st.stu.emit("stroke:begin", { problemId: st.p1, stroke: { id: "late", c: "#111", w: 3, p: [[1, 1, 0]] } });
    await sleep(200);
    const join = await emit(st.teacherSock, "monitor:join", { lessonId: st.lessonId });
    assert.equal(join.lesson.status, "ended");
    const w = join.works.find((x) => x.problemId === st.p1);
    assert.equal(w.strokeCount, 1, "종료 후 획이 추가되면 안 됨");
    const s = await ok("GET", "/student/lesson", { token: st.s1 });
    assert.equal(s.lesson, null);
  });

  await t.test("교사 계정 사용 중지", async () => {
    const leeTeachers = (await ok("GET", "/admin/teachers", { token: st.admin })).teachers;
    const lee = leeTeachers.find((x) => x.login_id === "lee");
    const self = leeTeachers.find((x) => x.login_id === "admin");
    assert.equal((await call("POST", `/admin/teachers/${self.id}/disabled`, { token: st.admin, body: { disabled: true } })).status, 400);
    await ok("POST", `/admin/teachers/${lee.id}/disabled`, { token: st.admin, body: { disabled: true } });
    assert.equal((await call("GET", "/classes", { token: st.lee })).status, 401, "기존 로그인도 끊김");
    assert.equal((await call("POST", "/login/teacher", { body: { loginId: "lee", password: "lee-pass" } })).status, 403);
    await ok("POST", `/admin/teachers/${lee.id}/disabled`, { token: st.admin, body: { disabled: false } });
    await ok("POST", "/login/teacher", { body: { loginId: "lee", password: "lee-pass" } });
  });

  await t.test("비밀번호 무차별 대입 제한", async () => {
    let last;
    for (let i = 0; i < 11; i++) last = await call("POST", "/login/student", { body: { studentNo: "20302", password: String(i).padStart(4, "0") } });
    assert.equal(last.status, 429);
  });
});
