use reqwest::Url;
use serde::Serialize;
use std::net::IpAddr;
use std::time::Duration;

const MAX_PAGE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Serialize)]
pub struct WebPage {
    pub url: String,
    pub html: String,
}

fn is_allowed_url(url: &Url) -> bool {
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") {
        return false;
    }
    if let Ok(address) = host.parse::<IpAddr>() {
        return match address {
            IpAddr::V4(ip) => {
                let octets = ip.octets();
                !(ip.is_private()
                    || ip.is_loopback()
                    || (octets[0] == 169 && octets[1] == 254)
                    || ip.is_unspecified())
            }
            IpAddr::V6(ip) => {
                let text = ip.to_string();
                !(ip.is_loopback()
                    || ip.is_unspecified()
                    || text.starts_with("fc")
                    || text.starts_with("fd")
                    || text.starts_with("fe80"))
            }
        };
    }
    true
}

#[tauri::command(async)]
pub async fn fetch_web_page(url: String) -> Result<WebPage, String> {
    let parsed = Url::parse(url.trim()).map_err(|_| "Enter a valid web address.".to_string())?;
    if !is_allowed_url(&parsed) {
        return Err("Only public HTTP or HTTPS article links can be opened.".into());
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent("AnnotateStudio/1.0 (article reader)")
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 || !is_allowed_url(attempt.url()) {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|error| format!("Could not start the article fetch: {error}"))?;
    let response = client
        .get(parsed)
        .send()
        .await
        .map_err(|error| format!("Could not fetch this page: {error}"))?
        .error_for_status()
        .map_err(|error| format!("The page returned an error: {error}"))?;
    if response
        .content_length()
        .is_some_and(|length| length > MAX_PAGE_BYTES as u64)
    {
        return Err("This page is too large to open in the article reader.".into());
    }
    let final_url = response.url().to_string();
    if !is_allowed_url(response.url()) {
        return Err("The page redirected to an unsupported address.".into());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Could not read the page: {error}"))?;
    if bytes.len() > MAX_PAGE_BYTES {
        return Err("This page is too large to open in the article reader.".into());
    }
    let html = String::from_utf8_lossy(&bytes).into_owned();
    Ok(WebPage {
        url: final_url,
        html,
    })
}
