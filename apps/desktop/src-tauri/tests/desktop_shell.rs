use rpg_translator_desktop::desktop_shell_name;

#[test]
fn desktop_shell_uses_core_project_name() {
    assert_eq!(desktop_shell_name(), "RPG-Translator Desktop");
}
