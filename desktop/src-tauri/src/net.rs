//! Shared transport policy. Callers build URLs from their validated base URL;
//! redirects are never followed (3xx responses remain errors at existing callers).
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use reqwest::{Client, ClientBuilder, Url};
use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;

const HTTPS_REQUIRED: &str = "非本机回环地址必须使用 HTTPS，请检查服务器地址";

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectionError {
    pub code: &'static str,
    pub message: &'static str,
}

pub(crate) fn connection_error(error: &(dyn std::error::Error + 'static)) -> ConnectionError {
    let mut source = Some(error);
    while let Some(error) = source {
        if let Some(rustls::Error::InvalidCertificate(certificate)) =
            error.downcast_ref::<rustls::Error>()
        {
            let (code, message) = match certificate {
                rustls::CertificateError::UnknownIssuer => {
                    ("certificate_untrusted", "证书不受信任")
                }
                rustls::CertificateError::Expired
                | rustls::CertificateError::ExpiredContext { .. } => {
                    ("certificate_expired", "证书已过期")
                }
                rustls::CertificateError::NotValidForName
                | rustls::CertificateError::NotValidForNameContext { .. } => {
                    ("certificate_name_mismatch", "域名不匹配")
                }
                _ => ("certificate_invalid", "无法验证服务器证书"),
            };
            return ConnectionError { code, message };
        }
        if error.is::<rustls::Error>() {
            return ConnectionError {
                code: "tls_error",
                message: "无法验证服务器证书",
            };
        }
        source = error
            .downcast_ref::<std::io::Error>()
            .and_then(|error| {
                error
                    .get_ref()
                    .map(|inner| inner as &(dyn std::error::Error + 'static))
            })
            .or_else(|| error.source());
    }
    ConnectionError {
        code: "connection_failed",
        message: "无法连接服务器，请检查地址与网络",
    }
}

fn loopback_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => ip.is_loopback(),
        IpAddr::V6(ip) => {
            ip.is_loopback() || ip.to_ipv4_mapped().is_some_and(|ip| ip.is_loopback())
        }
    }
}

fn loopback_target(url: &Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    host.eq_ignore_ascii_case("localhost")
        || host
            .trim_matches(['[', ']'])
            .parse::<IpAddr>()
            .is_ok_and(loopback_ip)
}

pub(crate) fn validate_base_url(url: &Url) -> Result<(), String> {
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("SkillHub 服务地址无效，请使用 HTTP 或 HTTPS 地址".into());
    }
    if url.scheme() == "http" && !loopback_target(url) {
        return Err(HTTPS_REQUIRED.into());
    }
    Ok(())
}

struct ConnectionResolver {
    plaintext: bool,
    lookup: Arc<dyn Fn(String) -> Resolving + Send + Sync>,
}

impl Resolve for ConnectionResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let lookup = (self.lookup)(name.as_str().to_owned());
        let plaintext = self.plaintext;
        Box::pin(async move {
            let addresses: Vec<_> = lookup
                .await?
                .filter(|address| !plaintext || loopback_ip(address.ip()))
                .collect();
            if addresses.is_empty() {
                return Err(std::io::Error::other(if plaintext {
                    "服务器未解析到本机回环地址，必须使用 HTTPS"
                } else {
                    "服务器域名没有可用地址"
                })
                .into());
            }
            Ok(Box::new(addresses.into_iter()) as Addrs)
        })
    }
}

fn system_lookup(host: String) -> Resolving {
    Box::pin(async move {
        // The returned socket addresses go directly to reqwest's connector.
        // No cache or preflight lookup: each new connection resolves again.
        let addresses = tokio::net::lookup_host((host.as_str(), 0))
            .await?
            .collect::<Vec<_>>();
        Ok(Box::new(addresses.into_iter()) as Addrs)
    })
}

pub(crate) fn client_builder(base: &Url) -> Result<ClientBuilder, String> {
    client_builder_with_timeout(base, Some(Duration::from_secs(20)))
}

