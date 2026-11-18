import { api, h, $, toast, modal, renderProblem, requireLogin, logout, fmtTime, pLabel } from "/js/common.js";
import { mountMonitor } from "/js/monitor.js";
import { openCropper, openHwpxImport, openManualInput } from "/js/importers.js";

const me = requireLogin("teacher");
$("#me").textContent = `${me.name} 선생님`;
if (me.is_admin) $("#nav-admin").classList.remove("hidden");

const view = $("#view");
let cleanup = null;
const KIND = { textbook: "교과서", worksheet: "학습지", quick: "즉석" };

// ---------- 라우터
const routes = [
  [/^\/$/, pageHome],
  [/^\/classes$/, pageClasses],
  [/^\/class\/([\w-]+)$/, pageClass],
  [/^\/sets$/, pageSets],
  [/^\/set\/([\w-]+)$/, pageSet],
  [/^\/lessons$/, pageLessons],
  [/^\/lesson\/new$/, pageNewLesson],
  [/^\/lesson\/([\w-]+)$/, pageMonitor],
  [/^\/admin$/, pageAdmin],
  [/^\/account$/, pageAccount],
];
async function route() {
  cleanup?.(); cleanup = null;
  const [path, query] = (location.hash.slice(1) || "/").split("?");
  const params = new URLSearchParams(query || "");
  view.className = "";
  document.querySelectorAll("#nav a").forEach((a) => {
    const href = a.getAttribute("href").slice(1);
    a.classList.toggle("on", href === "/" ? path === "/" : path.startsWith(href.replace(/s$/, "").replace(/classe$/, "class")));
  });
  for (const [re, fn] of routes) {
    const m = path.match(re);
    if (m) {
      view.replaceChildren(h("p.muted", "불러오는 중…"));
      try { await fn(...m.slice(1), params); }
      catch (e) { view.replaceChildren(h("div.card", h("b", "문제가 생겼어요"), h("p", e.message))); }
      return;
    }
  }
  location.hash = "#/";
}
window.addEventListener("hashchange", route);
route();

const go = (hash) => { location.hash = hash; };
const head = (title, ...actions) => h("div.page-head", h("h1", title), h("span.spacer"), ...actions);

// ---------- 홈
async function pageHome() {
  const [{ lessons }, { classes }] = await Promise.all([api("/lessons"), api("/classes")]);
  const liveL = lessons.filter((l) => l.status === "live");
  view.replaceChildren(
    head(`안녕하세요, ${me.name} 선생님`),
    h("div.section",
      h("h2", "진행 중인 수업"),
      liveL.length
        ? h("div.grid", liveL.map((l) => h("div.list-item", { onclick: () => go(`#/lesson/${l.id}`) },
            h("span.badge.ok", "● 진행 중"), h("div.grow", h("b", l.title), h("div.small.muted", `${l.class_name} · 문제 ${l.problem_count}개`)), h("span", "→"))))
        : h("p.muted", "진행 중인 수업이 없습니다.")),
    h("div.section",
      h("h2", "내 학급"),
      classes.length
        ? h("div.grid", classes.map((c) => h("div.list-item", { onclick: () => go(`#/class/${c.id}`) },
            h("div.grow", h("b", c.name), h("div.small.muted", `${c.school_year}학년도 · 학생 ${c.student_count}명`)),
            c.live_lesson_id
              ? h("button.sm", { onclick: (e) => { e.stopPropagation(); go(`#/lesson/${c.live_lesson_id}`); } }, "수업 보기")
              : h("button.sm.primary", { onclick: (e) => { e.stopPropagation(); go(`#/lesson/new?class=${c.id}`); } }, "수업 시작"))))
        : h("div.card", h("p", "아직 담당 학급이 없어요."), h("button.primary", { onclick: () => go("#/classes") }, "학급 추가하기"))),
  );
}

