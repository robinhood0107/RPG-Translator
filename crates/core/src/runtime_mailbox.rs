//! 게임의 파일 요청함을 처리합니다. 모델 호출과 문법 검증은 기존 배치 경로에 위임합니다.

use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::{
    BatchTranslator, BatchTranslatorConfig, CacheKeyBuilder, CacheKeyParts, Engine, Error,
    NewOccurrence, NewSourceText, ProviderClient, ProviderRequestSpacingConfig, Result,
    RpgMakerDetector, TextCodec, TranslationDb,
};

#[derive(Debug, Clone)]
pub struct RuntimeSession {
    pub project_id: i64,
    pub engine: Engine,
    pub source_language: String,
    pub target_language: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeRequest {
    pub schema_version: u32,
    pub cache_key: String,
    pub text: String,
    pub engine: String,
    pub source_language: String,
    pub target_language: String,
    pub context_hash: Option<String>,
    pub adapter: String,
    pub kind: String,
    #[serde(default)]
    pub priority: i32,
    #[serde(default)]
    pub window_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeReply {
    pub schema_version: u32,
    pub cache_key: String,
    pub text: String,
    pub translation: Option<String>,
    pub error: Option<String>,
    pub unchanged_allowed: bool,
}

pub fn runtime_mailbox_directory(game_root: impl AsRef<Path>) -> Result<PathBuf> {
    let game = RpgMakerDetector::detect(native_runtime_path(game_root.as_ref()))?;
    let data = Path::new(&game.data_path);
    let web_root = data
        .parent()
        .ok_or_else(|| Error::invalid_input("game data root is missing"))?;
    Ok(web_root.join("rpg-translator/runtime"))
}

// DB에는 Windows 표시 경로가 저장될 수 있으므로 WSL 작업자의 실제 파일 경로로 바꿉니다.
pub fn native_runtime_path(path: &Path) -> PathBuf {
    let value = path.to_string_lossy().replace('\\', "/");
    let value = value.strip_prefix("//?/").unwrap_or(&value);
    let bytes = value.as_bytes();
    if cfg!(target_os = "linux")
        && bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && bytes[2] == b'/'
    {
        return PathBuf::from(format!(
            "/mnt/{}/{}",
            (bytes[0] as char).to_ascii_lowercase(),
            &value[3..]
        ));
    }
    path.to_path_buf()
}

pub fn translate_runtime_request(
    db: &mut TranslationDb,
    provider: &mut impl ProviderClient,
    session: &RuntimeSession,
    request: &RuntimeRequest,
) -> Result<RuntimeReply> {
    if request.schema_version != 1
        || request.text.len() > 65_536
        || request.engine != session.engine.as_key()
        || request.source_language != session.source_language
        || request.target_language != session.target_language
        || request.adapter.len() > 80
        || request.kind.len() > 80
        || request
            .window_type
            .as_ref()
            .is_some_and(|value| value.len() > 120)
    {
        return Err(Error::invalid_input(
            "runtime request does not match the active session",
        ));
    }
    let analysis = TextCodec::analyze(&request.text);
    let unchanged_allowed = crate::is_allowed_technical_token(&analysis.visible_text);
    if !analysis.visible_text.chars().any(char::is_alphabetic) {
        return Err(Error::invalid_input(
            "runtime request has no linguistic text",
        ));
    }
    let key = CacheKeyBuilder::build(&CacheKeyParts {
        engine: session.engine.clone(),
        source_language: session.source_language.clone(),
        target_language: session.target_language.clone(),
        normalized_text: analysis.normalized_text.clone(),
        control_code_signature: analysis.control_code_signature.clone(),
        context_hash: request.context_hash.clone(),
    });
    if key != request.cache_key {
        return Err(Error::invalid_input(
            "runtime cache key does not match the source text",
        ));
    }
    let project = db
        .get_project(session.project_id)?
        .ok_or_else(|| Error::invalid_input("runtime project is missing"))?;
    if project.engine != session.engine {
        return Err(Error::invalid_input(
            "runtime project engine does not match",
        ));
    }
    let codec = TextCodec::encode_for_provider(&analysis.normalized_text);
    let newline_count =
        i64::try_from(analysis.normalized_text.matches('\n').count()).unwrap_or(i64::MAX);
    let source = NewSourceText {
        source_language: session.source_language.clone(),
        unit_kind: if request.kind == "message_block" {
            "message_block"
        } else {
            "runtime_text"
        }
        .into(),
        normalized_hash: String::new(),
        normalized_text: analysis.normalized_text,
        visible_text: analysis.visible_text,
        codec_text: codec.provider_text,
        control_code_signature: analysis.control_code_signature,
        line_count: newline_count + 1,
        newline_count,
        placeholder_count: i64::try_from(codec.control_codes.len()).unwrap_or(i64::MAX),
    };
    let source_id = db.upsert_runtime_candidate_occurrence(
        session.project_id,
        &source,
        &NewOccurrence {
            project_id: Some(session.project_id),
            source_text_id: 0,
            file_path: "runtime".into(),
            json_path: key.clone(),
            entity_type: request.adapter.clone(),
            object_key: Some(request.kind.clone()),
            event_id: None,
            page_index: None,
            command_index: None,
            command_code: None,
            parameter_index: None,
            extraction_rule_id: "runtime.visible-text".into(),
        },
    )?;
    let cached = db.get_translation(source_id, &session.target_language)?;
    let valid = |row: &crate::TranslationRecord| {
        row.qa_state == "passed"
            && row.review_state != "rejected"
            && TextCodec::runtime_number_tokens_match(&request.text, &row.translated_text)
            && (unchanged_allowed || row.translated_text.trim() != request.text.trim())
    };
    if !cached.as_ref().is_some_and(valid) {
        let context = if request.adapter == "message"
            || request.kind.contains("message")
            || request.kind.contains("scroll")
        {
            "Context: RPG Maker story dialogue or narration. Keep natural conversational tone and character intent."
        } else if request
            .window_type
            .as_ref()
            .is_some_and(|name| name.to_ascii_lowercase().contains("name"))
        {
            "Context: character or speaker name shown in a name box. Localize it as a name, not as a menu category."
        } else {
            "Context: visible RPG Maker game interface. Short strings are menu items, buttons, settings or parameter labels. Choose their interface meanings rather than isolated dictionary senses. Translate complete sentences naturally."
        };
        let mut contextual = ContextualRuntimeProvider {
            inner: provider,
            context,
        };
        BatchTranslator::run(
            db,
            &mut contextual,
            &session.target_language,
            BatchTranslatorConfig {
                project_id: Some(session.project_id),
                source_language: session.source_language.clone(),
                source_text_ids: Some(vec![source_id]),
                include_existing_translations: true,
                max_items_per_batch: 1,
                provider_spacing: ProviderRequestSpacingConfig::failure_backoff_only(),
                ..BatchTranslatorConfig::default()
            },
        )?;
    }
    let translation = db
        .get_translation(source_id, &session.target_language)?
        .filter(valid)
        .ok_or_else(|| Error::invalid_input("runtime translation did not pass validation"))?;
    Ok(RuntimeReply {
        schema_version: 1,
        cache_key: key,
        text: request.text.clone(),
        translation: Some(translation.translated_text),
        error: None,
        unchanged_allowed,
    })
}

// 화면 역할을 제공하되 모델 호출·재시도·응답 검증은 기존 제공자와 배치 계층에 둡니다.
struct ContextualRuntimeProvider<'a, P> {
    inner: &'a mut P,
    context: &'static str,
}
impl<P: ProviderClient> ProviderClient for ContextualRuntimeProvider<'_, P> {
    fn provider_name(&self) -> &str {
        self.inner.provider_name()
    }
    fn model_name(&self) -> Option<&str> {
        self.inner.model_name()
    }
    fn translate_batch(
        &mut self,
        request: &crate::ProviderBatchRequest,
    ) -> Result<crate::ProviderBatchResponse> {
        let mut request = request.clone();
        request.instruction = Some(format!(
            "{}\n{}",
            self.context,
            request.instruction.as_deref().unwrap_or("")
        ));
        self.inner.translate_batch(&request)
    }
}

