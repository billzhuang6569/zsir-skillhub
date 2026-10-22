// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let explicit_cli = std::env::var("SKILLHUB_CLI").as_deref() == Ok("1")
        || matches!(
            args.first().map(String::as_str),
            Some(
                "auth"
                    | "server"
                    | "run"
                    | "skill"
                    | "status"
                    | "doctor"
                    | "agent"
                    | "app"
                    | "update"
                    | "marketplace"
                    | "team"
                    | "feedback"
                    | "env"
                    | "sync"
                    | "--help"
                    | "-h"
                    | "help"
                    | "--version"
                    | "-V"
            )
        );
    if explicit_cli {
        #[cfg(windows)]
        unsafe {
            use windows_sys::Win32::System::Console::{AttachConsole, ATTACH_PARENT_PROCESS};
            let _ = AttachConsole(ATTACH_PARENT_PROCESS);
        }
        std::process::exit(skillhub_lib::run_cli(&args));
    } else {
        // Finder/LaunchServices may append platform arguments such as -psn_*.
        // They belong to the GUI launch and must never be parsed as CLI input.
        skillhub_lib::run();
    }
}