// ---------- 학급
async function pageClasses() {
  const { classes, schoolYear } = await api("/classes");
  const grade = h("select", [1, 2, 3, 4, 5, 6].map((g) => h("option", { value: g }, `${g}학년`)));
  const classNo = h("input", { type: "number", min: 1, max: 30, placeholder: "반", style: { width: "90px" } });
  const year = h("input", { type: "number", value: schoolYear, style: { width: "110px" } });
  view.replaceChildren(
    head("학급"),
    h("div.card.section",
      h("h3", "학급 추가 / 합류"),
      h("p.small.muted", "같은 학년도·학년·반이 이미 있으면 그 학급에 담당 교사로 합류합니다. (한 학급을 여러 선생님이 함께 담당)"),
      h("div.row", year, h("span", "학년도"), grade, classNo, h("span", "반"),
        h("button.primary", {
          onclick: async () => {
            try {
              const r = await api("/classes", { method: "POST", body: { schoolYear: year.value, grade: grade.value, classNo: classNo.value } });
              toast(r.joined ? "기존 학급에 담당 교사로 합류했어요" : "학급을 만들었어요");
              go(`#/class/${r.id}`);
            } catch (e) { toast(e.message, "error"); }
          },
        }, "추가"))),
    h("div.grid", classes.map((c) => h("div.list-item", { onclick: () => go(`#/class/${c.id}`) },
      h("div.grow", h("b", c.name), h("div.small.muted", `${c.school_year}학년도 · 학생 ${c.student_count}명 · ${c.teacher_names || ""}`)),
      c.live_lesson_id && h("span.badge.ok", "수업 중")))),
  );
}

function printPins(className, list) {
  const m = modal([
    h("div.row.no-print", h("h2.grow", "학생 비밀번호 안내"), h("button", { onclick: () => window.print() }, "🖨️ 인쇄"), h("button", { onclick: () => m.close() }, "닫기")),
    h("p.small.muted.no-print", "이 화면을 닫으면 비밀번호를 다시 볼 수 없어요. (필요하면 학생별로 재설정)"),
    h("div.pin-cards", list.map((s) => h("div.pin-card",
      h("div", className), h("div", `${s.student_no} ${s.name}`),
      h("div", "주소: ", location.host), h("div", "비밀번호: ", h("b", s.password))))),
  ]);
  m.box.style.width = "min(900px, 100%)";
  // 인쇄 시 모달만
  const style = h("style", "@media print { body > *:not(.modal-back) { display:none !important } .modal-back{position:static;background:none} .modal{max-height:none;width:100%!important} }");
  m.box.append(style);
}

