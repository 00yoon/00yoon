// 문제 가져오기: PDF/이미지 영역 자르기, 한글(hwpx), 직접 입력
import { api, h, toast, renderBody } from "/js/common.js";

function fullscreen(title, body, actions) {
  const el = h("div", { style: { position: "fixed", inset: 0, zIndex: 300, background: "var(--bg)", display: "flex", flexDirection: "column" } },
    h("div.topbar", h("b", title), h("span.spacer"), ...actions),
    h("div", { style: { flex: 1, overflow: "auto", padding: "12px 16px" } }, body));
  document.body.append(el);
  document.body.style.overflow = "hidden";
  return { el, close: () => { el.remove(); document.body.style.overflow = ""; } };
}

// ================= PDF / 이미지에서 문제 영역 자르기 =================
let pdfjs = null;
async function loadPdfjs() {
  if (pdfjs) return pdfjs;
  pdfjs = await import("/vendor/pdfjs/pdf.min.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";
  return pdfjs;
}

export async function openCropper({ setId, files, type, onDone }) {
  let pages = []; // 각 페이지 렌더 함수
  let pageNo = 0;
  let cutting = true;
  let zoom = 1;
  const crops = []; // {page, x,y,w,h (0~1 비율), label, blob, url}

  const canvas = h("canvas");
  const inner = h("div.crop-inner", canvas);
  const stage = h("div.crop-stage.cutting", inner);
  const list = h("div.col");
  const pageInfo = h("span.small");
  const startNo = h("input", { type: "number", value: 1, style: { width: "80px" }, title: "다음 문제 번호" });
  const saveBtn = h("button.primary", "저장");
  const ui = fullscreen(type === "pdf" ? "PDF에서 문제 자르기" : "이미지에서 문제 자르기",
    h("div.crop-layout",
      stage,
      h("div.crop-side",
        h("div.card", { style: { padding: "10px" } },
          h("p.small", { style: { margin: "0 0 6px" } }, "문제 영역을 손가락·펜·마우스로 ", h("b", "드래그"), "하세요. 영역 1개 = 문제 1개."),
          h("div.row",
            h("button.sm", { onclick: () => show(pageNo - 1) }, "◀"), pageInfo, h("button.sm", { onclick: () => show(pageNo + 1) }, "▶"),
            h("span.spacer"),
            h("button.sm", { onclick: () => setZoom(zoom / 1.25) }, "－"), h("button.sm", { onclick: () => setZoom(zoom * 1.25) }, "＋")),
          h("div.row", { style: { marginTop: "6px" } },
            h("button.sm.on#cutmode", { onclick: (e) => { cutting = !cutting; e.target.classList.toggle("on", cutting); e.target.textContent = cutting ? "✂ 자르기 모드" : "✋ 이동 모드"; stage.classList.toggle("cutting", cutting); } }, "✂ 자르기 모드"),
            h("span.small.muted", "다음 번호"), startNo)),
        list)),
    [h("button", { onclick: () => ui.close() }, "취소"), saveBtn]);

  const setZoom = (z) => { zoom = Math.min(3, Math.max(0.4, z)); layout(); };
  function layout() {
    const avail = stage.clientWidth - 24;
    canvas.style.width = `${Math.round(avail * zoom)}px`;
    drawRects();
  }
  window.addEventListener("resize", layout);

  // 페이지 준비
  try {
    if (type === "pdf") {
      const lib = await loadPdfjs();
      const doc = await lib.getDocument({ data: await files[0].arrayBuffer() }).promise;
      for (let i = 1; i <= doc.numPages; i++) {
        pages.push(async () => {
          const page = await doc.getPage(i);
          const vp1 = page.getViewport({ scale: 1 });
          const scale = Math.min(3, 2200 / vp1.width); // 선명하게 (가로 약 2200px)
          const vp = page.getViewport({ scale });
          canvas.width = vp.width; canvas.height = vp.height;
          await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp, canvas }).promise;
        });
      }
    } else {
      for (const f of files) {
        const url = URL.createObjectURL(f);
        const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = url; });
        pages.push(async () => {
          const k = Math.min(1, 3000 / Math.max(img.naturalWidth, img.naturalHeight));
          canvas.width = Math.round(img.naturalWidth * k); canvas.height = Math.round(img.naturalHeight * k);
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        });
      }
    }
  } catch (e) {
    console.error(e);
    toast("파일을 열지 못했어요.", "error");
    ui.close();
    return;
  }

  async function show(n) {
    if (n < 0 || n >= pages.length) return;
    pageNo = n;
    pageInfo.textContent = `${n + 1} / ${pages.length}쪽`;
    await pages[n]();
    layout();
    stage.scrollTop = 0;
  }

  // 드래그로 사각형
  let drag = null;
  const rel = (e) => {
    const r = canvas.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };
  inner.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch" && !cutting) return;
    e.preventDefault();
    inner.setPointerCapture(e.pointerId);
    const [x, y] = rel(e);
    const box = h("div.rect");
    inner.append(box);
    drag = { x0: x, y0: y, x, y, box, id: e.pointerId };
    placeBox(box, drag);
  });
  inner.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    [drag.x, drag.y] = rel(e);
    placeBox(drag.box, drag);
  });
  const finish = async (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null;
    d.box.remove();
    const x = Math.min(d.x0, d.x), y = Math.min(d.y0, d.y), w = Math.abs(d.x - d.x0), hh = Math.abs(d.y - d.y0);
    if (w * canvas.width < 30 || hh * canvas.height < 20) return; // 너무 작은 영역 무시 (실수 탭)
    const blob = await cropBlob(x, y, w, hh);
    const label = String(startNo.value || crops.length + 1);
    crops.push({ page: pageNo, x, y, w, h: hh, label, blob, url: URL.createObjectURL(blob) });
    startNo.value = /^\d+$/.test(label) ? +label + 1 : "";
    renderList(); drawRects();
  };
  inner.addEventListener("pointerup", finish);
  inner.addEventListener("pointercancel", () => { drag?.box.remove(); drag = null; });

  function placeBox(box, d) {
    Object.assign(box.style, {
      left: `${Math.min(d.x0, d.x) * 100}%`, top: `${Math.min(d.y0, d.y) * 100}%`,
      width: `${Math.abs(d.x - d.x0) * 100}%`, height: `${Math.abs(d.y - d.y0) * 100}%`,
    });
  }
  function cropBlob(x, y, w, hh) {
    const cv = document.createElement("canvas");
    const sx = Math.round(x * canvas.width), sy = Math.round(y * canvas.height);
    cv.width = Math.round(w * canvas.width); cv.height = Math.round(hh * canvas.height);
    // 너무 크면 줄여서 용량 절약 (가로 1600px)
    const k = Math.min(1, 1600 / cv.width);
    const out = document.createElement("canvas");
    out.width = Math.round(cv.width * k); out.height = Math.round(cv.height * k);
    out.getContext("2d").drawImage(canvas, sx, sy, cv.width, cv.height, 0, 0, out.width, out.height);
    return new Promise((r) => out.toBlob(r, "image/png"));
  }
  function drawRects() {
    inner.querySelectorAll(".rect.saved").forEach((el) => el.remove());
    crops.forEach((c) => {
      if (c.page !== pageNo) return;
      const box = h("div.rect.saved", h("span.tag", `${c.label}번`));
      placeBox(box, { x0: c.x, y0: c.y, x: c.x + c.w, y: c.y + c.h });
      inner.append(box);
    });
  }
  function renderList() {
    list.replaceChildren(
      h("div.small.muted", `잘라낸 문제 ${crops.length}개`),
      ...crops.map((c, i) => {
        const inp = h("input", { value: c.label, placeholder: "번호" });
        inp.oninput = () => { c.label = inp.value; drawRects(); };
        return h("div.crop-item", h("img", { src: c.url }),
          h("div.col.grow", { style: { gap: "2px" } }, h("span.small.muted", `${c.page + 1}쪽`), inp),
          h("button.sm.ghost", { onclick: () => { crops.splice(i, 1); renderList(); drawRects(); } }, "✕"));
      }));
    saveBtn.textContent = `${crops.length}개 문제 저장`;
    saveBtn.disabled = !crops.length;
  }

  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    try {
      for (let i = 0; i < crops.length; i += 20) {
        const chunk = crops.slice(i, i + 20);
        const form = new FormData();
        chunk.forEach((c, j) => form.append("images", c.blob, `p${i + j}.png`));
        form.append("meta", JSON.stringify(chunk.map((c) => ({ label: c.label }))));
        saveBtn.textContent = `저장 중… ${i}/${crops.length}`;
        await api(`/sets/${setId}/problems/images`, { method: "POST", form });
      }
      toast(`${crops.length}개 문제를 저장했어요`);
      window.removeEventListener("resize", layout);
      ui.close();
      onDone?.();
    } catch (e) {
      toast(e.message, "error");
      saveBtn.disabled = false;
      renderList();
    }
  };

  renderList();
  await show(0);
}

