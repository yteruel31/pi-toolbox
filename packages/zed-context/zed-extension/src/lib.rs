use zed_extension_api::{self as zed, LanguageServerId, Worktree};

const SERVER_ID: &str = "pi-selection-bridge";
const HELPER_NAME: &str = "pi-zed-context";

struct PiSelectionBridgeExtension;

impl PiSelectionBridgeExtension {
    fn helper_command(worktree: &Worktree) -> Result<String, String> {
        let home = worktree
            .shell_env()
            .into_iter()
            .find_map(|(name, value)| (name == "HOME").then_some(value))
            .ok_or_else(|| {
                "Could not resolve HOME. Run `/zed-context setup` in Pi on this host."
                    .to_string()
            })?;

        Ok(format!("{home}/.local/bin/{HELPER_NAME}"))
    }
}

impl zed::Extension for PiSelectionBridgeExtension {
    fn new() -> Self {
        Self
    }

    fn language_server_command(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &Worktree,
    ) -> Result<zed::Command, String> {
        if language_server_id.as_ref() != SERVER_ID {
            return Err(format!("Unknown language server: {language_server_id}"));
        }

        Ok(zed::Command {
            command: Self::helper_command(worktree)?,
            args: vec![
                "lsp".to_string(),
                "--workspace".to_string(),
                worktree.root_path(),
            ],
            env: Default::default(),
        })
    }
}

zed::register_extension!(PiSelectionBridgeExtension);
