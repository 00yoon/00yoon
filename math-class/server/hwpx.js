// hwpx(한글 OWPML) → 문제 목록
// - 본문 글자, 한글 수식(→LaTeX), 그림을 문서 순서대로 읽고
// - "1." "2)" "[3]" "4번" 처럼 번호로 시작하는 줄에서 문제를 나눔
// 결과 body 형식: 일반 글자 + $LaTeX$ + [[img:/uploads/파일]]  (줄바꿈 \n)
import { unzipSync, strFromU8 } from "fflate";
import fs from "node:fs";
import path from "node:path";
import { hwpEqToLatex } from "./hwpeq.js";

const decode = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");

const attr = (attrs, name) => {
  const m = attrs.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
  return m ? m[1] : null;
};

export function parseHwpx(buffer, { uploadDir, urlPrefix, newId }) {
  const files = unzipSync(new Uint8Array(buffer));

  // 그림 ID → 파일 경로 (content.hpf manifest)
  const imgMap = {};
  const hpf = files["Contents/content.hpf"];
  if (hpf) {
    const xml = strFromU8(hpf);
    for (const m of xml.matchAll(/<opf:item\b([^>]*)\/?>/g)) {
      const id = attr(m[1], "id"), href = attr(m[1], "href");
      if (id && href) imgMap[id] = href;
    }
  }
  const savedImg = {};
  const saveImage = (ref) => {
    if (savedImg[ref]) return savedImg[ref];
    const href = imgMap[ref] || Object.keys(files).find((f) => f.startsWith("BinData/") && path.parse(f).name === ref);
    const data = href && files[href];
    if (!data) return null;
    const ext = path.extname(href).toLowerCase() || ".png";
    if (![".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp"].includes(ext)) return null;
    const name = `${newId()}${ext}`;
    fs.writeFileSync(path.join(uploadDir, name), data);
    return (savedImg[ref] = `${urlPrefix}/${name}`);
  };

  const sections = Object.keys(files)
    .filter((f) => /^Contents\/section\d+\.xml$/.test(f))
    .sort((a, b) => +a.match(/\d+/)[0] - +b.match(/\d+/)[0]);

  const lines = [];
  for (const sec of sections) {
    const xml = strFromU8(files[sec]);
    const stack = []; // 열린 문단마다 현재 줄 버퍼
    let inT = false, inScript = false, scriptBuf = "";
    const cur = () => stack[stack.length - 1];
    const re = /<(\/?)([\w:]+)([^>]*?)(\/?)>|([^<]+)/g;
    let m;
    while ((m = re.exec(xml))) {
      const [, close, tag, attrs, selfClose, text] = m;
      if (text !== undefined) {
        if (inScript) scriptBuf += text;
        else if (inT && cur()) cur().push(decode(text));
        continue;
      }
      const name = tag.replace(/^\w+:/, "");
      if (!close) {
        if (name === "p" && !selfClose) stack.push([]);
        else if (name === "t" && !selfClose) inT = true;
        else if (name === "script" && !selfClose) { inScript = true; scriptBuf = ""; }
        else if ((name === "lineBreak") && cur()) cur().push("\n");
        else if (name === "tab" && cur()) cur().push(" ");
        else if (name === "img") {
          const ref = attr(attrs, "binaryItemIDRef");
          const url = ref && saveImage(ref);
          if (url && cur()) cur().push(`\n[[img:${url}]]\n`);
        } else if (name === "tc" && cur()) cur().push(" ");
      } else {
        if (name === "t") inT = false;
        else if (name === "script") {
          inScript = false;
          const latex = hwpEqToLatex(decode(scriptBuf).trim());
          if (latex && cur()) cur().push(` $${latex}$ `);
        } else if (name === "p") {
          const buf = stack.pop() || [];
          const line = buf.join("").replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").trim();
          if (line) lines.push(line);
        }
      }
    }
  }
  return splitProblems(lines);
}

const NUM_RE = /^\s*(?:\[\s*(\d{1,3})\s*\]|(\d{1,3})\s*[.)]|(\d{1,3})\s*번|문제\s*(\d{1,3}))(?=\s|$|\S)/;

export function splitProblems(lines) {
  const problems = [];
  let header = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(NUM_RE);
    // "1.5" 같은 소수는 번호로 보지 않음
    const isNum = m && !/^\s*\d+\.\d/.test(line);
    if (isNum) {
      if (cur) problems.push(cur);
      const label = m[1] || m[2] || m[3] || m[4];
      cur = { label, lines: [line.slice(m[0].length).trim()] };
    } else if (cur) cur.lines.push(line);
    else header.push(line);
  }
  if (cur) problems.push(cur);
  if (!problems.length && header.length) return { header: [], problems: [{ label: "1", body: header.join("\n") }] };
  return {
    header,
    problems: problems.map((p) => ({ label: p.label, body: p.lines.filter(Boolean).join("\n") })),
  };
}
