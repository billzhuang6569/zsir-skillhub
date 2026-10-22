//! Compiled-in route contract shared with the Desktop adapter; never supplied by IPC.
use reqwest::{Method, Url};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::sync::LazyLock;

#[derive(Deserialize)]
pub(super) struct Definition {
    pub method: String,
    pub path: String,
    pub auth: bool,
    #[serde(default)]
    pub optional: bool,
    #[serde(default)]
    pub session: Option<String>,
    #[serde(default)]
    pub profiles: Option<Vec<String>>,
    #[serde(default, rename = "sessionByProfile")]
    pub session_by_profile: BTreeMap<String, String>,
    query: Vec<String>,
}

impl Definition {
    pub(super) fn effect(&self, profile: &str) -> Result<Option<&str>, String> {
        if profile == "local"
            || self
                .profiles
                .as_ref()
                .is_some_and(|profiles| !profiles.iter().any(|p| p == profile))
        {
            return Err("此空间不支持该操作".into());
        }
        Ok(self
            .session_by_profile
            .get(profile)
            .map(String::as_str)
            .or(self.session.as_deref()))
    }
}

static ROUTES: LazyLock<BTreeMap<String, Definition>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../src/lib/server-routes.json"))
        .expect("compiled SkillHub route registry")
});

#[derive(Deserialize)]
#[serde(try_from = "String")]
pub(super) struct Route(String);

impl TryFrom<String> for Route {
    type Error = &'static str;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        if ROUTES.contains_key(&value) {
            Ok(Self(value))
        } else {
            Err("未知的 SkillHub 路由")
        }
    }
}

// Both maps accept string values only; each route rejects unregistered keys.
pub(super) type RouteParams = BTreeMap<String, String>;

impl Route {
    pub(super) fn name(&self) -> &str {
        &self.0
    }
    pub fn definition(&self) -> &Definition {
        &ROUTES[&self.0]
    }

    pub fn resolve(
        &self,
        base: &Url,
        params: &RouteParams,
        query: &RouteParams,
    ) -> Result<(Method, Url), String> {
        let definition = self.definition();
        let template: Vec<_> = definition.path.trim_start_matches('/').split('/').collect();
        let keys: Vec<_> = template
            .iter()
            .filter_map(|part| part.strip_prefix(':'))
            .collect();
        if params.len() != keys.len()
            || params.keys().any(|key| !keys.contains(&key.as_str()))
            || query.keys().any(|key| !definition.query.contains(key))
        {
            return Err("SkillHub 路由参数无效".into());
        }
        let segments: Vec<_> = template
            .iter()
            .map(|part| {
                part.strip_prefix(':')
                    .map_or(*part, |key| params[key].as_str())
            })
            .collect();
        let mut url = super::route_url(base, &segments)?;
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query);
        }
        let method = Method::from_bytes(definition.method.as_bytes())
            .map_err(|_| "SkillHub 路由方法无效")?;
        Ok((method, url))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_effects_are_profile_bound() {
        assert_eq!(
            ROUTES["auth.login"].effect("official").unwrap(),
            Some("migration")
        );
        assert_eq!(
            ROUTES["auth.login"].effect("selfhost").unwrap(),
            Some("establish")
        );
        for route in ["auth.register", "setup.admin"] {
            assert!(ROUTES[route].effect("official").is_err());
            assert_eq!(ROUTES[route].effect("selfhost").unwrap(), Some("establish"));
        }
        assert_eq!(ROUTES["setup.status"].effect("selfhost").unwrap(), None);
        assert!(ROUTES["setup.status"].effect("official").is_err());
        for definition in ROUTES.values() {
            assert!(definition.effect("local").is_err());
        }
    }

    #[test]
    fn only_feedback_and_install_intent_writes_have_optional_auth() {
        let optional: Vec<_> = ROUTES
            .iter()
            .filter(|(_, definition)| definition.optional)
            .map(|(id, definition)| {
                assert!(
                    !definition.auth,
                    "optional auth must not require sign-in: {id}"
                );
                id.as_str()
            })
            .collect();
        assert_eq!(
            optional,
            [
                "feedback.create",
                "marketplace.install-intents.create",
                "marketplace.install-intents.update",
            ]
        );
        assert!(ROUTES["auth.me"].auth);
        assert!(!ROUTES["health"].auth);
    }

    #[test]
    fn every_route_resolves_method_path_and_encoded_parameters() {
        let base = Url::parse("https://example.com/skillhub/").unwrap();
        for (id, definition) in ROUTES.iter() {
            let route = Route::try_from(id.clone()).unwrap();
            for (value, encoded) in [
                ("fixture", "fixture"),
                ("../", "..%2F"),
                ("/", "%2F"),
                ("?", "%3F"),
                ("#", "%23"),
                ("a b", "a%20b"),
                ("%2F", "%252F"),
            ] {
                let params: RouteParams = definition
                    .path
                    .split('/')
                    .filter_map(|part| part.strip_prefix(':'))
                    .map(|key| (key.into(), value.into()))
                    .collect();
                let (method, url) = route.resolve(&base, &params, &RouteParams::new()).unwrap();
                assert_eq!(method.as_str(), definition.method, "{id}");
                let expected = definition
                    .path
                    .split('/')
                    .map(|part| if part.starts_with(':') { encoded } else { part })
                    .collect::<Vec<_>>()
                    .join("/");
                assert_eq!(
                    url.as_str(),
                    format!("https://example.com/skillhub{expected}"),
                    "{id}"
                );
                let query: RouteParams = definition
                    .query
                    .iter()
                    .map(|key| (key.clone(), "a /?#&".into()))
                    .collect();
                let (_, url) = route.resolve(&base, &params, &query).unwrap();
                assert_eq!(
                    url.query_pairs().into_owned().collect::<RouteParams>(),
                    query
                );
                assert!(route
                    .resolve(
                        &base,
                        &params,
                        &BTreeMap::from([("url".into(), "https://evil.test".into())])
                    )
                    .is_err());
            }
        }
    }

    #[test]
    fn rejects_unknown_routes_missing_extra_and_non_string_parameters() {
        for value in ["unknown", "https://evil.test", "/api/skills"] {
            assert!(Route::try_from(value.to_string()).is_err());
        }
        let base = Url::parse("https://example.com").unwrap();
        let route = Route::try_from("skills.get".to_string()).unwrap();
        assert!(route
            .resolve(&base, &RouteParams::new(), &RouteParams::new())
            .is_err());
        for value in ["", ".", ".."] {
            assert!(route
                .resolve(
                    &base,
                    &BTreeMap::from([("skillId".into(), value.into())]),
                    &RouteParams::new()
                )
                .is_err());
        }
        assert!(serde_json::from_value::<RouteParams>(serde_json::json!({"skillId": 1})).is_err());
    }
}