pub(crate) fn client_builder_with_timeout(
    base: &Url,
    timeout: Option<Duration>,
) -> Result<ClientBuilder, String> {
    validate_base_url(base)?;
    let mut builder = Client::builder()
        .https_only(base.scheme() == "https")
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(8))
        .dns_resolver(ConnectionResolver {
            plaintext: base.scheme() == "http",
            lookup: Arc::new(system_lookup),
        });
    if let Some(timeout) = timeout {
        builder = builder.timeout(timeout);
    }
    if loopback_target(base) {
        builder = builder.no_proxy();
    }
    // Keep reqwest's rustls platform verifier and non-loopback proxy defaults.
    Ok(builder)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::SocketAddr;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn certificate_errors_are_typed_through_error_chain() {
        for (error, code) in [
            (
                rustls::CertificateError::UnknownIssuer,
                "certificate_untrusted",
            ),
            (rustls::CertificateError::Expired, "certificate_expired"),
            (
                rustls::CertificateError::NotValidForName,
                "certificate_name_mismatch",
            ),
        ] {
            let outer = std::io::Error::other(rustls::Error::InvalidCertificate(error));
            assert_eq!(connection_error(&outer).code, code);
        }
        assert_eq!(
            connection_error(&std::io::Error::other("certificate expired")).code,
            "connection_failed"
        );
    }

    #[test]
    fn classifies_addresses_and_proxy_decision() {
        for host in [
            "localhost",
            "LOCALHOST",
            "127.0.0.1",
            "127.255.255.254",
            "[::1]",
            "[::ffff:127.1.2.3]",
        ] {
            let url = Url::parse(&format!("http://{host}:3001/skillhub")).unwrap();
            assert!(loopback_target(&url), "{host}");
            assert!(client_builder(&url).is_ok());
        }
        for host in [
            "128.0.0.1",
            "126.255.255.255",
            "192.168.1.1",
            "[::]",
            "[::ffff:8.8.8.8]",
            "skills.example.com",
            "localhost.example.com",
        ] {
            let url = Url::parse(&format!("http://{host}")).unwrap();
            assert!(!loopback_target(&url), "{host}");
            assert_eq!(client_builder(&url).err().unwrap(), HTTPS_REQUIRED);
            assert!(client_builder(&Url::parse(&format!("https://{host}")).unwrap()).is_ok());
        }
        for url in [
            "ftp://localhost",
            "https://user:secret@example.com",
            "https://example.com/?x=1",
            "https://example.com/#fragment",
        ] {
            assert!(client_builder(&Url::parse(url).unwrap()).is_err());
        }
    }

    fn injected_resolver(
        plaintext: bool,
        addresses: Vec<SocketAddr>,
        calls: Arc<AtomicUsize>,
    ) -> ConnectionResolver {
        ConnectionResolver {
            plaintext,
            lookup: Arc::new(move |_| {
                calls.fetch_add(1, Ordering::SeqCst);
                let addresses = addresses.clone();
                Box::pin(async move { Ok(Box::new(addresses.into_iter()) as Addrs) })
            }),
        }
    }

    #[tokio::test]
    async fn resolver_filters_actual_addresses_without_caching() {
        let public = "203.0.113.1:0".parse().unwrap();
        let local = "127.0.0.2:0".parse().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let resolver = injected_resolver(true, vec![public], calls.clone());
        assert!(resolver
            .resolve("localhost".parse().unwrap())
            .await
            .err()
            .unwrap()
            .to_string()
            .contains("HTTPS"));
        let resolver = injected_resolver(true, vec![public, local], calls.clone());
        for _ in 0..2 {
            assert_eq!(
                resolver
                    .resolve("localhost".parse().unwrap())
                    .await
                    .unwrap()
                    .collect::<Vec<_>>(),
                vec![local]
            );
        }
        let resolver = injected_resolver(false, vec![public, local], calls.clone());
        assert_eq!(
            resolver
                .resolve("example.com".parse().unwrap())
                .await
                .unwrap()
                .collect::<Vec<_>>(),
            vec![public, local]
        );
        assert_eq!(calls.load(Ordering::SeqCst), 4);
    }

    #[tokio::test]
    async fn connector_uses_filtered_addresses_and_does_not_follow_redirects() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = [0; 2048];
                assert!(stream.read(&mut request).await.unwrap() > 0);
                stream.write_all(b"HTTP/1.1 302 Found\r\nLocation: http://203.0.113.1/private\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
            }
        });
        let calls = Arc::new(AtomicUsize::new(0));
        let url = Url::parse(&format!("http://localhost:{}/", address.port())).unwrap();
        let client = client_builder(&url)
            .unwrap()
            .dns_resolver(injected_resolver(
                true,
                vec!["203.0.113.1:0".parse().unwrap(), address],
                calls.clone(),
            ))
            .build()
            .unwrap();
        for count in 1..=2 {
            let response = client
                .get(url.clone())
                .bearer_auth("test-only")
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), 302);
            assert_eq!(calls.load(Ordering::SeqCst), count);
        }
        server.await.unwrap();
    }
}
