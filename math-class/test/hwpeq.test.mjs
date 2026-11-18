import { hwpEqToLatex } from "../server/hwpeq.js";
import katex from "katex";
const cases = [
  "{3} over {4} + {2} over {5} times sqrt {16}",
  "x^2 - 5x + 6 = 0 ,~~ x = {-b +- sqrt {b^2 - 4ac}} over {2a}",
  "root 3 of {27} + LEFT ( 1 over 2 RIGHT ) ^{2}",
  "sum from {k=1} to {n} k = {n(n+1)} over 2",
  "int from 0 to 1 x^2 dx",
  "lim from {x -> 0} {sin x} over x = 1",
  "angle ABC = 30 DEG",
  "cases{x+y=5 # 2x-y=1}",
  "LEFT | -3 RIGHT | le 5",
  "bar {AB} perp bar {CD} ,~ triangle ABC",
  "pmatrix{1&2#3&4}",
  "a_{n+1} = 2a_n + 1",
  "f(x) = log _{2} x",
  "x ne 0 , ~ alpha + beta = pi",
];
let fail = 0;
for (const c of cases) {
  const l = hwpEqToLatex(c);
  try { katex.renderToString(l, { throwOnError: true }); console.log("OK  ", c, " => ", l); }
  catch (e) { fail++; console.log("FAIL", c, " => ", l, " :: ", e.message); }
}
process.exit(fail ? 1 : 0);