// ================= 한글(hwpx) 가져오기 =================
export async function openHwpxImport({ setId, file, onDone }) {
  const form = new FormData();
  form.append("file", file);
  let data;
  try {
    toast("한글 파일을 읽는 중…");
    data = await api("/import/hwpx", { method: "POST", form });
  } catch (e) { toast(e.message, "error"); return; }
  const items = data.problems.map((p) => ({ ...p, answer: "", use: true }));
  if (!items.length) { toast("문제를 찾지 못했어요. PDF로 저장해서 자르기를 이용해 주세요.", "error"); return; }

  const listEl = h("div.col", { style: { maxWidth: "1100px", margin: "0 auto" } });
  const saveBtn = h("button.primary");
  const ui = fullscreen(`한글 가져오기: ${file.name}`, listEl, [h("button", { onclick: () => ui.close() }, "취소"), saveBtn]);

  function render() {
    const n = items.filter((x) => x.use).length;
    saveBtn.textContent = `${n}개 문제 추가`;
    saveBtn.disabled = !n;
    listEl.replaceChildren(
      h("div.card", h("p.small", { style: { margin: 0 } },
        "번호(1. 2) [3] 등)로 문제를 자동으로 나눴어요. 수식은 ", h("code", "$...$"), " 로 표시됩니다. ",
        "잘못 나뉜 곳은 ‘아래와 합치기’, 수식이 깨진 문제는 본문을 고치거나 PDF 자르기를 이용하세요.")),
      ...items.map((it, i) => {
        const preview = h("div.problem", renderBody(it.body));
        const ta = h("textarea", { value: it.body, rows: Math.min(10, it.body.split("\n").length + 1), style: { fontFamily: "ui-monospace, monospace", fontSize: "13px" } });
        ta.oninput = () => { it.body = ta.value; preview.replaceChildren(renderBody(it.body)); };
        const use = h("input", { type: "checkbox", checked: it.use, style: { width: "auto", minHeight: 0 } });
        use.onchange = () => { it.use = use.checked; render(); };
        const label = h("input", { value: it.label, style: { width: "70px" } });
        label.oninput = () => (it.label = label.value);
        const ans = h("input", { value: it.answer, placeholder: "정답 (선택)" });
        ans.oninput = () => (it.answer = ans.value);
        return h("div.card", { style: { opacity: it.use ? 1 : 0.5 } },
          h("div.row", use, label, h("div.grow", ans),
            i < items.length - 1 && h("button.sm", { onclick: () => { items[i].body += "\n" + items[i + 1].body; items.splice(i + 1, 1); render(); } }, "아래와 합치기")),
          h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginTop: "8px" } }, ta, preview));
      }));
  }
  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    try {
      await api(`/sets/${setId}/problems/rich`, { method: "POST", body: { problems: items.filter((x) => x.use) } });
      toast("문제를 추가했어요");
      ui.close();
      onDone?.();
    } catch (e) { toast(e.message, "error"); saveBtn.disabled = false; }
  };
  render();
}

