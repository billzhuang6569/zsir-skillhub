use std::sync::LazyLock;

include!(concat!(env!("OUT_DIR"), "/channel.rs"));

#[derive(serde::Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Channel {
    pub server_origin: String,
    pub catalog_origin: String,
    pub support_origin: String,
    pub style_origin: String,
    pub site_origin: String,
    pub docs_origin: String,
    pub updater: Updater,
}

#[derive(serde::Deserialize, Debug, PartialEq)]
pub struct Updater {
    pub endpoint: String,
    pub pubkey: String,
}

pub static COMPILED: LazyLock<Channel> = LazyLock::new(|| {
    serde_json::from_str(CHANNEL_JSON).expect("validated build channel constants")
});

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn official_constants_are_compiled_from_repository() {
        if CHANNEL == "official" {
            let expected: Channel =
                serde_json::from_str(include_str!("../../official-channel.json")).unwrap();
            assert_eq!(*COMPILED, expected);
            assert_eq!(expected.docs_origin, "https://sk.woe.show/docs/");
            assert_eq!(
                crate::runtime_env::trusted_server_origin()
                    .unwrap()
                    .as_str(),
                expected.server_origin
            );
        }
    }

    #[test]
    fn compiled_updater_and_identity_match_embedded_tauri_context() {
        let context = crate::app_context();
        let config = context.config();
        let updater = &config.plugins.0["updater"];
        assert_eq!(updater["pubkey"], COMPILED.updater.pubkey);
        assert_eq!(
            updater["endpoints"],
            serde_json::json!([COMPILED.updater.endpoint])
        );
        assert_eq!(
            config.plugins.0["deep-link"]["desktop"]["schemes"],
            serde_json::json!([DEEP_LINK_SCHEME])
        );
        assert_eq!(
            config.identifier,
            if CHANNEL == "dev" {
                "com.yitan.skillhub.dev"
            } else {
                "com.yitan.skillhub"
            }
        );
    }

    #[test]
    fn compiled_constants_have_no_runtime_configuration_reader() {
        let source = include_str!("official_channel.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        for runtime_input in ["std::env", "std::fs", "settings", "server_info"] {
            assert!(
                !source.contains(runtime_input),
                "unexpected runtime input: {runtime_input}"
            );
        }
    }
}