async function pageClass(id) {
  const { class: c, teachers, students, lessons } = await api(`/classes/${id}`);
  const rows = h("textarea", { placeholder: "엑셀에서 복사해 붙여넣기\n20301\t김민준\n20302\t이서연\t1234   ← 비밀번호를 지정하려면 세 번째 칸에 4자리\n(비밀번호를 비우면 자동 생성)", rows: 6 });
  const tbody = h("tbody", students.map((s) => h("tr",
    h("td", s.student_no), h("td", s.name),
    h("td", { style: { textAlign: "right" } },
      h("button.sm", {
        onclick: async () => {
          if (!confirm(`${s.name} 학생의 비밀번호를 새로 만들까요?`)) return;
          const r = await api(`/students/${s.id}/reset`, { method: "POST" });
          printPins(c.name, [r]);
        },
      }, "비밀번호 재설정"), " ",
      h("button.sm.danger", {
        onclick: async () => {
          if (!confirm(`${s.name} 학생을 명단에서 삭제할까요? (풀이 기록도 삭제됩니다)`)) return;
          await api(`/students/${s.id}`, { method: "DELETE" }); route();
        },
      }, "삭제")))));
  view.replaceChildren(
    head(`${c.name}`, h("span.muted", `${c.school_year}학년도`),
      h("button.primary", { onclick: () => go(`#/lesson/new?class=${c.id}`) }, "수업 시작")),
    h("p.muted", "담당: ", teachers.map((t) => t.name).join(", ")),
    h("div.section.card",
      h("h3", `학생 명단 (${students.length}명)`),
      h("p.small.muted", "학생 아이디 = 학번. 학번 + 4자리 비밀번호로 로그인합니다."),
      students.length ? h("table", h("thead", h("tr", h("th", "학번"), h("th", "이름"), h("th"))), tbody) : h("p.muted", "아직 학생이 없어요."),
      h("h3", { style: { marginTop: "18px" } }, "학생 추가 (붙여넣기)"),
      rows,
      h("div.row", { style: { marginTop: "8px" } }, h("button.primary", {
        onclick: async () => {
          try {
            const r = await api(`/classes/${c.id}/students`, { method: "POST", body: { rows: rows.value } });
            if (r.errors.length) alert("일부 줄을 건너뛰었어요:\n" + r.errors.join("\n"));
            toast(`추가 ${r.created.length}명, 수정 ${r.updated.length}명`);
            const withPw = [...r.created, ...r.updated.filter((u) => u.password)];
            if (withPw.length) printPins(c.name, withPw);
            route();
          } catch (e) { toast(e.message, "error"); }
        },
      }, "명단 등록"))),
    h("div.section",
      h("h2", "수업 기록"),
      lessons.length ? h("div.col", lessons.map((l) => h("div.list-item", { onclick: () => go(`#/lesson/${l.id}`) },
        l.status === "live" ? h("span.badge.ok", "진행 중") : h("span.badge", "종료"),
        h("div.grow", h("b", l.title), h("div.small.muted", `${fmtTime(l.started_at)} · ${l.teacher_name}`))))) : h("p.muted", "아직 수업 기록이 없어요.")),
    h("button.danger", {
      onclick: async () => {
        if (!confirm("이 학급의 담당에서 빠질까요? (학급과 학생 정보는 남습니다)")) return;
        await api(`/classes/${c.id}/me`, { method: "DELETE" }); go("#/classes");
      },
    }, "담당 해제"),
  );
}

// ---------- 문제 세트
async function pageSets(params) {
  const { sets } = await api("/sets");
  const filter = params.get("f") || "all";
  const shown = sets.filter((s) => filter === "all" || (filter === "mine" ? s.mine : filter === "shared" ? !s.mine : s.kind === filter));
  const title = h("input", { placeholder: "예) 중2 수학 교과서 Ⅲ. 일차함수" });
  const kind = h("select", h("option", { value: "textbook" }, "교과서"), h("option", { value: "worksheet", selected: true }, "학습지"));
  const grade = h("input", { placeholder: "학년 (예: 중2)", style: { width: "120px" } });
  const shared = h("input", { type: "checkbox", style: { width: "auto", minHeight: 0 } });
  const tab = (f, label) => h(`button.sm${filter === f ? ".on" : ""}`, { onclick: () => go(`#/sets?f=${f}`) }, label);
  view.replaceChildren(
    head("문제 세트"),
    h("div.card.section",
      h("h3", "새 문제 세트"),
      h("div.row", h("div.grow", title), kind, grade,
        h("label.row.small", shared, "다른 선생님과 공유"),
        h("button.primary", {
          onclick: async () => {
            try {
              const r = await api("/sets", { method: "POST", body: { title: title.value, kind: kind.value, grade: grade.value, shared: shared.checked } });
              go(`#/set/${r.id}`);
            } catch (e) { toast(e.message, "error"); }
          },
        }, "만들기")),
      h("p.small.muted", "교과서 세트를 만들어 공유해 두면, 다른 선생님도 그대로 수업에 쓰거나 복사해서 고칠 수 있어요.")),
    h("div.pill-tabs", tab("all", "전체"), tab("mine", "내 세트"), tab("shared", "공유받은 세트"), tab("textbook", "교과서"), tab("worksheet", "학습지"), tab("quick", "즉석")),
    shown.length ? h("div.grid", shown.map((s) => h("div.list-item", { onclick: () => go(`#/set/${s.id}`) },
      h("span.badge.blue", KIND[s.kind]),
      h("div.grow", h("b", s.title), h("div.small.muted", [s.grade, `${s.problem_count}문제`, s.mine ? "내 세트" : `${s.owner_name} 선생님`].filter(Boolean).join(" · "))),
      s.shared ? h("span.badge", "공유") : null))) : h("p.muted", "문제 세트가 없어요."),
  );
}

