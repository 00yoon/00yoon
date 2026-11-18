// 한글(HWP) 수식 스크립트 → LaTeX 변환기
// 자주 쓰는 중·고등 수학 문법 위주. 모르는 토큰은 그대로 통과시켜 화면에서 확인/수정 가능하게 둠.

const SYMBOLS = {
  times: "\\times", div: "\\div", "+-": "\\pm", pm: "\\pm", "-+": "\\mp", mp: "\\mp",
  cdot: "\\cdot", le: "\\le", leq: "\\le", ge: "\\ge", geq: "\\ge", "<=": "\\le", ">=": "\\ge",
  ne: "\\ne", neq: "\\ne", "!=": "\\ne", approx: "\\approx", sim: "\\sim", simeq: "\\simeq",
  equiv: "\\equiv", "==": "\\equiv", inf: "\\infty", infty: "\\infty", infinity: "\\infty",
  cdots: "\\cdots", ldots: "\\ldots", vdots: "\\vdots", ddots: "\\ddots",
  therefore: "\\therefore", because: "\\because", angle: "\\angle", triangle: "\\triangle",
  deg: "^{\\circ}", circ: "\\circ", prime: "'", perp: "\\perp", bot: "\\perp", parallel: "\\parallel",
  in: "\\in", notin: "\\notin", ni: "\\ni", subset: "\\subset", supset: "\\supset",
  subseteq: "\\subseteq", supseteq: "\\supseteq", cup: "\\cup", cap: "\\cap", emptyset: "\\emptyset",
  smallinter: "\\cap", smallunion: "\\cup", forall: "\\forall", exist: "\\exists", exists: "\\exists",
  rarrow: "\\rightarrow", "->": "\\rightarrow", larrow: "\\leftarrow", lrarrow: "\\leftrightarrow",
  "=>": "\\Rightarrow", "<=>": "\\Leftrightarrow", Rarrow: "\\Rightarrow", Larrow: "\\Leftarrow",
  LRarrow: "\\Leftrightarrow", uparrow: "\\uparrow", downarrow: "\\downarrow",
  "<<": "\\ll", ">>": "\\gg", propto: "\\propto", partial: "\\partial", nabla: "\\nabla",
  odot: "\\odot", oplus: "\\oplus", otimes: "\\otimes", vee: "\\vee", wedge: "\\wedge",
  neg: "\\neg", lnot: "\\neg", dagger: "\\dagger", hbar: "\\hbar", ell: "\\ell",
  "&": "&", "#": "\\\\",
};
const GREEK = [
  "alpha", "beta", "gamma", "delta", "epsilon", "varepsilon", "zeta", "eta", "theta", "vartheta",
  "iota", "kappa", "lambda", "mu", "nu", "xi", "pi", "varpi", "rho", "sigma", "varsigma", "tau",
  "upsilon", "phi", "varphi", "chi", "psi", "omega",
];
const FUNCS = ["sin", "cos", "tan", "cot", "sec", "csc", "log", "ln", "lg", "exp", "lim", "max", "min",
  "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh", "det", "gcd", "mod"];
const BIG = { sum: "\\sum", prod: "\\prod", int: "\\int", dint: "\\iint", tint: "\\iiint", oint: "\\oint",
  coprod: "\\coprod", union: "\\bigcup", inter: "\\bigcap", bigcup: "\\bigcup", bigcap: "\\bigcap" };
const ACCENTS = { bar: "\\overline", overline: "\\overline", under: "\\underline", underline: "\\underline",
  vec: "\\vec", hat: "\\hat", tilde: "\\tilde", dot: "\\dot", ddot: "\\ddot", check: "\\check",
  acute: "\\acute", grave: "\\grave", arch: "\\overset{\\frown}", dyad: "\\overleftrightarrow" };
const STYLE_SKIP = new Set(["rm", "it", "bold", "b", "italic"]);
const FONT_WORDS = new Set(["rm", "it"]);

