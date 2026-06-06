use rpg_translator_core::{Error, PROJECT_NAME, Result, workspace_ready_message};

#[test]
fn workspace_ready_message_names_project() {
    assert_eq!(PROJECT_NAME, "RPG-Translator");
    assert_eq!(workspace_ready_message(), "RPG-Translator workspace ready");
}

#[test]
fn core_result_uses_project_error_type() {
    fn unsupported() -> Result<()> {
        Err(Error::unsupported_phase_operation("workspace foundation"))
    }

    let err = unsupported().expect_err("unsupported operation should return an error");
    assert_eq!(
        err.to_string(),
        "unsupported operation in phase: workspace foundation"
    );
}