async function pageSet(id) {
  const { set, problems } = await api(`/sets/${id}`);
  const reload = () => route();
  const filePick = (accept, multiple, fn) => {
    const inp = h("input", { type: "file", accept, multiple, style: { display: "none" } });
    inp.onchange = () => { if (inp.files.length) fn([...inp.files]); inp.remove(); };
    document.body.append(inp);
    inp.click();
  };
  const actions = set.mine
    ? [
        h("button.primary", { onclick: () => filePick("application/pdf", false, ([f]) => openCropper({ setId: id, files: [f], type: "pdf", onDone: reload })) }, "📄 PDF에서 자르기"),
        h("button", { onclick: () => filePick(".hwpx", false, ([f]) => openHwpxImport({ setId: id, file: f, onDone: reload })) }, "📝 한글(hwpx) 가져오기"),
        h("button", { onclick: () => filePick("image/*", true, (files) => openCropper({ setId: id, files, type: "image", onDone: reload })) }, "🖼️ 사진/이미지"),
        h("button", { onclick: () => openManualInput({ setId: id, onDone: reload }) }, "⌨️ 직접 입력"),
      ]
    : [h("button.primary", { onclick: async () => { const r = await api(`/sets/${id}/copy`, { method: "POST" }); toast("내 세트로 복사했어요"); go(`#/set/${r.id}`); } }, "내 세트로 복사")];

  const meta = set.mine ? editSetMeta(set) : h("p.muted", `${set.owner_name} 선생님의 공유 세트 (보기 전용)`);
  const move = async (i, d) => {
    const ids = problems.map((p) => p.id);
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await api(`/sets/${id}/reorder`, { method: "POST", body: { ids } });
    reload();
  };
  view.replaceChildren(
    head(set.title, h("span.badge.blue", KIND[set.kind]), set.shared ? h("span.badge", "공유 중") : null),
    meta,
    h("div.row.section", ...actions),
    problems.length ? h("div.pgrid", problems.map((p, i) => problemCard(p, set.mine, () => move(i, -1), () => move(i, 1), reload)))
      : h("div.card", h("p.muted", "아직 문제가 없어요. 위 버튼으로 PDF·한글·사진에서 문제를 가져오세요.")),
  );
}

function editSetMeta(set) {
  const title = h("input", { value: set.title });
  const kind = h("select", ["textbook", "worksheet", "quick"].map((k) => h("option", { value: k, selected: k === set.kind }, KIND[k])));
  const grade = h("input", { value: set.grade || "", placeholder: "학년", style: { width: "110px" } });
  const unit = h("input", { value: set.unit || "", placeholder: "단원", style: { width: "180px" } });
  const shared = h("input", { type: "checkbox", checked: !!set.shared, style: { width: "auto", minHeight: 0 } });
  return h("details.card.section",
    h("summary", { style: { cursor: "pointer" } }, "세트 정보 수정 · 공유 설정"),
    h("div.row", { style: { marginTop: "10px" } }, h("div.grow", title), kind, grade, unit, h("label.row.small", shared, "공유"),
      h("button.primary", {
        onclick: async () => {
          await api(`/sets/${set.id}`, { method: "PATCH", body: { title: title.value, kind: kind.value, grade: grade.value, unit: unit.value, shared: shared.checked } });
          toast("저장했어요"); route();
        },
      }, "저장"),
      h("button.danger", {
        onclick: async () => {
          if (!confirm("이 문제 세트를 삭제할까요? 지난 수업 기록에서도 문제가 보이지 않게 됩니다.")) return;
          try { await api(`/sets/${set.id}`, { method: "DELETE" }); go("#/sets"); } catch (e) { toast(e.message, "error"); }
        },
      }, "삭제")));
}

