use rpg_translator_core::{SyntaxRepair, SyntaxRepairInput, TextCodec};

fn input(
    source_text: &str,
    unit_kind: &str,
    translated_text: &str,
    source_text_id: i64,
) -> SyntaxRepairInput {
    let source = TextCodec::analyze(source_text);
    SyntaxRepairInput {
        source_text_id,
        unit_kind: unit_kind.to_string(),
        source_text: source.normalized_text,
        source_control_code_signature: source.control_code_signature,
        translated_text: translated_text.to_string(),
    }
}

#[test]
fn syntax_repair_converts_literal_backslash_n_by_unit_policy() {
    let message = SyntaxRepair::repair(&input(
        "Line one\nLine two",
        "message_block",
        "첫 줄\\n둘째 줄",
        1,
    ));
    assert!(message.safe_to_apply);
    assert_eq!(message.repaired_text, "첫 줄\n둘째 줄");
    assert!(
        message
            .actions
            .contains(&"literal-backslash-n-to-newline".to_string())
    );

    let db_field = SyntaxRepair::repair(&input("Single line", "db_field", "한 줄\\n설명", 2));
    assert!(db_field.safe_to_apply);
    assert_eq!(db_field.repaired_text, "한 줄 설명");
    assert!(
        db_field
            .actions
            .contains(&"literal-backslash-n-to-space".to_string())
    );
}

#[test]
fn syntax_repair_removes_inserted_controls_without_touching_source_controls() {
    let repaired = SyntaxRepair::repair(&input(
        "\\c[8]Hello \\Effect<SoftVibe>",
        "message_block",
        "\\c[8]\\h안녕\\C[6] \\Effect<SoftVibe>",
        3,
    ));

    assert!(repaired.safe_to_apply, "{repaired:?}");
    assert_eq!(repaired.repaired_text, "\\c[8]안녕 \\Effect<SoftVibe>");
    assert!(
        repaired
            .actions
            .contains(&"remove-inserted-h-control".to_string())
    );
    assert!(
        repaired
            .actions
            .contains(&"remove-inserted-color-control".to_string())
    );
}

#[test]
fn syntax_repair_converts_star_count_name_control_and_strips_escaped_korean() {
    let count = SyntaxRepair::repair(&input("Watcher*2", "db_field", "감시자\\N[2]", 4));
    assert!(count.safe_to_apply, "{count:?}");
    assert_eq!(count.repaired_text, "감시자*2");
    assert!(
        count
            .actions
            .contains(&"inserted-name-control-to-star-count".to_string())
    );

    let particle = SyntaxRepair::repair(&input(
        "%1 is no longer confused!",
        "message_block",
        "%1\\께서는\\ 더 이상 혼란스럽지 않다!\\?",
        5,
    ));
    assert!(particle.safe_to_apply, "{particle:?}");
    assert_eq!(particle.repaired_text, "%1께서는 더 이상 혼란스럽지 않다!?");
    assert!(
        particle
            .actions
            .contains(&"remove-stray-backslash".to_string())
    );
    assert!(
        particle
            .actions
            .contains(&"remove-escaped-question".to_string())
    );
}

#[test]
fn syntax_repair_keeps_broken_unicode_escape_unsafe() {
    let repaired = SyntaxRepair::repair(&input("Target cure", "db_field", "대상\\u20 cura", 6));

    assert!(!repaired.safe_to_apply);
    assert_eq!(repaired.repaired_text, "대상\\u20 cura");
    assert!(
        repaired
            .unsafe_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("broken or semantic escape"))
    );
    assert!(!repaired.validation_messages.is_empty());
}

