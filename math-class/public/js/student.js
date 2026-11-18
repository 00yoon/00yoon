import { api, auth, h, $, toast, renderProblem, requireLogin, logout, pLabel } from "/js/common.js";
import { Board } from "/js/board.js";

const me = requireLogin("student");
$("#who").textContent = `${me.student_no} ${me.name}`;
$("#logout").onclick = () => { if (confirm("나갈까요?")) logout(); };

let lesson = null;
let problems = [];
let submitted = {}; // problemId → 제출한 답
let curId = null;
let undoStack = [];

// ---------- 보드
const board = new Board($("#board"), {
  editable: true,
  onBegin: (stroke) => { socket.emit("stroke:begin", { problemId: curId, stroke }); undoStack.push({ type: "add", id: stroke.id }); },
  onAdd: (id, p) => socket.emit("stroke:add", { problemId: curId, id, p }),
  onErase: (ids) => socket.emit("stroke:erase", { problemId: curId, ids }),
  onEraseDone: (ids) => undoStack.push({ type: "erase", ids }),
});

const prefs = JSON.parse(localStorage.getItem("penPrefs") || "{}");
board.penOnly = prefs.penOnly ?? matchMedia("(pointer: coarse)").matches;
board.width = prefs.width || 3;
function syncTools() {
  document.querySelectorAll("#tools [data-color]").forEach((b) => b.classList.toggle("on", board.mode === "pen" && board.color === b.dataset.color));
  $("#t-eraser").classList.toggle("on", board.mode === "eraser");
  $("#t-pen").classList.toggle("on", board.penOnly);
  $("#t-width").textContent = board.width > 3 ? "🖊️" : "✒️";
  $("#t-width").title = board.width > 3 ? "굵게 (누르면 가늘게)" : "가늘게 (누르면 굵게)";
  localStorage.setItem("penPrefs", JSON.stringify({ penOnly: board.penOnly, width: board.width }));
}
document.querySelectorAll("#tools [data-color]").forEach((b) => (b.onclick = () => { board.mode = "pen"; board.color = b.dataset.color; syncTools(); }));
$("#t-width").onclick = () => { board.width = board.width > 3 ? 3 : 5; syncTools(); };
$("#t-eraser").onclick = () => { board.mode = board.mode === "eraser" ? "pen" : "eraser"; syncTools(); };
$("#t-pen").onclick = () => {
  board.penOnly = !board.penOnly;
  toast(board.penOnly ? "펜으로만 써져요. 손가락으로는 스크롤해요." : "손가락으로도 써져요.");
  syncTools();
};
$("#t-undo").onclick = () => {
  const a = undoStack.pop();
  if (!a) return;
  if (a.type === "add") { board.erase([a.id]); socket.emit("stroke:erase", { problemId: curId, ids: [a.id] }); }
  else { board.restore(a.ids); socket.emit("stroke:restore", { problemId: curId, ids: a.ids }); }
};
$("#t-clear").onclick = () => {
  const ids = board.liveIds();
  if (!ids.length || !confirm("이 문제의 필기를 모두 지울까요?")) return;
  board.erase(ids);
  socket.emit("stroke:erase", { problemId: curId, ids });
  undoStack.push({ type: "erase", ids });
};
syncTools();

$("#toggle-p").onclick = () => {
  const p = $("#ppanel");
  p.classList.toggle("collapsed");
  $("#toggle-p").textContent = p.classList.contains("collapsed") ? "펼치기" : "접기";
};

// ---------- 문제 전환
function renderTabs() {
  const nav = $("#ptabs");
  nav.replaceChildren(...problems.map((p, i) =>
    h("button", {
      className: [p.id === curId ? "cur" : "", submitted[p.id] !== undefined ? "done" : ""].join(" "),
      onclick: () => openProblem(p.id),
    }, p.label || String(i + 1))));
  nav.querySelector(".cur")?.scrollIntoView({ inline: "nearest", block: "nearest" });
}

function renderSubmitState() {
  const ans = submitted[curId];
  $("#submit-st").textContent = ans !== undefined ? "제출됨 ✓ (고쳐서 다시 낼 수 있어요)" : "";
  $("#submit").textContent = ans !== undefined ? "다시 제출" : "제출";
}