// ================= 직접 입력 / 본문 수정 =================
export function openManualInput({ setId, problem, onDone }) {
  const label = h("input", { value: problem?.label || "", placeholder: "번호", style: { width: "80px" } });
  const body = h("textarea", { value: problem?.body || "", rows: 8, placeholder: "문제를 입력하세요. 수식은 $...$ 로 감싸요.\n예) 다음을 계산하시오. $\\frac{3}{4} + \\frac{1}{2}$" });
  const answer = h("input", { value: problem?.answer || "", placeholder: "정답 (선택, 여러 개는 | 로 구분)" });
  const preview = h("div.problem.card", { style: { minHeight: "80px" } });
  const upd = () => preview.replaceChildren(renderBody(body.value));
  body.oninput = upd; upd();
  const saveBtn = h("button.primary", problem ? "수정 저장" : "추가");
  const ui = fullscreen(problem ? "문제 본문 수정" : "문제 직접 입력",
    h("div.col", { style: { maxWidth: "900px", margin: "0 auto" } },
      h("div.row", label, h("div.grow", answer)), body,
      h("p.small.muted", "미리보기"), preview,
      h("p.small.muted", "수식 예: 분수 $\\frac{a}{b}$, 루트 $\\sqrt{2}$, 거듭제곱 $x^{2}$, 곱하기 $\\times$, 나누기 $\\div$, 부등호 $\\le \\ge$")),
    [h("button", { onclick: () => ui.close() }, "취소"), saveBtn]);
  saveBtn.onclick = async () => {
    try {
      if (problem) await api(`/problems/${problem.id}`, { method: "PATCH", body: { label: label.value, body: body.value, answer: answer.value } });
      else await api(`/sets/${setId}/problems/rich`, { method: "POST", body: { problems: [{ label: label.value, body: body.value, answer: answer.value }] } });
      toast("저장했어요");
      ui.close();
      onDone?.();
    } catch (e) { toast(e.message, "error"); }
  };
}