function tokenize(s) {
  const out = [];
  let i = 0;
  const ops = ["<=>", "+-", "-+", "<=", ">=", "!=", "==", "->", "=>", "<<", ">>"];
  while (i < s.length) {
    const c = s[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { out.push({ t: "sp" }); i++; continue; }
    if (c === "~" || c === "`") { out.push({ t: "space", v: c === "~" ? "\\ " : "\\," }); i++; continue; }
    if (c === '"') { // "따옴표 안" = 일반 글자
      const j = s.indexOf('"', i + 1);
      const txt = j < 0 ? s.slice(i + 1) : s.slice(i + 1, j);
      out.push({ t: "text", v: txt });
      i = j < 0 ? s.length : j + 1; continue;
    }
    const op = ops.find((o) => s.startsWith(o, i));
    if (op) { out.push({ t: "word", v: op }); i += op.length; continue; }
    if ("{}^_".includes(c)) { out.push({ t: c }); i++; continue; }
    if (/[A-Za-z]/.test(c)) {
      let j = i; while (j < s.length && /[A-Za-z]/.test(s[j])) j++;
      out.push({ t: "word", v: s.slice(i, j) }); i = j; continue;
    }
    if (/[0-9.]/.test(c)) {
      let j = i; while (j < s.length && /[0-9.]/.test(s[j])) j++;
      out.push({ t: "num", v: s.slice(i, j) }); i = j; continue;
    }
    out.push({ t: "ch", v: c }); i++;
  }
  return out;
}

class Parser {
  constructor(tokens) { this.k = tokens; this.i = 0; }
  peek(skipSp = true) {
    let j = this.i;
    if (skipSp) while (j < this.k.length && this.k[j].t === "sp") j++;
    return this.k[j];
  }
  next() { while (this.i < this.k.length && this.k[this.i].t === "sp") this.i++; return this.k[this.i++]; }
  isWord(tok, ...ws) { return tok && tok.t === "word" && ws.some((w) => tok.v.toLowerCase() === w); }

  // 표현식 목록: 'over' / 'atop' 은 중위 연산자 (왼쪽 항 하나 / 오른쪽 항 하나)
  parseList(stop) {
    const items = [];
    while (true) {
      const p = this.peek();
      if (!p || stop(p)) break;
      if (this.isWord(p, "over", "atop")) {
        this.next();
        const left = items.pop() ?? "";
        const right = this.parseScripted() ?? "";
        items.push(p.v.toLowerCase() === "over" ? `\\frac{${left}}{${right}}` : `\\genfrac{}{}{0pt}{}{${left}}{${right}}`);
        continue;
      }
      const it = this.parseScripted();
      if (it === null) break;
      items.push(it);
    }
    return items.join(" ").replace(/\s+/g, " ").trim();
  }

  parseScripted() {
    let base = this.parseAtom();
    if (base === null) return null;
    while (true) {
      const p = this.peek();
      if (!p) break;
      if (p.t === "^" || this.isWord(p, "sup")) { this.next(); base = `{${base}}^{${this.parseAtom() ?? ""}}`; continue; }
      if (p.t === "_" || this.isWord(p, "sub")) { this.next(); base = `{${base}}_{${this.parseAtom() ?? ""}}`; continue; }
      break;
    }
    return base;
  }

  group() { // { ... } 또는 원자 하나
    const p = this.peek();
    if (p && p.t === "{") return this.parseAtom();
    return this.parseScripted() ?? "";
  }

  parseAtom() {
    const tok = this.next();
    if (!tok) return null;
    switch (tok.t) {
      case "{": {
        const inner = this.parseList((p) => p.t === "}");
        if (this.peek()?.t === "}") this.next();
        return inner;
      }
      case "}": return "";
      case "num": return tok.v;
      case "space": return tok.v;
      case "text": return `\\text{${tok.v}}`;
      case "ch": {
        const map = { "%": "\\%", "$": "\\$", "#": "\\\\", "&": "&", "|": "|", "\\": "\\backslash" };
        return map[tok.v] ?? tok.v;
      }
      case "^": case "_": return "";
      case "word": return this.word(tok.v);
    }
    return "";
  }

  word(w) {
    const lw = w.toLowerCase();
    if (STYLE_SKIP.has(lw) && FONT_WORDS.has(lw)) return "";
    if (lw === "bold") return `\\mathbf{${this.group()}}`;
    const sym = SYMBOLS[w] ?? SYMBOLS[lw];
    if (sym !== undefined) return sym;
    if (GREEK.includes(w)) return `\\${w}`;
    if (GREEK.includes(lw)) { // 대문자 그리스 문자 (GAMMA, Gamma 등)
      const cap = lw[0].toUpperCase() + lw.slice(1);
      return ["Gamma", "Delta", "Theta", "Lambda", "Xi", "Pi", "Sigma", "Upsilon", "Phi", "Psi", "Omega"].includes(cap) ? `\\${cap}` : `\\${lw}`;
    }
    if (FUNCS.includes(lw)) return lw === "mod" ? "\\bmod" : `\\${lw}`;
    if (lw === "sqrt" || lw === "root") {
      // root n of x  /  sqrt {x}
      if (lw === "root") {
        const n = this.group();
        if (this.isWord(this.peek(), "of")) this.next();
        return `\\sqrt[${n}]{${this.group()}}`;
      }
      return `\\sqrt{${this.group()}}`;
    }
    if (ACCENTS[lw]) return `${ACCENTS[lw]}{${this.group()}}`;
    if (BIG[lw]) {
      let s = BIG[lw];
      if (this.isWord(this.peek(), "from")) { this.next(); s += `_{${this.group()}}`; }
      if (this.isWord(this.peek(), "to")) { this.next(); s += `^{${this.group()}}`; }
      return s;
    }
    if (lw === "left") {
      const d = this.delim();
      const inner = this.parseList((p) => this.isWord(p, "right"));
      let r = ".";
      if (this.isWord(this.peek(), "right")) { this.next(); r = this.delim(); }
      return `\\left${d} ${inner} \\right${r}`;
    }
    if (lw === "right") return "";
    if (lw === "cases") return this.env("cases");
    if (lw === "matrix") return this.env("matrix");
    if (lw === "pmatrix") return this.env("pmatrix");
    if (lw === "bmatrix") return this.env("bmatrix");
    if (lw === "dmatrix") return this.env("vmatrix");
    if (lw === "pile" || lw === "lpile" || lw === "rpile" || lw === "eqalign") return this.env("aligned");
    if (lw === "box") return `\\boxed{${this.group()}}`;
    if (lw === "not") return `\\not ${this.group()}`;
    if (lw === "lim" ) return "\\lim";
    if (lw === "from") return `_{${this.group()}}`;
    if (lw === "to") return `^{${this.group()}}`;
    // 일반 변수/글자열: 한 글자씩 수학 이탤릭 (예: ac → ac)
    return w;
  }

  delim() {
    const t = this.next();
    if (!t) return ".";
    if (t.t === "{") return "\\{";
    if (t.t === "}") return "\\}";
    if (t.t === "ch") return { "(": "(", ")": ")", "[": "[", "]": "]", "|": "|" }[t.v] ?? t.v;
    if (t.t === "word") {
      const lw = t.v.toLowerCase();
      if (lw === "lbrace") return "\\{";
      if (lw === "rbrace") return "\\}";
      if (lw === "langle") return "\\langle";
      if (lw === "rangle") return "\\rangle";
      if (lw === "lfloor") return "\\lfloor";
      if (lw === "rfloor") return "\\rfloor";
      if (lw === "lceil") return "\\lceil";
      if (lw === "rceil") return "\\rceil";
      if (lw === "dline" || lw === "vert") return "\\|";
    }
    return ".";
  }

  env(name) {
    if (this.peek()?.t !== "{") return "";
    const body = this.parseAtom(); // '#' → \\, '&' → &
    return `\\begin{${name}} ${body} \\end{${name}}`;
  }
}

export function hwpEqToLatex(script) {
  if (!script) return "";
  try {
    const p = new Parser(tokenize(String(script)));
    let out = p.parseList(() => false);
    return out;
  } catch {
    return String(script);
  }
}
