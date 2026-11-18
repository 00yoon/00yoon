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

const nm = (p) => path.resolve("node_modules", p);
const staticOpts = { maxAge: "7d", immutable: true };
app.use("/vendor/katex", express.static(nm("katex/dist"), staticOpts));
app.use("/vendor/pdfjs", express.static(nm("pdfjs-dist/build"), staticOpts));
app.use("/uploads", express.static(UPLOAD_DIR, staticOpts));
app.use("/api", api);
app.use(express.static(path.resolve("public"), { extensions: ["html"], maxAge: 0 }));
app.get("/healthz", (req, res) => res.send("ok"));

const server = http.createServer(app);
await attachRealtime(server);
const PORT = +process.env.PORT || 3000;
server.listen(PORT, () => console.log(`수학 풀이 교실 서버: http://localhost:${PORT}`));

const shutdown = () => { flush(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
