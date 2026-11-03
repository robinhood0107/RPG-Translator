"""검증 기록의 수치와 원문 비노출을 확인합니다."""
import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("metrics", Path(__file__).with_name("collect_verification_metrics.py"))
metrics = importlib.util.module_from_spec(spec)
spec.loader.exec_module(metrics)


class NumericMetricsTest(unittest.TestCase):
    def test_report_counts_project_rows_without_copying_content_or_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "PRIVATE_CANARY.sqlite"
            db = sqlite3.connect(path)
            db.executescript("""
                CREATE TABLE source_texts(id INTEGER,unit_kind TEXT,normalized_text TEXT);
                CREATE TABLE occurrences(project_id INTEGER,source_text_id INTEGER,active INTEGER);
                CREATE TABLE translations(source_text_id INTEGER,target_language TEXT,qa_state TEXT,review_state TEXT);
                INSERT INTO source_texts VALUES(1,'runtime_text','PRIVATE_CANARY {{RPGT_NUM_0}}'),(2,'generic_candidate','PRIVATE_CANARY'),(3,'text','PRIVATE_CANARY');
                INSERT INTO occurrences VALUES(1,1,1),(1,2,1),(2,3,1);
                INSERT INTO translations VALUES(1,'ko','passed','pending'),(3,'ko','passed','accepted');
            """)
            db.commit()
            db.close()
            inventory = root / "inventory.json"
            inventory.write_text(json.dumps([{"path": "PRIVATE_CANARY.png", "extension": ".png", "bytes": 10}]))
            log = root / "runtime.log"
            log.write_text("PRIVATE_CANARY\nℹ tests 2\nℹ pass 2\nℹ fail 0\nℹ duration_ms 1.5\nVERIFICATION_EXIT_CODE=0\n")
            before = path.read_bytes()
            report = metrics.collect(path, 1, inventory, {"runtime": log})
            self.assertEqual(path.read_bytes(), before)
            self.assertEqual(report["database"]["project_active_sources"], 2)
            self.assertEqual(report["database"]["project_active_translatable_sources"], 1)
            self.assertEqual(report["database"]["translation_rows"], 1)
            self.assertEqual(report["database"]["accepted_rows"], 0)
            self.assertEqual(report["inventory"]["bytes"], 10)
            self.assertEqual(report["tests"]["runtime"]["failed"], 0)
            def assert_numeric(value):
                if isinstance(value, dict):
                    for child in value.values():
                        assert_numeric(child)
                elif isinstance(value, list):
                    for child in value:
                        assert_numeric(child)
                else:
                    self.assertIsInstance(value, (int, float, bool, type(None)))
            assert_numeric(report)
            self.assertNotIn("PRIVATE_CANARY", json.dumps(report))
            self.assertNotIn(str(root), json.dumps(report))

    def test_incomplete_or_failed_logs_are_not_verified_success(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "runtime.log"
            path.write_text("ℹ tests 2\nℹ pass 2\nℹ fail 0\n")
            report = metrics.test_metrics(path,"runtime")
            self.assertEqual(report["completed"],0)
            self.assertEqual(report["verified_success"],0)
            path.write_text("ℹ tests 2\nℹ pass 1\nℹ fail 1\nVERIFICATION_EXIT_CODE=1\n")
            report = metrics.test_metrics(path,"runtime")
            self.assertEqual(report["completed"],1)
            self.assertEqual(report["command_exit_code"],1)
            self.assertEqual(report["verified_success"],0)


if __name__ == "__main__":
    unittest.main()
