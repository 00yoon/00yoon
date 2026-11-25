import express from "express";
import http from "node:http";
import path from "node:path";
import { ensureAdmin, UPLOAD_DIR } from "./db.js";
import { api } from "./api.js";
import { attachRealtime, flush } from "./realtime.js";

ensureAdmin();
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1); // 클라우드(리버스 프록시) 뒤에서 실제 IP 사용

// 어느 폴더에서 실행해도 동작하도록 이 파일 위치 기준으로 경로를 잡음
const ROOT = path.resolve(import.meta.dirname, "..");
const nm = (p) => path.join(ROOT, "node_modules", p);
const staticOpts = { maxAge: "7d", immutable: true };
app.use("/vendor/katex", express.static(nm("katex/dist"), staticOpts));
app.use("/vendor/pdfjs", express.static(nm("pdfjs-dist/build"), staticOpts));
app.use("/uploads", express.static(UPLOAD_DIR, staticOpts));
app.use("/api", api);
app.use(express.static(path.join(ROOT, "public"), { extensions: ["html"], maxAge: 0 }));
app.get("/healthz", (req, res) => res.send("ok"));

const server = http.createServer(app);
await attachRealtime(server);
const PORT = process.env.PORT === undefined ? 3000 : +process.env.PORT; // PORT=0 이면 빈 포트 자동 선택(테스트용)
server.listen(PORT, () => console.log(`수학 풀이 교실 서버: http://localhost:${server.address().port}`));

const shutdown = () => { flush(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
