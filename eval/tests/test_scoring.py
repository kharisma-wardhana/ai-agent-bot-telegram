import json
from pathlib import Path

from scoring import Result, is_indonesian, p90, render, score

HERE = Path(__file__).resolve().parents[1]
GOOD_ANSWER = "Prompt yang baik itu jelas dan spesifik, jadi kamu bisa dapat jawaban yang lebih tepat dari model.\n\n📚 Sumber: Mastering the Art of Prompting"


def results(in_answered=30, in_total=32, out_fallback=12, out_total=12, latency=8000.0, answer=GOOD_ANSWER):
    rs = [Result(f"in{i}", "in", "q", answer if i < in_answered else "Maaf…", "lesson_docs" if i < in_answered else "fallback", latency, "Mastering the Art of Prompting") for i in range(in_total)]
    rs += [Result(f"out{i}", "out", "q", "Maaf…", "fallback" if i < out_fallback else "lesson_docs", 3000, None) for i in range(out_total)]
    rs.append(Result("persona01", "identity", "kamu siapa?", "Halo! Aku Kak Skilly, teman belajar kamu.", None, 2000))
    return rs


def test_dataset_meets_the_spec_minimums():
    qs = [json.loads(l) for l in (HERE / "questions.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    assert sum(q["scope"] == "in" for q in qs) >= 30
    assert sum(q["scope"] == "out" for q in qs) >= 10
    assert any(q["scope"] == "identity" for q in qs)
    assert any(q["lang"] == "en" and q["scope"] == "in" for q in qs)  # AC 6: English questions get Indonesian answers
    assert len({q["id"] for q in qs}) == len(qs)


def test_a_healthy_run_passes_every_check():
    rep = score(results())
    assert rep.passed, render(rep)
    assert {c.ac for c in rep.checks} == {"AC 4", "AC 5", "AC 6", "AC 7", "AC 8", "AC 21"}


def test_each_criterion_can_fail():
    assert not score(results(latency=75_000)).passed                      # AC 4
    assert not score(results(answer=GOOD_ANSWER + "x" * 1000)).passed      # AC 5
    assert not score(results(answer="The answer is that you should be clear and specific with the model.\n\n📚 Sumber: Mastering the Art of Prompting")).passed  # AC 6
    assert not score(results(answer="Prompt yang baik itu jelas dan spesifik untuk kamu.")).passed  # AC 7: no source line
    assert not score(results(in_answered=20)).passed                       # AC 8 in-scope < 70%
    assert not score(results(out_fallback=8)).passed                       # AC 8 out-of-scope < 90%
    assert not score(results(in_total=20, in_answered=20)).passed          # AC 8 needs ≥ 30 in-scope
    assert not score(results(answer=GOOD_ANSWER.replace("kamu", "Anda"))).passed  # AC 21


def test_helpers():
    assert p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) == 9
    assert is_indonesian(GOOD_ANSWER)
    assert not is_indonesian("This is the answer for you and it is in English.")
    assert "OVERALL: FAIL" in render(score(results(latency=99_000)))