pub struct RuntimeMailbox {
    directory: PathBuf,
    last_error: Option<String>,
    // OS 파일 잠금은 프로세스가 비정상 종료돼도 해제되므로 오래된 잠금 파일을 지울 필요가 없습니다.
    _lock: File,
}

impl RuntimeMailbox {
    pub fn open(directory: impl AsRef<Path>) -> Result<Self> {
        let directory = directory.as_ref().to_path_buf();
        fs::create_dir_all(directory.join("requests")).map_err(io_error)?;
        fs::create_dir_all(directory.join("responses")).map_err(io_error)?;
        fs::create_dir_all(directory.join("processing")).map_err(io_error)?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(directory.join("worker.lock"))
            .map_err(io_error)?;
        lock.try_lock().map_err(|error| {
            Error::invalid_input(format!("runtime worker is already active: {error}"))
        })?;
        recover_processing_requests(&directory)?;
        Ok(Self {
            directory,
            last_error: None,
            _lock: lock,
        })
    }

    pub fn process_pending(
        &mut self,
        db: &mut TranslationDb,
        provider: &mut impl ProviderClient,
        session: &RuntimeSession,
    ) -> Result<usize> {
        self.process_pending_with_control(db, provider, session, || false)
    }

    pub fn process_pending_with_control(
        &mut self,
        db: &mut TranslationDb,
        provider: &mut impl ProviderClient,
        session: &RuntimeSession,
        should_stop: impl Fn() -> bool,
    ) -> Result<usize> {
        recover_processing_requests(&self.directory)?;
        let mut requests = Vec::new();
        for entry in fs::read_dir(self.directory.join("requests")).map_err(io_error)? {
            let entry = entry.map_err(io_error)?;
            if !entry.file_type().map_err(io_error)?.is_file() {
                continue;
            }
            let path = entry.path();
            let stem = path
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("");
            if path.extension().and_then(|value| value.to_str()) != Some("json") || !valid_id(stem)
            {
                continue;
            }
            if entry.metadata().map_err(io_error)?.len() > 131_072 {
                fs::rename(&path, path.with_extension("rejected")).map_err(io_error)?;
                continue;
            }
            let bytes = fs::read(&path).map_err(io_error)?;
            let request: RuntimeRequest = match serde_json::from_slice(&bytes) {
                Ok(value) => value,
                Err(_) => {
                    fs::rename(&path, path.with_extension("rejected")).map_err(io_error)?;
                    continue;
                }
            };
            if request.cache_key != format!("ck:v1:{stem}") {
                fs::rename(&path, path.with_extension("rejected")).map_err(io_error)?;
                continue;
            }
            requests.push((path, request));
        }
        requests.sort_by_key(|(_, request)| std::cmp::Reverse(request.priority.clamp(0, 1000)));
        // 요청 하나를 처리할 때마다 우선순위를 다시 읽어 새 대사가 배경 작업 뒤에 밀리지 않게 합니다.
        let count = requests.len().min(1);
        for (path, request) in requests.into_iter().take(1) {
            if should_stop() {
                return Ok(0);
            }
            // 처리 중 파일을 분리해 같은 키의 새 요청을 이전 작업이 지우지 않게 합니다.
            let processing = self.directory.join("processing").join(
                path.file_name()
                    .ok_or_else(|| Error::invalid_input("runtime request has no filename"))?,
            );
            fs::rename(&path, &processing).map_err(io_error)?;
            let reply = translate_runtime_request(db, provider, session, &request).unwrap_or_else(
                |error| RuntimeReply {
                    schema_version: 1,
                    cache_key: request.cache_key.clone(),
                    text: request.text.clone(),
                    translation: None,
                    error: Some(error.to_string()),
                    unchanged_allowed: false,
                },
            );
            // 중지 중인 요청은 응답 오류로 확정하지 않고 다음 시작 때 다시 처리합니다.
            if should_stop() {
                restore_processing_request(&processing, &path)?;
                return Ok(0);
            }
            self.last_error = reply.error.clone();
            let response = self.directory.join("responses").join(
                path.file_name()
                    .ok_or_else(|| Error::invalid_input("runtime request has no filename"))?,
            );
            atomic_write(
                &response,
                &serde_json::to_vec(&reply)
                    .map_err(|error| Error::invalid_input(error.to_string()))?,
            )?;
            fs::remove_file(processing).map_err(io_error)?;
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        atomic_write(
            &self.directory.join("status.json"),
            format!("{{\"schema_version\":1,\"running\":true,\"updated_at\":{now}}}").as_bytes(),
        )?;
        Ok(count)
    }

    #[must_use]
    pub fn last_error(&self) -> Option<String> {
        self.last_error.clone()
    }
}

impl Drop for RuntimeMailbox {
    fn drop(&mut self) {
        let _ = atomic_write(
            &self.directory.join("status.json"),
            b"{\"schema_version\":1,\"running\":false}",
        );
    }
}

fn restore_processing_request(processing: &Path, request: &Path) -> Result<()> {
    if request.exists() {
        fs::remove_file(processing).map_err(io_error)
    } else {
        fs::rename(processing, request).map_err(io_error)
    }
}

fn recover_processing_requests(directory: &Path) -> Result<()> {
    for entry in fs::read_dir(directory.join("processing")).map_err(io_error)? {
        let entry = entry.map_err(io_error)?;
        let path = entry.path();
        if !entry.file_type().map_err(io_error)?.is_file()
            || path.extension().and_then(|value| value.to_str()) != Some("json")
            || !path
                .file_stem()
                .and_then(|value| value.to_str())
                .is_some_and(valid_id)
        {
            continue;
        }
        restore_processing_request(&path, &directory.join("requests").join(entry.file_name()))?;
    }
    Ok(())
}

fn valid_id(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|ch| ch.is_ascii_hexdigit())
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, bytes).map_err(io_error)?;
    // 같은 폴더의 임시 파일을 교체해 읽는 쪽에서 기존 응답이 사라지는 구간을 없앱니다.
    fs::rename(temporary, path).map_err(io_error)
}

fn io_error(error: std::io::Error) -> Error {
    Error::invalid_input(format!("runtime mailbox I/O failed: {error}"))
}
