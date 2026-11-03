#!/usr/bin/env python3
"""원문·번역·게임 파일명 없이 검증 수치만 수집합니다."""
import argparse
import collections
import json
import re
import sqlite3
import time
from pathlib import Path


def test_metrics(path, kind):
    text = re.sub(r"\x1b\[[0-9;]*m", "", Path(path).read_text())
    result = {"parsed": 0}
    if kind == "rust":
        rows = re.findall(r"test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored", text)
        if rows:
            result = {"parsed": 1, "suites": len(rows), "passed": sum(int(row[0]) for row in rows),
                      "failed": sum(int(row[1]) for row in rows), "ignored": sum(int(row[2]) for row in rows)}
    elif kind == "runtime":
        for label, field in [("tests", "total"), ("pass", "passed"), ("fail", "failed")]:
            matches = re.findall(r"ℹ " + label + r" (\d+)", text)
            if matches:
                result[field] = int(matches[-1])
        if all(field in result for field in ["total", "passed", "failed"]):
            result["parsed"] = 1
        matches = re.findall(r"ℹ duration_ms ([\d.]+)", text)
        if matches:
            result["duration_ms"] = float(matches[-1])
    else:
        match = re.search(r"^\s*Tests\s+(.+?)\((\d+)\)", text, re.M)
        if match:
            result = {"parsed": 1, "total": int(match[2]), "passed": 0, "failed": 0}
            for count, label in re.findall(r"(\d+)\s+(passed|failed|skipped)", match[1]):
                result[label] = int(count)
    exits = re.findall(r"^VERIFICATION_EXIT_CODE=(-?\d+)$", text, re.M)
    result["completed"] = int(bool(exits))
    result["command_exit_code"] = int(exits[-1]) if exits else None
    result["verified_success"] = int(result["parsed"] == 1 and bool(exits) and int(exits[-1]) == 0 and result.get("failed") == 0)
    return result


def collect(db_path, project_id, inventory_path=None, logs=None):
    result = {"schema_version": 1, "recorded_at_unix_ms": int(time.time() * 1000),
              "project_id": project_id, "content_fields_written": 0}
    # 읽기 전용 연결과 집계 쿼리만 사용해 번역 데이터와 검수 상태를 변경하지 않습니다.
    db = sqlite3.connect(Path(db_path).resolve().as_uri() + "?mode=ro", uri=True)
    try:
        scope = "EXISTS (SELECT 1 FROM occurrences o WHERE o.source_text_id=s.id AND o.project_id=? AND o.active=1)"
        scalar = lambda sql: db.execute(sql, (project_id,)).fetchone()[0]
        result["database"] = {
            "source_rows_total": db.execute("SELECT COUNT(*) FROM source_texts").fetchone()[0],
            "project_active_sources": scalar("SELECT COUNT(*) FROM source_texts s WHERE " + scope),
            "project_active_translatable_sources": scalar("SELECT COUNT(*) FROM source_texts s WHERE s.unit_kind<>'generic_candidate' AND " + scope),
            "project_numeric_template_sources": scalar("SELECT COUNT(*) FROM source_texts s WHERE instr(s.normalized_text,'{{RPGT_NUM_')>0 AND " + scope),
        }
        for name, condition in [("translation_rows", "1=1"), ("qa_passed_rows", "t.qa_state='passed'"),
                                ("review_pending_rows", "t.review_state='pending'"),
                                ("accepted_rows", "t.review_state IN ('accepted','reviewed')")]:
            result["database"][name] = scalar("SELECT COUNT(*) FROM translations t JOIN source_texts s ON s.id=t.source_text_id WHERE " + condition + " AND " + scope)
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if {"translation_speed_samples", "translation_jobs"} <= tables:
            rows = db.execute("SELECT request_elapsed_ms,item_count,char_count,status FROM translation_speed_samples x WHERE EXISTS (SELECT 1 FROM translation_jobs j WHERE j.provider_run_id=x.provider_run_id AND j.project_id=?)", (project_id,)).fetchall()
            success = [row for row in rows if row[3] == "success" and row[0] > 0]
            values = sorted(row[0] for row in success)
            quantile = lambda value: values[int((len(values)-1)*value)] if values else None
            result["performance"] = {"samples": len(rows), "successful_samples": len(success),
                                     "other_samples": len(rows)-len(success),
                                     "successful_items": sum(row[1] for row in success),
                                     "successful_input_chars": sum(row[2] for row in success),
                                     "request_ms_min": min(values) if values else None,
                                     "request_ms_p50": quantile(.5), "request_ms_p95": quantile(.95),
                                     "request_ms_max": max(values) if values else None,
                                     "request_ms_sum": sum(values)}
    finally:
        db.close()
    if inventory_path:
        records = json.loads(Path(inventory_path).read_text())
        if not isinstance(records, list):
            raise ValueError("inventory must be a list")
        extensions = collections.Counter()
        byte_count = 0
        for record in records:
            value = record.get("extension", "")
            extension = value.lower() if isinstance(value, str) and re.fullmatch(r"\.[A-Za-z0-9_]{1,12}|", value) else "other"
            extensions[extension] += 1
            size = record.get("bytes", 0)
            if isinstance(size, int) and not isinstance(size, bool) and size >= 0:
                byte_count += size
        result["inventory"] = {"files": len(records), "bytes": byte_count, "extensions": dict(sorted(extensions.items()))}
    result["tests"] = {kind: test_metrics(path, kind) for kind, path in (logs or {}).items()}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True)
    parser.add_argument("--project-id", type=int, required=True)
    parser.add_argument("--inventory")
    for kind in ["rust", "runtime", "desktop"]:
        parser.add_argument("--" + kind + "-log")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    logs = {kind: getattr(args, kind + "_log") for kind in ["rust", "runtime", "desktop"] if getattr(args, kind + "_log")}
    data = collect(args.db, args.project_id, args.inventory, logs)
    Path(args.output).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