function problemCard(p, editable, up, down, reload) {
  const label = h("input", { value: p.label || "", style: { width: "70px" }, disabled: !editable });
  const answer = h("input", { value: p.answer || "", placeholder: "정답 (여러 개는 | 로 구분)", disabled: !editable });
  const save = async () => {
    await api(`/problems/${p.id}`, { method: "PATCH", body: { label: label.value, answer: answer.value } });
    toast("저장됨");
  };
  label.onchange = save; answer.onchange = save;
  return h("div.pcard",
    h("div.row", label, h("div.grow", answer)),
    renderProblem(p, { showLabel: false }),
    editable && h("div.row",
      h("button.sm", { onclick: up }, "↑"), h("button.sm", { onclick: down }, "↓"),
      p.kind === "rich" && h("button.sm", { onclick: () => openManualInput({ problem: p, onDone: reload }) }, "본문 수정"),
      h("span.spacer"),
      h("button.sm.danger", { onclick: async () => { if (confirm("이 문제를 삭제할까요?")) { await api(`/problems/${p.id}`, { method: "DELETE" }); reload(); } } }, "삭제")));
}

// ---------- 수업
async function pageLessons() {
  const { lessons } = await api("/lessons");
  view.replaceChildren(
    head("수업 기록"),
    lessons.length ? h("div.col", lessons.map((l) => h("div.list-item", { onclick: () => go(`#/lesson/${l.id}`) },
      l.status === "live" ? h("span.badge.ok", "진행 중") : h("span.badge", "종료"),
      h("div.grow", h("b", l.title), h("div.small.muted", `${l.class_name} · 문제 ${l.problem_count}개 · ${fmtTime(l.started_at)}`))))) : h("p.muted", "아직 수업이 없어요."),
  );
}

async function pageNewLesson(params) {
  const [{ classes }, { sets }] = await Promise.all([api("/classes"), api("/sets")]);
  if (!classes.length) { view.replaceChildren(h("div.card", h("p", "먼저 학급을 추가하세요."), h("button.primary", { onclick: () => go("#/classes") }, "학급으로"))); return; }
  const cls = h("select", classes.map((c) => h("option", { value: c.id, selected: c.id === params.get("class") }, `${c.name} (${c.school_year})`)));
  const title = h("input", { placeholder: "수업 제목 (예: 일차함수 그래프 연습)" });
  const picked = []; // [{id,label,set_title}]
  const pickedBox = h("div.col");
  const setSel = h("select", h("option", { value: "" }, "— 문제 세트 선택 —"),
    sets.map((s) => h("option", { value: s.id }, `[${KIND[s.kind]}] ${s.title} (${s.problem_count})${s.mine ? "" : " · " + s.owner_name}`)));
  const probBox = h("div.pgrid");
  const renderPicked = () => {
    pickedBox.replaceChildren(picked.length
      ? h("div.row", picked.map((p, i) => h("span.badge.blue", `${i + 1}. ${pLabel(p.label)} (${p.set_title})`,
          h("button.sm.ghost", { onclick: () => { picked.splice(i, 1); renderPicked(); syncSel(); } }, "✕"))))
      : h("p.muted.small", "문제를 고르지 않아도 시작할 수 있어요. (수업 중 즉석 문제 추가 가능)"));
  };
  let shownProblems = [];
  const syncSel = () => probBox.querySelectorAll(".pcard").forEach((el, i) => el.classList.toggle("sel", picked.some((p) => p.id === shownProblems[i]?.id)));
  setSel.onchange = async () => {
    if (!setSel.value) return probBox.replaceChildren();
    const { set, problems } = await api(`/sets/${setSel.value}`);
    shownProblems = problems;
    probBox.replaceChildren(...problems.map((p) => {
      const card = h("div.pcard", { style: { cursor: "pointer" } }, h("b", pLabel(p.label)), renderProblem(p, { showLabel: false }));
      card.onclick = () => {
        const i = picked.findIndex((x) => x.id === p.id);
        if (i >= 0) picked.splice(i, 1); else picked.push({ id: p.id, label: p.label, set_title: set.title });
        renderPicked(); syncSel();
      };
      return card;
    }));
    syncSel();
  };
  const selectAll = h("button.sm", {
    onclick: async () => {
      if (!setSel.value) return;
      const { set } = await api(`/sets/${setSel.value}`);
      for (const p of shownProblems) if (!picked.some((x) => x.id === p.id)) picked.push({ id: p.id, label: p.label, set_title: set.title });
      renderPicked(); syncSel();
    },
  }, "이 세트 전체 선택");
  renderPicked();
  view.replaceChildren(
    head("수업 시작"),
    h("div.card.section", h("div.row", cls, h("div.grow", title))),
    h("div.card.section", h("h3", "고른 문제 (순서대로 표시)"), pickedBox,
      h("div.row", { style: { marginTop: "12px" } }, h("button.primary", {
        onclick: async () => {
          try {
            const r = await api("/lessons", { method: "POST", body: { classId: cls.value, title: title.value, problemIds: picked.map((p) => p.id) } });
            go(`#/lesson/${r.id}`);
          } catch (e) { toast(e.message, "error"); }
        },
      }, "▶ 수업 시작 (학생 화면에 문제가 뜹니다)"))),
    h("div.row.section", setSel, selectAll),
    probBox,
  );
}

