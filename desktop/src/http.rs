//! GPUI's HTTP client on NSURLSession, so `img()` can load remote plugin icons. GPUI ships no
//! client on native platforms; NSURLSession also follows the system proxy and HTTP cache.

use std::sync::Mutex;

use block2::RcBlock;
use futures::channel::oneshot;
use futures::future::BoxFuture;
use gpui_kit::http_client::http::HeaderValue;
use gpui_kit::http_client::{AsyncBody, HttpClient, Method, Request, Response, Result, Url, anyhow};
use objc2_foundation::{NSData, NSError, NSHTTPURLResponse, NSString, NSURL, NSURLResponse, NSURLSession};

/// Serves body-less GETs only: images are its one caller.
pub struct UrlSession;

impl HttpClient for UrlSession {
    fn user_agent(&self) -> Option<&HeaderValue> {
        None
    }

    fn proxy(&self) -> Option<&Url> {
        None
    }

    fn send(&self, request: Request<AsyncBody>) -> BoxFuture<'static, Result<Response<AsyncBody>>> {
        if request.method() != Method::GET {
            return Box::pin(async { Err(anyhow!("only GET is supported")) });
        }
        let Some(url) = NSURL::URLWithString(&NSString::from_str(&request.uri().to_string())) else {
            return Box::pin(async { Err(anyhow!("invalid URL")) });
        };
        let (sender, receiver) = oneshot::channel();
        // The handler is `Fn`, but NSURLSession calls it once.
        let sender = Mutex::new(Some(sender));
        let handler = RcBlock::new(move |data: *mut NSData, response: *mut NSURLResponse, error: *mut NSError| {
            // SAFETY: NSURLSession passes live objects or null, valid for the handler's duration.
            let result = unsafe { response_from(data.as_ref(), response.as_ref(), error.as_ref()) };
            if let Some(sender) = sender.lock().ok().and_then(|mut s| s.take()) {
                let _ = sender.send(result);
            }
        });
        // SAFETY: the handler only moves owned values out of the callback; it is sendable.
        unsafe { NSURLSession::sharedSession().dataTaskWithURL_completionHandler(&url, &handler) }.resume();
        Box::pin(async move { receiver.await.map_err(|_| anyhow!("request dropped"))? })
    }
}

fn response_from(
    data: Option<&NSData>,
    response: Option<&NSURLResponse>,
    error: Option<&NSError>,
) -> Result<Response<AsyncBody>> {
    if let Some(error) = error {
        return Err(anyhow!("{}", error.localizedDescription()));
    }
    let status = response
        .and_then(|r| r.downcast_ref::<NSHTTPURLResponse>())
        .ok_or_else(|| anyhow!("not an HTTP response"))?
        .statusCode();
    let body = data.map(NSData::to_vec).unwrap_or_default();
    Ok(Response::builder().status(u16::try_from(status)?).body(body.into())?)
}

#[cfg(test)]
mod tests;
