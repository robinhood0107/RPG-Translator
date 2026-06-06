use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..")
}

fn run_local_only_guard(input: &str) -> std::process::Output {
    let script = repo_root().join("scripts/check-local-only.sh");
    let mut child = Command::new(script)
        .arg("--stdin")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn local-only guard");
    child
        .stdin
        .as_mut()
        .expect("guard stdin")
        .write_all(input.as_bytes())
        .expect("write guard stdin");
    child.wait_with_output().expect("wait for guard")
}

#[test]
fn local_only_guard_accepts_regular_source_paths() {
    let output = run_local_only_guard(
        "crates/core/src/lib.rs\nruntime/overlay-plugin/boot.js\n.github/workflows/ci.yml\n",
    );

    assert!(
        output.status.success(),
        "guard unexpectedly failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn local_only_guard_rejects_local_docs_test_games_and_generated_outputs() {
    let output = run_local_only_guard(
        "SPEC.md\ndontupload/City_Of_Secrets/data/System.json\nlogs/run.log\nexports/cache.jsonl\n",
    );

    assert!(!output.status.success(), "guard unexpectedly passed");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("SPEC.md"));
    assert!(stderr.contains("dontupload/City_Of_Secrets/data/System.json"));
    assert!(stderr.contains("logs/run.log"));
    assert!(stderr.contains("exports/cache.jsonl"));
}

#[test]
fn release_archive_guard_accepts_current_committed_source_tree() {
    let script = repo_root().join("scripts/check-release-archive.sh");
    let output = Command::new(script)
        .current_dir(repo_root())
        .output()
        .expect("run release archive guard");

    assert!(
        output.status.success(),
        "archive guard failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}
