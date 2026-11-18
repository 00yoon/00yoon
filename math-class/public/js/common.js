// 공통 도우미: API 호출, 로그인 정보, DOM, 문제 렌더링
export const auth = {
  get token() { return localStorage.getItem("token"); },
  get user() { try { return JSON.parse(localStorage.getItem("user")); } catch { return null; } },
  set(token, user) { localStorage.setItem("token", token); localStorage.setItem("user", JSON.stringify(user)); },
  clear() { localStorage.removeItem("token"); localStorage.removeItem("user"); },
};

export async function api(path, { method = "GET", body, form } = {}) {
  const headers = {};
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await fetch(`/api${path}`, { method, headers, body: payload });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith("/login")) {
    auth.clear();
    location.href = "/";
    throw new Error("로그인이 필요합니다.");
  }
  if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
  return data;
}

export async function logout() {
  try { await api("/logout", { method: "POST" }); } catch {}
  auth.clear();
  location.href = "/";
}

// h("div.card#id", {onclick}, child...)
export function h(sel, props, ...children) {
  if (props == null || typeof props !== "object" || props instanceof Node || Array.isArray(props)) {
    if (props != null) children.unshift(props);
    props = {};
  }
  const [tag, ...rest] = sel.split(/(?=[.#])/);
  const el = document.createElement(tag || "div");
  for (const r of rest) {
    if (r[0] === ".") el.classList.add(r.slice(1));
    else if (r[0] === "#") el.id = r.slice(1);
  }
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k === "html") el.innerHTML = v;
    else if (k in el && k !== "list") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
export const $ = (s, r = document) => r.querySelector(s);

export function toast(msg, type = "") {
  let box = document.getElementById("toast");
  if (!box) { box = h("div#toast"); document.body.append(box); }
  const t = h(`div.toast${type ? "." + type : ""}`, msg);
  box.append(t);
  setTimeout(() => t.remove(), type === "error" ? 4500 : 2800);
}

export function modal(content, { onClose } = {}) {
  const back = h("div.modal-back");
  const box = h("div.modal", content);
  back.append(box);
  const close = () => { back.remove(); onClose?.(); };
  back.addEventListener("pointerdown", (e) => { if (e.target === back) close(); });
  document.body.append(back);
  return { close, box };
}

export function confirmBox(msg) { return Promise.resolve(window.confirm(msg)); }

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// 문제 본문: 글자 + $LaTeX$ + [[img:URL]]
export function renderBody(body) {
  const wrap = document.createElement("div");
  for (const line of String(body || "").split("\n")) {
    const img = line.match(/^\s*\[\[img:([^\]]+)\]\]\s*$/);
    if (img) { wrap.append(h("img", { src: img[1], loading: "lazy", alt: "" })); continue; }
    const div = h("div.line");
    const parts = line.split(/(\$[^$]+\$|\[\[img:[^\]]+\]\])/g);
    let html = "";
    for (const p of parts) {
      if (!p) continue;
      if (p.startsWith("$") && p.endsWith("$") && p.length > 2) {
        const tex = p.slice(1, -1);
        try { html += window.katex ? window.katex.renderToString(`\\displaystyle ${tex}`, { throwOnError: false }) : esc(p); }
        catch { html += esc(p); }
      } else if (p.startsWith("[[img:")) {
        html += `<img src="${esc(p.slice(6, -2))}" alt="" loading="lazy">`;
      } else html += esc(p);
    }
    div.innerHTML = html || "&nbsp;";
    wrap.append(div);
  }
  return wrap;
}

// 숫자 번호면 "3번", 아니면 그대로 ("즉석1")
export const pLabel = (l) => (l == null || l === "" ? "?" : /^\d+$/.test(String(l)) ? `${l}번` : String(l));

export function renderProblem(p, { showLabel = true } = {}) {
  const el = h("div.problem");
  if (p.kind === "image") {
    if (showLabel && p.label) el.append(h("div", h("span.problem-label", pLabel(p.label))));
    el.append(h("img", { src: p.image, alt: `문제 ${p.label || ""}`, loading: "lazy" }));
  } else {
    const body = renderBody(p.body);
    if (showLabel && p.label && body.firstChild) body.firstChild.prepend(h("span.problem-label", `${p.label}.`));
    el.append(body);
  }
  return el;
}

export function fmtDuration(ms) {
  if (ms == null || ms < 0) return "-";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분 ${s % 60}초`;
  return `${Math.floor(m / 60)}시간 ${m % 60}분`;
}
export function fmtTime(t) {
  if (!t) return "-";
  return new Date(t).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function requireLogin(kind) {
  const u = auth.user;
  if (!auth.token || !u || u.kind !== kind) { location.href = "/"; throw new Error("redirect"); }
  return u;
}