async function pageMonitor(id) {
  view.className = "wide";
  cleanup = await mountMonitor(view, id);
}

// ---------- 관리자
async function pageAdmin() {
  const { teachers } = await api("/admin/teachers");
  const loginId = h("input", { placeholder: "아이디" });
  const name = h("input", { placeholder: "이름" });
  const pw = h("input", { placeholder: "초기 비밀번호 (6자 이상)" });
  view.replaceChildren(
    head("교사 관리"),
    h("div.card.section", h("h3", "교사 계정 추가"),
      h("div.row", loginId, name, pw, h("button.primary", {
        onclick: async () => {
          try { await api("/admin/teachers", { method: "POST", body: { loginId: loginId.value, name: name.value, password: pw.value } }); toast("추가했어요"); route(); }
          catch (e) { toast(e.message, "error"); }
        },
      }, "추가"))),
    h("table.card", h("thead", h("tr", h("th", "아이디"), h("th", "이름"), h("th", "권한"), h("th"))),
      h("tbody", teachers.map((t) => h("tr", h("td", t.login_id), h("td", t.name), h("td", t.is_admin ? "관리자" : "교사"),
        h("td", h("button.sm", {
          onclick: async () => {
            const p = prompt(`${t.name} 선생님의 새 비밀번호 (6자 이상)`);
            if (!p) return;
            try { await api(`/admin/teachers/${t.id}/password`, { method: "POST", body: { password: p } }); toast("변경했어요"); } catch (e) { toast(e.message, "error"); }
          },
        }, "비밀번호 변경")))))),
  );
}

async function pageAccount() {
  const oldPw = h("input", { type: "password", placeholder: "현재 비밀번호" });
  const newPw = h("input", { type: "password", placeholder: "새 비밀번호 (6자 이상)" });
  view.replaceChildren(
    head("내 계정", h("button", { onclick: logout }, "로그아웃")),
    h("div.card", { style: { maxWidth: "420px" } }, h("p", `${me.name} (${me.login_id})`),
      h("div.col", oldPw, newPw, h("button.primary", {
        onclick: async () => {
          try { await api("/me/password", { method: "POST", body: { oldPassword: oldPw.value, newPassword: newPw.value } }); toast("비밀번호를 바꿨어요"); oldPw.value = newPw.value = ""; }
          catch (e) { toast(e.message, "error"); }
        },
      }, "비밀번호 변경"))),
  );
}
