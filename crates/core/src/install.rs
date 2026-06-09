use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{
    Error, ExportBuilder, GameLayoutKind, NewInstallRecord, Result, RpgMakerDetector, TranslationDb,
};

const INSTALL_SCHEMA_VERSION: u32 = 1;
pub(crate) const SUPPORT_DIRECTORY: &str = "rpg-translator";
pub(crate) const PLUGIN_ENTRY_FILE: &str = "RPGTranslator.js";
const PLUGIN_ENTRY_NAME: &str = "RPGTranslator";
const INSTALL_MANIFEST_FILE: &str = "install-manifest.json";
const PLUGINS_BACKUP_FILE: &str = "plugins.js.backup";
pub(crate) const RUNTIME_SCRIPT_LOAD_ORDER: &[&str] = &[
    "text-codec.js",
    "runtime-miss-logger.js",
    "lookup-index.js",
    "render-guard.js",
    "wrapping.js",
    "runtime-diagnostics.js",
    "orchestrator.js",
    "foresight-scanner.js",
    "cache-loader.js",
    "message-adapter.js",
    "window-text-adapter.js",
    "bitmap-text-adapter.js",
    "sprite-text-adapter.js",
    "pixi-text-adapter.js",
    "startup-toast.js",
    "boot.js",
];
pub(crate) const RUNTIME_SUPPORT_FILES: &[&str] = &[
    "text-codec.js",
    "runtime-miss-logger.js",
    "lookup-index.js",
    "render-guard.js",
    "wrapping.js",
    "runtime-diagnostics.js",
    "orchestrator.js",
    "foresight-scanner.js",
    "cache-loader.js",
    "message-adapter.js",
    "window-text-adapter.js",
    "bitmap-text-adapter.js",
    "sprite-text-adapter.js",
    "pixi-text-adapter.js",
    "startup-toast.js",
    "boot.js",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallOptions {
    pub game_root: PathBuf,
    pub export_dir: PathBuf,
    pub runtime_dir: Option<PathBuf>,
    pub project_id: Option<i64>,
    pub export_id: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallReport {
    pub install_id: Option<i64>,
    pub install_manifest_path: PathBuf,
    pub plugins_file: PathBuf,
    pub plugins_backup_path: PathBuf,
    pub installed_files: Vec<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RollbackOptions {
    pub manifest_path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RollbackReport {
    pub restored_plugins_file: PathBuf,
    pub removed_files: Vec<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstallManifest {
    pub schema_version: u32,
    pub project_id: Option<i64>,
    pub export_id: Option<i64>,
    pub game_root: String,
    pub layout: String,
    #[serde(default)]
    pub support_directory: String,
    #[serde(default)]
    pub plugin_entry_file: String,
    pub plugin_entry_name: String,
    pub plugin_entry_status: bool,
    pub plugins_file: String,
    pub plugins_backup_path: String,
    pub plugins_backup_sha256: String,
    #[serde(default)]
    pub runtime_script_load_order: Vec<String>,
    #[serde(default)]
    pub runtime_support_files: Vec<String>,
    #[serde(default)]
    pub required_asset_files: Vec<String>,
    pub installed_files: Vec<InstalledFileRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstalledFileRecord {
    pub path: String,
    pub sha256: String,
}

pub struct Installer;

impl Installer {
    pub fn install(options: &InstallOptions) -> Result<InstallReport> {
        Self::install_internal(None, options)
    }

    pub fn install_with_db(
        db: &mut TranslationDb,
        options: &InstallOptions,
    ) -> Result<InstallReport> {
        Self::install_internal(Some(db), options)
    }

    fn install_internal(
        db: Option<&mut TranslationDb>,
        options: &InstallOptions,
    ) -> Result<InstallReport> {
        ExportBuilder::verify_bundle(&options.export_dir)?;

        let detected = RpgMakerDetector::detect(&options.game_root)?;
        let plugins_file = PathBuf::from(&detected.plugin_path);
        let plugins_dir = plugins_file
            .parent()
            .ok_or_else(|| Error::invalid_input("plugins.js has no parent directory"))?
            .join("plugins");
        let support_dir = plugins_dir.join(SUPPORT_DIRECTORY);
        let install_manifest_path = support_dir.join(INSTALL_MANIFEST_FILE);
        let plugins_backup_path = existing_backup_path(&install_manifest_path)
            .unwrap_or_else(|| support_dir.join(PLUGINS_BACKUP_FILE));

        let plugins_state = PluginsFile::read(&plugins_file)?;
        let runtime_dir = options
            .runtime_dir
            .clone()
            .unwrap_or_else(default_runtime_dir);
        let export_files = export_files(&options.export_dir)?;
        validate_required_install_sources(&runtime_dir, &options.export_dir, &export_files)?;

        fs::create_dir_all(&support_dir).map_err(|error| {
            Error::invalid_input(format!(
                "failed to create support directory {}: {error}",
                support_dir.display()
            ))
        })?;
        if !plugins_backup_path.exists() {
            fs::write(&plugins_backup_path, &plugins_state.original_text).map_err(|error| {
                Error::invalid_input(format!(
                    "failed to write plugins.js backup {}: {error}",
                    plugins_backup_path.display()
                ))
            })?;
        }

        let mut installed_files = Vec::new();
        copy_recorded(
            &runtime_dir.join(PLUGIN_ENTRY_FILE),
            &plugins_dir.join(PLUGIN_ENTRY_FILE),
            &options.game_root,
            &mut installed_files,
        )?;
        for file in RUNTIME_SUPPORT_FILES {
            copy_recorded(
                &runtime_dir.join(file),
                &support_dir.join(file),
                &options.game_root,
                &mut installed_files,
            )?;
        }
        for file in &export_files {
            copy_recorded(
                &options.export_dir.join(file),
                &support_dir.join(file),
                &options.game_root,
                &mut installed_files,
            )?;
        }

        let updated_plugins = plugins_state.with_entry()?;
        fs::write(&plugins_file, updated_plugins).map_err(|error| {
            Error::invalid_input(format!(
                "failed to write plugins.js {}: {error}",
                plugins_file.display()
            ))
        })?;

        let manifest = InstallManifest {
            schema_version: INSTALL_SCHEMA_VERSION,
            project_id: options.project_id,
            export_id: options.export_id,
            game_root: normalize_path(&options.game_root),
            layout: layout_key(&detected.layout).to_string(),
            support_directory: SUPPORT_DIRECTORY.to_string(),
            plugin_entry_file: PLUGIN_ENTRY_FILE.to_string(),
            plugin_entry_name: PLUGIN_ENTRY_NAME.to_string(),
            plugin_entry_status: true,
            plugins_file: normalize_path(&plugins_file),
            plugins_backup_path: normalize_path(&plugins_backup_path),
            plugins_backup_sha256: sha256_file(&plugins_backup_path)?,
            runtime_script_load_order: string_vec(RUNTIME_SCRIPT_LOAD_ORDER),
            runtime_support_files: string_vec(RUNTIME_SUPPORT_FILES),
            required_asset_files: export_files
                .iter()
                .map(|file| normalize_path(file))
                .collect(),
            installed_files,
        };
        write_json_pretty(&install_manifest_path, &manifest)?;

        let install_id = if let Some(db) = db {
            Some(db.record_install(&NewInstallRecord {
                project_id: options.project_id,
                game_root: normalize_path(&options.game_root),
                export_id: options.export_id,
                backup_manifest_path: normalize_path(&install_manifest_path),
                status: "installed".to_string(),
            })?)
        } else {
            None
        };

        Ok(InstallReport {
            install_id,
            install_manifest_path,
            plugins_file,
            plugins_backup_path,
            installed_files: manifest
                .installed_files
                .iter()
                .map(|file| PathBuf::from(&file.path))
                .collect(),
        })
    }
}

pub struct RollbackManager;

impl RollbackManager {
    pub fn rollback(options: &RollbackOptions) -> Result<RollbackReport> {
        Self::rollback_internal(None, None, options)
    }

    pub fn rollback_with_db(
        db: &mut TranslationDb,
        install_id: i64,
        options: &RollbackOptions,
    ) -> Result<RollbackReport> {
        Self::rollback_internal(Some(db), Some(install_id), options)
    }

    fn rollback_internal(
        db: Option<&mut TranslationDb>,
        install_id: Option<i64>,
        options: &RollbackOptions,
    ) -> Result<RollbackReport> {
        let manifest: InstallManifest = read_json(&options.manifest_path)?;
        if manifest.schema_version != INSTALL_SCHEMA_VERSION {
            return Err(Error::invalid_input(format!(
                "unsupported install manifest schema version {}",
                manifest.schema_version
            )));
        }
        let game_root = PathBuf::from(&manifest.game_root);

        let plugins_file = PathBuf::from(&manifest.plugins_file);
        let plugins_backup_path = PathBuf::from(&manifest.plugins_backup_path);
        ensure_within(&game_root, &options.manifest_path)?;
        ensure_within(&game_root, &plugins_file)?;
        ensure_within(&game_root, &plugins_backup_path)?;
        verify_file_hash(&plugins_backup_path, &manifest.plugins_backup_sha256)?;
        verify_installed_files(&game_root, &manifest.installed_files)?;
        fs::copy(&plugins_backup_path, &plugins_file).map_err(|error| {
            Error::invalid_input(format!(
                "failed to restore plugins.js from {} to {}: {error}",
                plugins_backup_path.display(),
                plugins_file.display()
            ))
        })?;

        let mut removed_files = Vec::new();
        for file in &manifest.installed_files {
            let path = PathBuf::from(&file.path);
            ensure_within(&game_root, &path)?;
            if path.exists() {
                fs::remove_file(&path).map_err(|error| {
                    Error::invalid_input(format!("failed to remove {}: {error}", path.display()))
                })?;
                removed_files.push(path);
            }
        }
        if options.manifest_path.exists() {
            fs::remove_file(&options.manifest_path).map_err(|error| {
                Error::invalid_input(format!(
                    "failed to remove install manifest {}: {error}",
                    options.manifest_path.display()
                ))
            })?;
        }
        if plugins_backup_path.exists() {
            fs::remove_file(&plugins_backup_path).map_err(|error| {
                Error::invalid_input(format!(
                    "failed to remove plugins.js backup {}: {error}",
                    plugins_backup_path.display()
                ))
            })?;
            removed_files.push(plugins_backup_path);
        }
        if let Some(parent) = options.manifest_path.parent() {
            let _ = fs::remove_dir(parent);
        }

        if let (Some(db), Some(install_id)) = (db, install_id) {
            db.update_install_status(install_id, "rolled-back")?;
        }

        Ok(RollbackReport {
            restored_plugins_file: plugins_file,
            removed_files,
        })
    }
}

struct PluginsFile {
    original_text: String,
    prefix: String,
    entries: Vec<Value>,
    suffix: String,
}

impl PluginsFile {
    fn read(path: &Path) -> Result<Self> {
        let original_text = fs::read_to_string(path).map_err(|error| {
            Error::invalid_input(format!(
                "failed to read plugins.js {}: {error}",
                path.display()
            ))
        })?;
        let start = original_text
            .find('[')
            .ok_or_else(|| Error::invalid_input("plugins.js does not contain a plugin array"))?;
        let end = original_text
            .rfind(']')
            .ok_or_else(|| Error::invalid_input("plugins.js does not contain a plugin array"))?;
        if end < start {
            return Err(Error::invalid_input("plugins.js plugin array is malformed"));
        }
        let array_text = &original_text[start..=end];
        let entries: Vec<Value> = serde_json::from_str(array_text).map_err(|error| {
            Error::invalid_input(format!("failed to parse plugins.js plugin array: {error}"))
        })?;
        let prefix = original_text[..start].to_string();
        let suffix = original_text[end + 1..].to_string();
        Ok(Self {
            original_text,
            prefix,
            entries,
            suffix,
        })
    }

    fn with_entry(mut self) -> Result<String> {
        let entry = json!({
            "name": PLUGIN_ENTRY_NAME,
            "status": true,
            "description": "RPG-Translator cache-only runtime overlay",
            "parameters": {},
        });
        self.entries
            .retain(|item| item.get("name").and_then(Value::as_str) != Some(PLUGIN_ENTRY_NAME));
        self.entries.push(entry);
        let body = serde_json::to_string_pretty(&self.entries).map_err(|error| {
            Error::invalid_input(format!("failed to encode plugins.js: {error}"))
        })?;
        Ok(format!("{}{}{}", self.prefix, body, self.suffix))
    }
}

fn existing_backup_path(manifest_path: &Path) -> Option<PathBuf> {
    let manifest = read_json::<InstallManifest>(manifest_path).ok()?;
    let path = PathBuf::from(manifest.plugins_backup_path);
    path.exists().then_some(path)
}

fn export_files(export_dir: &Path) -> Result<Vec<PathBuf>> {
    let manifest: crate::RuntimeExportManifest = read_json(&export_dir.join("manifest.json"))?;
    let mut files = vec![
        PathBuf::from("manifest.json"),
        PathBuf::from("overlay-config.json"),
    ];
    for cache_file in manifest.cache_files {
        let file = PathBuf::from(cache_file);
        let name = file
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| Error::invalid_input("invalid cache file name"))?;
        if file.components().count() != 1
            || !(name == "cache.jsonl" || (name.starts_with("cache-") && name.ends_with(".jsonl")))
        {
            return Err(Error::invalid_input(format!(
                "unsupported export cache file {name}"
            )));
        }
        files.push(file);
    }
    Ok(files)
}

fn validate_required_install_sources(
    runtime_dir: &Path,
    export_dir: &Path,
    export_files: &[PathBuf],
) -> Result<()> {
    let mut required = vec![runtime_dir.join(PLUGIN_ENTRY_FILE)];
    required.extend(
        RUNTIME_SUPPORT_FILES
            .iter()
            .map(|file| runtime_dir.join(file)),
    );
    required.extend(export_files.iter().map(|file| export_dir.join(file)));
    for file in required {
        if !file.is_file() {
            return Err(Error::invalid_input(format!(
                "required install asset is missing: {}",
                file.display()
            )));
        }
    }
    Ok(())
}

fn copy_recorded(
    source: &Path,
    target: &Path,
    game_root: &Path,
    installed_files: &mut Vec<InstalledFileRecord>,
) -> Result<()> {
    ensure_within(game_root, target)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            Error::invalid_input(format!(
                "failed to create target directory {}: {error}",
                parent.display()
            ))
        })?;
    }
    fs::copy(source, target).map_err(|error| {
        Error::invalid_input(format!(
            "failed to copy {} to {}: {error}",
            source.display(),
            target.display()
        ))
    })?;
    installed_files.push(InstalledFileRecord {
        path: normalize_path(target),
        sha256: sha256_file(target)?,
    });
    Ok(())
}

fn verify_installed_files(game_root: &Path, files: &[InstalledFileRecord]) -> Result<()> {
    for file in files {
        let path = PathBuf::from(&file.path);
        ensure_within(game_root, &path)?;
        if !path.exists() {
            continue;
        }
        verify_file_hash(&path, &file.sha256)?;
    }
    Ok(())
}

fn verify_file_hash(path: &Path, expected: &str) -> Result<()> {
    let actual = sha256_file(path)?;
    if actual != expected {
        return Err(Error::invalid_input(format!(
            "installed file hash mismatch for {}",
            path.display()
        )));
    }
    Ok(())
}

fn ensure_within(root: &Path, path: &Path) -> Result<()> {
    let root = normalize_components(root)?;
    let path = normalize_components(path)?;
    if !path.starts_with(&root) {
        return Err(Error::invalid_input(format!(
            "refusing to write outside game root: {}",
            path.display()
        )));
    }
    Ok(())
}

fn normalize_components(path: &Path) -> Result<PathBuf> {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(value) => normalized.push(value),
            Component::RootDir | Component::Prefix(_) => normalized.push(component.as_os_str()),
        }
    }
    if normalized.as_os_str().is_empty() {
        return Err(Error::invalid_input("empty path is not allowed"));
    }
    Ok(normalized)
}

fn layout_key(layout: &GameLayoutKind) -> &'static str {
    match layout {
        GameLayoutKind::Direct => "direct",
        GameLayoutKind::Www => "www",
    }
}

fn default_runtime_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("runtime")
        .join("overlay-plugin")
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T> {
    let text = fs::read_to_string(path).map_err(|error| {
        Error::invalid_input(format!("failed to read {}: {error}", path.display()))
    })?;
    serde_json::from_str(&text).map_err(|error| {
        Error::invalid_input(format!("failed to parse {}: {error}", path.display()))
    })
}

fn write_json_pretty<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let text = serde_json::to_string_pretty(value)
        .map_err(|error| Error::invalid_input(format!("failed to encode JSON: {error}")))?;
    fs::write(path, format!("{text}\n")).map_err(|error| {
        Error::invalid_input(format!("failed to write {}: {error}", path.display()))
    })?;
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String> {
    let bytes = fs::read(path).map_err(|error| {
        Error::invalid_input(format!(
            "failed to read {} for hashing: {error}",
            path.display()
        ))
    })?;
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    Ok(hex::encode(hasher.finalize()))
}

fn normalize_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn string_vec(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_string()).collect()
}
