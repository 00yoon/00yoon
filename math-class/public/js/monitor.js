// 실시간 모니터링: 학생 카드 격자 + 크게 보기(실시간/재생/지운 흔적)
import { api, auth, h, toast, modal, renderProblem, fmtDuration, pLabel } from "/js/common.js";
import { Board } from "/js/board.js";

export async function mountMonitor(root, lessonId) {
  const socket = io({ auth: { token: auth.token }, transports: ["websocket", "polling"] });
  let lesson, problems = [], students = [], offset = 0;
  const works = new Map(); // `${sid}:${pid}` → work (summary [+ strokes])
  const cards = new Map(); // sid → card
  const loading = new Set();
  let filter = localStorage.getItem(`mon:${lessonId}:filter`) || "current";
  let sortBy = localStorage.getItem("mon:sort") || "no";
  let stuckSec = +(localStorage.getItem("mon:stuck") || 90);
  let cardW = +(localStorage.getItem("mon:cardw") || 220);
  let detail = null;
  const snow = () => Date.now() + offset; // 서버 기준 현재 시각
  const K = (sid, pid) => `${sid}:${pid}`;
  const live = () => lesson?.status === "live";

  // ---------- 화면 뼈대
  const chips = h("div.chips");
  const stats = h("div.stats");
  const grid = h("div.sgrid");
  const headEl = h("div.mon-head");
  root.replaceChildren(headEl, chips, stats, grid);

  function renderHead() {
    const end = h("button.danger", {
      onclick: async () => {
        if (!confirm("수업을 끝낼까요? 학생 화면이 닫히고 기록은 저장됩니다.")) return;
        await api(`/lessons/${lessonId}/end`, { method: "POST" });
        lesson.status = "ended"; renderHead(); renderChips(); toast("수업을 끝냈어요");
      },
    }, "수업 종료");
    const sortSel = h("select", { style: { width: "auto" }, onchange: (e) => { sortBy = e.target.value; localStorage.setItem("mon:sort", sortBy); layoutGrid(); } },
      h("option", { value: "no", selected: sortBy === "no" }, "학번순"),
      h("option", { value: "status", selected: sortBy === "status" }, "막힘 먼저"));
    const stuckSel = h("select", { style: { width: "auto" }, title: "이 시간 동안 필기가 없으면 '막힘'", onchange: (e) => { stuckSec = +e.target.value; localStorage.setItem("mon:stuck", stuckSec); tick(); } },
      [60, 90, 120, 180, 300].map((s) => h("option", { value: s, selected: s === stuckSec }, `막힘 ${s >= 60 ? s / 60 + "분" : s + "초"}`)));
    const sizeSel = h("select", { style: { width: "auto" }, onchange: (e) => { cardW = +e.target.value; localStorage.setItem("mon:cardw", cardW); grid.style.setProperty("--card-w", `${cardW}px`); } },
      [[170, "작게"], [220, "보통"], [300, "크게"], [420, "아주 크게"]].map(([v, l]) => h("option", { value: v, selected: v === cardW }, l)));
    headEl.replaceChildren(
      h("h1", lesson.title),
      h("span.badge", lesson.class_name || ""),
      live() ? h("span.badge.ok", "● 진행 중") : h("span.badge", "종료된 수업"),
      h("span.spacer"),
      sortSel, stuckSel, sizeSel,
      live() && h("button", { onclick: openAddProblems }, "＋ 문제 추가"),
      live() && h("button", { onclick: () => sendMessage(null) }, "📢 전체 메시지"),
      live() && end);
    grid.style.setProperty("--card-w", `${cardW}px`);
  }

  function renderChips() {
    const focusBtn = live() && filter !== "current" && filter !== lesson.focus_problem_id
      ? h("button.primary", { onclick: () => socket.emit("lesson:focus", { problemId: filter }) }, "📍 모두 이 문제로 이동")
      : null;
    chips.replaceChildren(
      h(`button${filter === "current" ? ".cur" : ""}`, { onclick: () => setFilter("current") }, "각자 보는 문제"),
      ...problems.map((p) => h(`button${filter === p.id ? ".cur" : ""}${lesson.focus_problem_id === p.id ? ".focus" : ""}`,
        { onclick: () => setFilter(p.id), title: lesson.focus_problem_id === p.id ? "학생들에게 띄운 문제" : "" }, pLabel(p.label))),
      ...(focusBtn ? [focusBtn] : []));
  }
  function setFilter(f) {
    filter = f;
    localStorage.setItem(`mon:${lessonId}:filter`, f);
    renderChips();
    for (const s of students) showOnCard(s.id);
    tick();
  }

  // ---------- 카드
  function shownProblem(s) {
    if (filter !== "current") return filter;
    if (s.current) return s.current;
    let best = null;
    for (const w of works.values()) if (w.studentId === s.id && (!best || w.lastActivity > best.lastActivity)) best = w;
    return best?.problemId || lesson.focus_problem_id || problems[0]?.id;
  }

  function makeCard(s) {
    const canvas = h("canvas");
    const thumb = h("div.thumb", canvas);
    const badge = h("span.badge");
    const plabel = h("span.pl");
    const foot = h("div.foot");
    const el = h("div.scard", { onclick: () => openDetail(s.id, card.pid) },
      h("div.top", h("span.name", `${s.student_no.slice(-2)} ${s.name}`), plabel, h("span.spacer"), badge), thumb, foot);
    const board = new Board(canvas, { fitContent: true, minViewH: 420, dpr: Math.min(1.5, devicePixelRatio || 1) });
    const card = { el, board, badge, foot, plabel, pid: null, key: null };
    cards.set(s.id, card);
    return card;
  }

  function showOnCard(sid) {
    const s = students.find((x) => x.id === sid);
    const card = cards.get(sid);
    if (!s || !card) return;
    const pid = shownProblem(s);
    card.pid = pid;
    const key = K(sid, pid);
    const p = problems.find((x) => x.id === pid);
    card.plabel.textContent = filter === "current" && p ? `· ${pLabel(p.label)}` : "";
    if (card.key === key && works.get(key)?.strokes) return;
    card.key = key;
    const w = works.get(key);
    if (w?.strokes) card.board.setStrokes(w.strokes);
    else { card.board.setStrokes([]); if (w || s.online) ensureStrokes(sid, pid); }
  }

  function ensureStrokes(sid, pid) {
    const key = K(sid, pid);
    if (works.get(key)?.strokes || loading.has(key)) return;
    loading.add(key);
    socket.emit("work:get", { studentId: sid, problemId: pid }, (r) => {
      loading.delete(key);
      if (!r?.work) return;
      works.set(key, r.work);
      const card = cards.get(sid);
      if (card?.key === key) card.board.setStrokes(r.work.strokes);
      if (detail?.key === key) detail.load(r.work);
    });
  }

  function statusOf(s, w) {
    if (w?.submittedAt) {
      if (w.autoCorrect === 1) return { cls: "ok", text: "정답", rank: 4 };
      if (w.autoCorrect === 0) return { cls: "bad", text: "오답", rank: 1 };
      return { cls: "blue", text: "제출", rank: 3 };
    }
    if (!s.online && live()) return { cls: "off", text: w ? "접속 끊김" : "미접속", rank: 2.5 };
    if (!live()) return { cls: "off", text: w?.strokeCount ? "미제출" : "안 풂", rank: 2 };
    if (!w) return { cls: "", text: "대기", rank: 2 };
    const idle = snow() - w.lastActivity;
    if (idle > stuckSec * 1000) return { cls: "warn", text: w.strokeCount ? `막힘 ${fmtDuration(idle)}` : "시작 안 함", rank: 0 };
    return { cls: "", text: "풀이 중", rank: 2 };
  }

  function tick() {
    let on = 0, sub = 0, ok = 0, bad = 0, stuck = 0;
    for (const s of students) {
      const card = cards.get(s.id);
      if (!card) continue;
      const w = works.get(card.key);
      const st = statusOf(s, w);
      card.status = st;
      card.badge.className = `badge ${st.cls}`;
      card.badge.textContent = st.text;
      card.el.className = `scard ${!s.online && live() ? "offline" : ""} ${st.cls === "warn" ? "stuck" : ""} ${st.cls === "ok" ? "ok" : ""} ${st.cls === "bad" ? "bad" : ""}`;
      card.foot.textContent = w
        ? `⏱ ${fmtDuration((w.submittedAt || (live() ? snow() : w.lastActivity)) - w.startedAt)} · 획 ${w.strokeCount}${w.erasedCount ? ` · 지움 ${w.erasedCount}` : ""}${w.submittedAt ? ` · 답: ${w.answer || "(빈칸)"}` : ""}`
        : "아직 안 열어봄";
      if (s.online) on++;
      if (w?.submittedAt) { sub++; if (w.autoCorrect === 1) ok++; if (w.autoCorrect === 0) bad++; }
      if (st.cls === "warn") stuck++;
    }
    stats.replaceChildren(
      h("span", "접속 ", h("b", `${on}/${students.length}`)),
      h("span", "제출 ", h("b", sub), ok + bad ? ` (정답 ${ok} · 오답 ${bad})` : ""),
      h("span", "막힘 ", h("b", { style: { color: stuck ? "var(--warn)" : "" } }, stuck)),
      filter !== "current" ? h("span.muted", "· 선택한 문제 기준") : h("span.muted", "· 학생마다 지금 보는 문제"));
    if (sortBy === "status") layoutGrid();
  }

  function layoutGrid() {
    const order = [...students];
    if (sortBy === "status") order.sort((a, b) => (cards.get(a.id)?.status?.rank ?? 9) - (cards.get(b.id)?.status?.rank ?? 9) || a.student_no.localeCompare(b.student_no));
    const els = order.map((s) => cards.get(s.id).el);
    if (els.some((el, i) => grid.children[i] !== el)) grid.replaceChildren(...els);
  }

  // ---------- 서버 이벤트
  const workOf = (sid, pid) => {
    const key = K(sid, pid);
    let w = works.get(key);
    if (!w) { w = { studentId: sid, problemId: pid, startedAt: snow(), lastActivity: snow(), strokeCount: 0, erasedCount: 0 }; works.set(key, w); }
    return w;
  };
  const boardsFor = (sid, pid) => {
    const key = K(sid, pid);
    const list = [];
    const c = cards.get(sid);
    if (c?.key === key) list.push(c.board);
    if (detail?.key === key && detail.isLive()) list.push(detail.board);
    return list;
  };
  const recount = (w) => { if (w.strokes) { w.strokeCount = w.strokes.filter((s) => !s.del).length; w.erasedCount = w.strokes.filter((s) => s.del).length; } };

  socket.on("stroke:begin", ({ studentId, problemId, stroke }) => {
    const w = workOf(studentId, problemId);
    w.lastActivity = snow();
    if (w.strokes) w.strokes.push({ ...stroke, p: stroke.p.slice() });
    w.strokeCount++;
    boardsFor(studentId, problemId).forEach((b) => b.addStroke(stroke));
    detail?.refreshSide();
  });
  socket.on("stroke:add", ({ studentId, problemId, id, p }) => {
    const w = works.get(K(studentId, problemId));
    if (!w) return;
    w.lastActivity = snow();
    const s = w.strokes?.findLast((x) => x.id === id);
    if (s) s.p.push(...p);
    boardsFor(studentId, problemId).forEach((b) => b.appendPoints(id, p));
  });
  const onDel = (restore) => ({ studentId, problemId, ids, at }) => {
    const w = works.get(K(studentId, problemId));
    if (!w) return;
    w.lastActivity = snow();
    const set = new Set(ids);
    w.strokes?.forEach((s) => { if (set.has(s.id)) s.del = restore ? null : at; });
    recount(w);
    boardsFor(studentId, problemId).forEach((b) => (restore ? b.restore(ids) : b.erase(ids, at)));
    detail?.refreshSide();
  };
  socket.on("stroke:erase", onDel(false));
  socket.on("stroke:restore", onDel(true));
  socket.on("work:summary", ({ studentId, work }) => {
    const key = K(studentId, work.problemId);
    const old = works.get(key);
    works.set(key, { ...old, ...work, strokes: work.strokes || old?.strokes });
    showOnCard(studentId);
    tick();
    detail?.refreshSide();
  });
  socket.on("presence", (p) => {
    const s = students.find((x) => x.id === p.studentId);
    if (!s) return;
    const moved = s.current !== p.current;
    Object.assign(s, { online: p.online, current: p.current });
    if (moved && filter === "current") showOnCard(s.id);
    tick();
  });
  socket.on("lesson:focus", ({ problemId }) => { lesson.focus_problem_id = problemId; renderChips(); });
  socket.on("lesson:problems", ({ problems: list }) => { problems = list; renderChips(); });
  socket.on("lesson:end", () => { lesson.status = "ended"; renderHead(); renderChips(); tick(); });
  socket.on("connect", join);

  function join() {
    socket.emit("monitor:join", { lessonId }, (r) => {
      if (r?.error) { root.replaceChildren(h("div.card", r.error)); return; }
      offset = r.serverNow - Date.now();
      const firstLoad = !lesson;
      lesson = { ...r.lesson, class_name: lesson?.class_name };
      problems = r.problems;
      students = r.students;
      works.clear();
      for (const w of r.works) works.set(K(w.studentId, w.problemId), w);
      if (firstLoad) api(`/lessons/${lessonId}`).then((d) => { lesson.class_name = d.lesson.class_name; renderHead(); });
      renderHead(); renderChips();
      for (const s of students) if (!cards.has(s.id)) makeCard(s);
      for (const c of cards.values()) c.key = null;
      layoutGrid();
      for (const s of students) showOnCard(s.id);
      tick();
      if (!students.length) grid.replaceChildren(h("div.card", "이 학급에 학생이 없어요. 학급 화면에서 명단을 등록하세요."));
    });
  }
  const timer = setInterval(tick, 1000);

  // ---------- 메시지
  function sendMessage(studentId, name) {
    const ta = h("textarea", { placeholder: "학생 화면에 바로 표시됩니다", rows: 3 });
    const m = modal([
      h("h3", studentId ? `${name} 학생에게 메시지` : "전체 학생에게 메시지"),
      ta,
      h("div.row", { style: { marginTop: "10px", justifyContent: "flex-end" } },
        h("button", { onclick: () => m.close() }, "취소"),
        h("button.primary", {
          onclick: () => socket.emit("message:send", { studentId, text: ta.value }, (r) => {
            if (r?.error) return toast(r.error, "error");
            toast("보냈어요"); m.close();
          }),
        }, "보내기")),
    ]);
    ta.focus();
  }

  // ---------- 문제 추가 (세트 / 사진 / 손글씨)
  async function openAddProblems() {
    const body = h("div");
    const m = modal([h("h3", "수업에 문제 추가"), h("div.pill-tabs",
      h("button.sm", { onclick: () => fromSets() }, "📚 문제 세트에서"),
      h("button.sm", { onclick: () => fromPhoto() }, "📷 즉석 사진"),
      h("button.sm", { onclick: () => fromHand() }, "✏️ 즉석 손글씨")), body]);
    m.box.style.width = "min(820px, 100%)";

    async function fromSets() {
      const { sets } = await api("/sets");
      const sel = h("select", h("option", { value: "" }, "— 문제 세트 선택 —"), sets.map((s) => h("option", { value: s.id }, `${s.title} (${s.problem_count})`)));
      const box = h("div.pgrid", { style: { marginTop: "10px" } });
      const picked = new Set();
      const add = h("button.primary", { disabled: true }, "추가");
      sel.onchange = async () => {
        picked.clear(); add.disabled = true;
        if (!sel.value) return box.replaceChildren();
        const { problems: list } = await api(`/sets/${sel.value}`);
        const have = new Set(problems.map((p) => p.id));
        box.replaceChildren(...list.map((p) => {
          const c = h("div.pcard", { style: { cursor: have.has(p.id) ? "default" : "pointer", opacity: have.has(p.id) ? 0.4 : 1 } },
            h("b", `${pLabel(p.label)}${have.has(p.id) ? " (이미 있음)" : ""}`), renderProblem(p, { showLabel: false }));
          if (!have.has(p.id)) c.onclick = () => { picked.has(p.id) ? picked.delete(p.id) : picked.add(p.id); c.classList.toggle("sel"); add.disabled = !picked.size; add.textContent = `${picked.size}개 추가`; };
          return c;
        }));
      };
      add.onclick = async () => {
        await api(`/lessons/${lessonId}/problems`, { method: "POST", body: { problemIds: [...picked] } });
        toast("문제를 추가했어요"); m.close();
      };
      body.replaceChildren(h("div.row", h("div.grow", sel), add), box);
    }

    function fromPhoto() {
      const file = h("input", { type: "file", accept: "image/*", capture: "environment" });
      const img = h("img", { style: { maxWidth: "100%", maxHeight: "50vh", display: "none", margin: "10px 0", borderRadius: "8px" } });
      const label = h("input", { placeholder: "번호/이름 (선택)", style: { width: "160px" } });
      const answer = h("input", { placeholder: "정답 (선택)" });
      const send = h("button.primary", { disabled: true }, "학생들에게 보내기");
      file.onchange = () => { if (file.files[0]) { img.src = URL.createObjectURL(file.files[0]); img.style.display = "block"; send.disabled = false; } };
      send.onclick = async () => {
        const f = new FormData();
        f.append("image", file.files[0]); f.append("label", label.value); f.append("answer", answer.value);
        send.disabled = true;
        try { await api(`/lessons/${lessonId}/quick`, { method: "POST", form: f }); toast("모든 학생 화면에 띄웠어요"); m.close(); }
        catch (e) { toast(e.message, "error"); send.disabled = false; }
      };
      body.replaceChildren(h("p.small.muted", "칠판·교재를 찍거나 이미지를 고르면 즉석 문제로 바로 띄웁니다."), file, img, h("div.row", label, h("div.grow", answer), send));
    }

    function fromHand() {
      const canvas = h("canvas");
      const wrap = h("div.board-wrap", { style: { height: "50vh", padding: "8px", borderRadius: "10px" } }, canvas);
      const label = h("input", { placeholder: "번호/이름 (선택)", style: { width: "160px" } });
      const answer = h("input", { placeholder: "정답 (선택)" });
      body.replaceChildren(h("p.small.muted", "여기에 문제를 손으로 쓰고 보내세요."), wrap,
        h("div.row", { style: { marginTop: "8px" } }, label, h("div.grow", answer),
          h("button", { onclick: () => b.setStrokes([]) }, "지우기"),
          h("button.primary", {
            onclick: async () => {
              const blob = await b.toPNG();
              if (!blob) return toast("먼저 문제를 써 주세요", "error");
              const f = new FormData();
              f.append("image", blob, "hand.png"); f.append("label", label.value); f.append("answer", answer.value);
              try { await api(`/lessons/${lessonId}/quick`, { method: "POST", form: f }); toast("모든 학생 화면에 띄웠어요"); m.close(); }
              catch (e) { toast(e.message, "error"); }
            },
          }, "학생들에게 보내기")));
      const b = new Board(canvas, { editable: true });
      b.width = 4;
    }
    fromSets();
  }

  // ---------- 크게 보기
  function openDetail(sid, pid) {
    const s = students.find((x) => x.id === sid);
    if (!s || !pid) return;
    detail?.close();
    let mode = "live"; // live | replay
    let playing = false, raf = 0, vNow = 0, speed = 2, skip = true;
    let map = null; // 재생 시간 압축 매핑

    const canvas = h("canvas");
    const wrap = h("div.board-wrap", canvas);
    const board = new Board(canvas, { dpr: Math.min(2, devicePixelRatio || 1) });
    const side = h("div.detail-side");
    const pchips = h("div.chips");
    const range = h("input", { type: "range", min: 0, max: 1000, value: 1000 });
    const track = h("div.track", range);
    const tlabel = h("span.small", { style: { minWidth: "90px", textAlign: "right" } });
    const playBtn = h("button.sm", "▶");
    const replayBar = h("div.replay.hidden", playBtn, track, tlabel,
      h("select", { style: { width: "auto", minHeight: "32px" }, onchange: (e) => (speed = +e.target.value) },
        [1, 2, 4, 8, 16].map((v) => h("option", { value: v, selected: v === speed }, `${v}배`))),
      h("label.row.small", h("input", { type: "checkbox", checked: skip, style: { width: "auto", minHeight: 0 }, onchange: (e) => { skip = e.target.checked; buildMap(); seek(1); } }), "멈춤 건너뛰기"));
    const toggle = (label, prop, title) => h("button.sm", {
      title,
      onclick: (e) => { board[prop] = !board[prop]; e.target.classList.toggle("on", board[prop]); board.redraw(); },
    }, label);
    const modeBtn = h("button.sm", { onclick: () => setMode(mode === "live" ? "replay" : "live") }, "⏯ 풀이 재생");

    const el = h("div.detail", { onpointerdown: (e) => { if (e.target === el) api_.close(); } },
      h("div.detail-box",
        h("div.detail-main",
          h("div.detail-bar",
            h("b", `${s.student_no} ${s.name}`), pchips, h("span.spacer"),
            modeBtn,
            toggle("지운 흔적", "showDeleted", "지웠던 획을 빨간 점선으로 표시"),
            toggle("시간 색", "timeColor", "먼저 쓴 획=파랑, 나중 쓴 획=주황"),
            live() && h("button.sm", { onclick: () => sendMessage(sid, s.name) }, "💬 메시지"),
            h("button.sm", { onclick: () => api_.close() }, "✕ 닫기")),
          wrap, replayBar),
        side));
    document.body.append(el);

    const api_ = {
      board, key: K(sid, pid),
      isLive: () => mode === "live",
      load(w) { if (mode === "live") board.setStrokes(w.strokes); else { board.setStrokes(w.strokes); buildMap(); seek(+range.value / 1000); } api_.refreshSide(); },
      close() { cancelAnimationFrame(raf); board.destroy(); el.remove(); detail = null; },
      refreshSide,
    };
    detail = api_;

    function renderPChips() {
      pchips.replaceChildren(...problems.map((p) => {
        const w = works.get(K(sid, p.id));
        const mark = w?.submittedAt ? (w.autoCorrect === 1 ? " ✓" : w.autoCorrect === 0 ? " ✗" : " •") : w ? "" : " ·";
        return h(`button${p.id === pid ? ".cur" : ""}`, { onclick: () => { api_.close(); openDetail(sid, p.id); } }, `${p.label || "?"}${mark}`);
      }));
    }

    function refreshSide() {
      const w = works.get(api_.key);
      const p = problems.find((x) => x.id === pid);
      const pauses = board.pauses(15000);
      const longest = pauses.reduce((m, x) => Math.max(m, x.ms), 0);
      side.replaceChildren(
        h("div", h("h3", "문제"), p ? renderProblem(p) : h("p.muted", "삭제된 문제"),
          p?.answer ? h("p.small", "정답: ", h("b", p.answer)) : h("p.small.muted", "정답 미입력")),
        h("div", h("h3", "학생 답"),
          w?.submittedAt
            ? h("div.row", h("span", { style: { fontSize: "20px", fontWeight: 700 } }, w.answer || "(빈칸)"),
                w.autoCorrect === 1 ? h("span.badge.ok", "정답") : w.autoCorrect === 0 ? h("span.badge.bad", "오답") : h("span.badge.blue", "제출"),
                w.submitCount > 1 ? h("span.small.muted", `${w.submitCount}번째 제출`) : null)
            : h("p.muted", "아직 제출 안 함")),
        h("div", h("h3", "풀이 과정"),
          w ? h("dl.kv",
            h("dt", "처음 연 시각"), h("dd", new Date(w.startedAt).toLocaleTimeString("ko-KR")),
            h("dt", "걸린 시간"), h("dd", fmtDuration((w.submittedAt || (live() ? snow() : w.lastActivity)) - w.startedAt)),
            h("dt", "남은 획 / 지운 획"), h("dd", `${w.strokeCount ?? 0} / ${w.erasedCount ?? 0}`),
            h("dt", "15초 이상 멈춤"), h("dd", pauses.length ? `${pauses.length}회 (최장 ${fmtDuration(longest)})` : "없음"),
            h("dt", "마지막 필기"), h("dd", `${fmtDuration(snow() - w.lastActivity)} 전`)) : h("p.muted", "아직 이 문제를 열지 않았어요")),
        h("div.card", { style: { background: "#f8fafc", borderStyle: "dashed" } },
          h("b", "🤖 AI 분석"), h("p.small.muted", { style: { margin: "4px 0 0" } }, "2차에서 연결 예정 — 풀이 옮겨쓰기, 단계별 맞음/틀림, 오류 유형, 오개념, 과정 해석, 피드백 초안")));
      renderPChips();
      drawPauseMarks();
    }

    // 재생: 실제 시간 ↔ 재생 시간 매핑 (긴 멈춤은 1초로 압축)
    function buildMap() {
      const ts = [];
      for (const st of board.strokes) {
        ts.push(st.st);
        for (const pt of st.p) ts.push(st.st + pt[2]);
        if (st.del) ts.push(st.del);
      }
      ts.sort((a, b) => a - b);
      if (!ts.length) { map = null; return; }
      const real = [ts[0]], virt = [0];
      for (let i = 1; i < ts.length; i++) {
        const gap = ts[i] - ts[i - 1];
        if (!gap) continue;
        real.push(ts[i]);
        virt.push(virt[virt.length - 1] + (skip && gap > 2000 ? 600 : gap));
      }
      map = { real, virt, total: virt[virt.length - 1] || 1 };
    }
    const toReal = (v) => {
      if (!map) return 0;
      const { real, virt } = map;
      let lo = 0, hi = virt.length - 1;
      if (v <= 0) return real[0];
      if (v >= virt[hi]) return real[hi];
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (virt[m] <= v) lo = m; else hi = m; }
      return real[lo] + ((v - virt[lo]) / (virt[hi] - virt[lo])) * (real[hi] - real[lo]);
    };
    function seek(frac) {
      if (!map) return;
      vNow = frac * map.total;
      range.value = Math.round(frac * 1000);
      board.replayTime = toReal(vNow);
      board.redraw();
      tlabel.textContent = `${fmtDuration(board.replayTime - map.real[0])} / ${fmtDuration(map.real[map.real.length - 1] - map.real[0])}`;
    }
    function drawPauseMarks() {
      track.querySelectorAll(".pause").forEach((x) => x.remove());
      if (mode !== "replay" || !map) return;
      for (const ps of board.pauses(15000)) {
        // 멈춘 지점을 재생 막대 위에 주황색 표시
        const a = map.virt[map.real.findIndex((r) => r >= ps.from)] ?? 0;
        track.append(h("div.pause", { title: `멈춤 ${fmtDuration(ps.ms)}`, style: { left: `${(a / map.total) * 100}%`, width: "6px" } }));
      }
    }
    range.oninput = () => { playing = false; playBtn.textContent = "▶"; seek(+range.value / 1000); };
    playBtn.onclick = () => {
      if (!map) return;
      playing = !playing;
      playBtn.textContent = playing ? "⏸" : "▶";
      if (playing && vNow >= map.total) seek(0);
      let last = performance.now();
      const step = (t) => {
        if (!playing) return;
        vNow += (t - last) * speed; last = t;
        if (vNow >= map.total) { seek(1); playing = false; playBtn.textContent = "▶"; return; }
        seek(vNow / map.total);
        raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    };

    function setMode(m) {
      mode = m;
      modeBtn.classList.toggle("on", m === "replay");
      replayBar.classList.toggle("hidden", m !== "replay");
      const w = works.get(api_.key);
      if (m === "replay") {
        if (w?.strokes) board.setStrokes(w.strokes);
        buildMap();
        seek(0);
        drawPauseMarks();
      } else {
        playing = false; cancelAnimationFrame(raf);
        board.replayTime = null;
        if (w?.strokes) board.setStrokes(w.strokes);
      }
    }

    const w = works.get(api_.key);
    if (w?.strokes) board.setStrokes(w.strokes); else ensureStrokes(sid, pid);
    refreshSide();
  }

  return () => {
    clearInterval(timer);
    detail?.close();
    for (const c of cards.values()) c.board.destroy();
    socket.disconnect();
  };
}