#[test]
fn syntax_repair_repairs_prefixed_newline_escape_and_single_line_hard_breaks() {
    let prefixed = SyntaxRepair::repair(&input(
        "Was he the CEO\nof a company?",
        "message_block",
        "그 사람이 어떤 회사의\\nCEO였어?",
        7,
    ));
    assert!(prefixed.safe_to_apply, "{prefixed:?}");
    assert_eq!(prefixed.repaired_text, "그 사람이 어떤 회사의\nCEO였어?");
    assert!(
        prefixed
            .actions
            .contains(&"literal-backslash-n-prefix-to-newline".to_string())
    );

    let hard_break = SyntaxRepair::repair(&input(
        "Magical Defense +50% for 2 turns.",
        "db_field",
        "2턴 동안 마법 방어력 +50%.\n",
        8,
    ));
    assert!(hard_break.safe_to_apply, "{hard_break:?}");
    assert_eq!(hard_break.repaired_text, "2턴 동안 마법 방어력 +50%.");
    assert!(
        hard_break
            .actions
            .contains(&"hard-newline-to-space".to_string())
    );
}

#[test]
fn syntax_repair_removes_backslash_from_escaped_sound_words() {
    let repaired = SyntaxRepair::repair(&input(
        "\\Effect<Gooey>*Huff* B-bwub...",
        "message_block",
        "\\Effect<Gooey>\\Hah\\ *하악*\\ \\Hah\\...",
        9,
    ));

    assert!(repaired.safe_to_apply, "{repaired:?}");
    assert_eq!(repaired.repaired_text, "\\Effect<Gooey>Hah *하악* Hah...");
    assert!(
        repaired
            .actions
            .contains(&"remove-stray-backslash-word".to_string())
    );
}

#[test]
fn syntax_repair_restores_slurp_marker_artifacts() {
    let source = "\\c[28]*slurp* It's too late for that I'm afraid~. Stop stressing\nso much and enjoy yourself~.";
    let repaired = SyntaxRepair::repair(&input(
        source,
        "message_block",
        "\\c[28]\\s$*$ ＼츄릅\\s$*$ 이미 늦은 것 같은데~. 너무\n애쓰지 말고 즐기라구~.",
        11,
    ));

    assert!(repaired.safe_to_apply, "{repaired:?}");
    assert_eq!(
        repaired.repaired_text,
        "\\c[28]*츄릅* 이미 늦은 것 같은데~. 너무\n애쓰지 말고 즐기라구~."
    );
    assert!(
        repaired
            .actions
            .contains(&"repair-slurp-marker-escape".to_string())
    );
    assert!(
        repaired
            .actions
            .contains(&"remove-fullwidth-stray-backslash".to_string())
    );
}

#[test]
fn syntax_repair_removes_broken_u20_artifacts_and_adjacent_ascii_noise() {
    let aura = SyntaxRepair::repair(&input(
        "halve Max Aura of the target",
        "db_field",
        "대상\\u20 cura의 최대 오라를 절반으로 감소",
        12,
    ));
    assert!(aura.safe_to_apply, "{aura:?}");
    assert_eq!(aura.repaired_text, "대상의 최대 오라를 절반으로 감소");
    assert!(
        aura.actions
            .contains(&"remove-broken-u20-ascii-noise".to_string())
    );

    let undead = SyntaxRepair::repair(&input("Undead*2", "db_field", "언데드\\u20*2", 13));
    assert!(undead.safe_to_apply, "{undead:?}");
    assert_eq!(undead.repaired_text, "언데드*2");
    assert!(undead.actions.contains(&"remove-broken-u20".to_string()));
}

#[test]
fn syntax_repair_collapses_extra_hard_breaks_to_match_source_line_count() {
    let source =
        "Deals 240% power. -90% DEF of the target for 4 turn.\n\\c[2]Remove self debuffs.\\c[0]";
    let repaired = SyntaxRepair::repair(&input(
        source,
        "db_field",
        "240%의 데미지를 입힙니다.\n대상에게 4턴 동안 DEF -90%.\n\\c[2]자신의 디버프를 제거합니다.\\c[0]",
        10,
    ));

    assert!(repaired.safe_to_apply, "{repaired:?}");
    assert_eq!(
        repaired.repaired_text,
        "240%의 데미지를 입힙니다. 대상에게 4턴 동안 DEF -90%.\n\\c[2]자신의 디버프를 제거합니다.\\c[0]"
    );
    assert!(
        repaired
            .actions
            .contains(&"extra-hard-newline-to-space".to_string())
    );
}