function openProblem(id) {
  const p = problems.find((x) => x.id === id);
  if (!p) return;
  curId = id;
  undoStack = [];
  $("#problem").replaceChildren(renderProblem(p));
  $("#wrap").scrollTop = 0;
  board.setStrokes([]);
  renderTabs();
  socket.emit("work:open", { problemId: id }, (r) => {
    if (r?.error) return toast(r.error, "error");
    if (curId !== id) return;
    board.setStrokes(r.strokes);
    $("#answer").value = r.answer || "";
    if (r.submittedAt) submitted[id] = r.answer;
    renderSubmitState();
    renderTabs();
  });
  renderSubmitState();
}

$("#submit").onclick = () => {
  const answer = $("#answer").value.trim();
  if (!answer && !confirm("답을 비워둔 채 제출할까요? (풀이 과정만 제출)")) return;
  $("#submit").disabled = true;
  socket.emit("work:submit", { problemId: curId, answer }, (r) => {
    $("#submit").disabled = false;
    if (r?.error) return toast(r.error, "error");
    submitted[curId] = answer;
    toast("제출했어요 👍");
    renderSubmitState();
    renderTabs();
  });
};
$("#answer").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#submit").click(); });

// ---------- 수업 상태
async function loadLesson() {
  const r = await api("/student/lesson");
  if (!r.lesson) {
    lesson = null;
    $("#waiting").classList.remove("hidden");
    return;
  }
  const changed = lesson?.id !== r.lesson.id;
  lesson = r.lesson;
  problems = r.problems;
  submitted = r.submitted || {};
  $("#lesson-title").textContent = lesson.title;
  $("#waiting").classList.toggle("hidden", problems.length > 0);
  if (!problems.length) $("#wait-title").textContent = "선생님이 문제를 준비하고 있어요";
  if (changed || !problems.some((p) => p.id === curId)) {
    const start = problems.find((p) => p.id === lesson.focus_problem_id) || problems[0];
    if (start) openProblem(start.id);
  } else renderTabs();
}

// ---------- 실시간 연결
const socket = io({ auth: { token: auth.token }, transports: ["websocket", "polling"] });
socket.on("connect", () => {
  $("#conn").classList.add("on");
  const prev = curId; // 재접속이면 같은 문제를 다시 열어 서버와 필기 동기화
  socket.emit("lesson:sync", {}, () => loadLesson().then(() => { if (prev && prev === curId && lesson) openProblem(curId); }));
});
socket.on("disconnect", () => $("#conn").classList.remove("on"));
socket.on("connect_error", (e) => { if (e.message === "unauthorized") logout(); });

socket.on("lesson:start", () => socket.emit("lesson:sync", {}, () => { lesson = null; loadLesson(); toast("수업이 시작되었어요!"); }));
socket.on("lesson:end", () => {
  lesson = null; problems = []; curId = null;
  $("#wait-title").textContent = "수업이 끝났어요. 수고했어요!";
  $("#waiting").classList.remove("hidden");
});
socket.on("lesson:problems", ({ problems: list }) => {
  const had = new Set(problems.map((p) => p.id));
  problems = list;
  $("#waiting").classList.toggle("hidden", problems.length > 0);
  if (!curId && problems[0]) openProblem(problems[0].id);
  else renderTabs();
  if (list.some((p) => !had.has(p.id))) toast("새 문제가 추가됐어요");
});
socket.on("lesson:focus", ({ problemId }) => {
  if (problemId === curId) return;
  const p = problems.find((x) => x.id === problemId);
  if (!p) return;
  openProblem(problemId);
  toast(`선생님이 ${pLabel(p.label)} 문제로 이동했어요`);
});
socket.on("message", (m) => {
  document.querySelector(".msg")?.remove();
  const box = h("div.msg",
    h("div.small.muted", `📢 ${m.from} 선생님`),
    h("div", { style: { fontSize: "18px", margin: "6px 0 10px", whiteSpace: "pre-wrap", userSelect: "text" } }, m.text),
    h("button.primary", { onclick: () => box.remove() }, "확인"));
  document.body.append(box);
});
