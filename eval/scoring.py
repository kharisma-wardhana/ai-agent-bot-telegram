"""Scores eval results against the spec's acceptance criteria (AC 4, 5, 6, 7, 8, 21). Pure functions, no I/O."""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field

MAX_CHARS = 1000
LATENCY_P90_MS = 60_000
IN_SCOPE_TARGET = 0.70
OUT_SCOPE_TARGET = 0.90
SOURCE_PREFIX = "📚 Sumber:"

ID_WORDS = {"yang", "dan", "untuk", "dengan", "adalah", "ini", "itu", "dari", "kamu", "bisa", "atau", "agar", "pada", "dalam", "tidak", "ya", "juga", "akan", "seperti", "karena"}
EN_WORDS = {"the", "and", "is", "are", "of", "to", "you", "with", "for", "that", "this", "it", "can", "be", "your", "in", "on", "as", "which", "will"}
FORBIDDEN_ADDRESS = re.compile(r"\b(anda|lu|lo|elo|elu)\b", re.IGNORECASE)


@dataclass
class Result:
    id: str
    scope: str  # in | out | identity
    question: str
    answer: str
    answer_source: str | None  # lesson_docs | fallback | None
    latency_ms: float
    expect_source: str | None = None


@dataclass
class Check:
    name: str
    ac: str
    value: str
    passed: bool


@dataclass
class Report:
    checks: list[Check] = field(default_factory=list)
    failures: list[str] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        return all(c.passed for c in self.checks)


def p90(values: list[float]) -> float:
    if not values:
        return math.inf
    s = sorted(values)
    return s[max(0, math.ceil(0.9 * len(s)) - 1)]


def is_indonesian(text: str) -> bool:
    body = text.split(SOURCE_PREFIX)[0].lower()
    words = re.findall(r"[a-z]+", body)
    if not words:
        return False
    id_hits = sum(w in ID_WORDS for w in words)
    en_hits = sum(w in EN_WORDS for w in words)
    return id_hits >= 2 and id_hits > en_hits


def answered(r: Result) -> bool:
    return r.answer_source == "lesson_docs"


def score(results: list[Result]) -> Report:
    rep = Report()
    ins = [r for r in results if r.scope == "in"]
    outs = [r for r in results if r.scope == "out"]
    ident = [r for r in results if r.scope == "identity"]
    answers = [r for r in results if r.answer]

    lat = p90([r.latency_ms for r in ins if answered(r)])
    rep.checks.append(Check("latency p90 (in-scope, answered)", "AC 4", f"{lat / 1000:.1f}s", lat < LATENCY_P90_MS))

    too_long = [r.id for r in answers if len(r.answer) > MAX_CHARS]
    rep.checks.append(Check("answers ≤ 1000 chars", "AC 5", f"{len(answers) - len(too_long)}/{len(answers)}", not too_long))
    rep.failures += [f"{i}: over 1000 chars" for i in too_long]

    not_id = [r.id for r in answers if r.answer_source == "lesson_docs" and not is_indonesian(r.answer)]
    rep.checks.append(Check("answers in Bahasa Indonesia", "AC 6", f"{len([r for r in answers if answered(r)]) - len(not_id)}/{len([r for r in answers if answered(r)])}", not not_id))
    rep.failures += [f"{i}: not Indonesian" for i in not_id]

    uncited = [r.id for r in ins if answered(r) and (SOURCE_PREFIX not in r.answer or (r.expect_source and r.expect_source.lower() not in r.answer.lower()))]
    rep.checks.append(Check("answers cite the expected source", "AC 7", f"{len([r for r in ins if answered(r)]) - len(uncited)}/{len([r for r in ins if answered(r)])}", not uncited))
    rep.failures += [f"{i}: missing/wrong source" for i in uncited]

    in_rate = sum(answered(r) for r in ins) / len(ins) if ins else 0.0
    rep.checks.append(Check(f"in-scope answered from lesson-docs (≥{IN_SCOPE_TARGET:.0%}, n={len(ins)})", "AC 8", f"{in_rate:.0%}", len(ins) >= 30 and in_rate >= IN_SCOPE_TARGET))
    out_rate = sum(r.answer_source == "fallback" for r in outs) / len(outs) if outs else 0.0
    rep.checks.append(Check(f"out-of-scope → mentor fallback (≥{OUT_SCOPE_TARGET:.0%}, n={len(outs)})", "AC 8", f"{out_rate:.0%}", len(outs) >= 10 and out_rate >= OUT_SCOPE_TARGET))
    rep.failures += [f"{r.id}: out-of-scope was answered" for r in outs if r.answer_source != "fallback"]

    bad_address = [r.id for r in answers if FORBIDDEN_ADDRESS.search(r.answer.split(SOURCE_PREFIX)[0])]
    ident_ok = bool(ident) and all("kak skilly" in r.answer.lower() for r in ident)
    rep.checks.append(Check("persona: 'kamu', identifies as Kak Skilly", "AC 21", f"{len(bad_address)} bad address, identity {'ok' if ident_ok else 'missing'}", not bad_address and ident_ok))
    rep.failures += [f"{i}: uses Anda/lu/lo" for i in bad_address]
    return rep


def render(rep: Report) -> str:
    lines = ["| Check | AC | Result | Pass |", "|---|---|---|---|"]
    lines += [f"| {c.name} | {c.ac} | {c.value} | {'✅' if c.passed else '❌'} |" for c in rep.checks]
    if rep.failures:
        lines += ["", "Failures:"] + [f"- {f}" for f in rep.failures]
    lines += ["", "OVERALL: PASS" if rep.passed else "OVERALL: FAIL"]
    return "\n".join(lines)
