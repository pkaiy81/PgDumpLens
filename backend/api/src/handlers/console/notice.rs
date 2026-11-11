//! Capture server notices (`RAISE NOTICE`, `WARNING`, ...) for the console.
//!
//! sqlx 0.7 has no notice callback: it emits every `NoticeResponse` as a
//! tracing event with target [`NOTICE_TARGET`] and then drops it. The
//! [`NoticeCaptureLayer`] installed in `main` forwards those events into a
//! tokio task-local buffer, and [`with_notices`] scopes that buffer around one
//! statement so the console can print the notices psql-style. Events raised
//! outside a [`with_notices`] scope (e.g. on pooled connections) are ignored.

use std::cell::RefCell;
use std::fmt;
use std::future::Future;

use tracing::field::{Field, Visit};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::filter::Targets;
use tracing_subscriber::layer::{Context, Layer};

/// Target sqlx uses for postgres notice events.
pub const NOTICE_TARGET: &str = "sqlx::postgres::notice";

tokio::task_local! {
    static NOTICES: RefCell<Vec<String>>;
}

/// Tracing layer that records sqlx notice events into the current
/// [`with_notices`] scope.
pub struct NoticeCaptureLayer;

impl NoticeCaptureLayer {
    /// Per-layer filter selecting only notice events (at every level).
    pub fn filter() -> Targets {
        Targets::new().with_target(NOTICE_TARGET, Level::TRACE)
    }
}

impl<S: Subscriber> Layer<S> for NoticeCaptureLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let meta = event.metadata();
        if meta.target() != NOTICE_TARGET {
            return;
        }
        let mut visitor = MessageVisitor(None);
        event.record(&mut visitor);
        let Some(message) = visitor.0 else {
            return;
        };
        let line = format!("{}:  {}", severity_label(*meta.level()), message);
        let _ = NOTICES.try_with(|n| n.borrow_mut().push(line));
    }
}

/// Map sqlx's severity -> tracing level mapping back to psql's labels.
/// (sqlx maps both INFO and LOG to TRACE; INFO is what `RAISE INFO` sends.)
fn severity_label(level: Level) -> &'static str {
    match level {
        Level::ERROR => "ERROR",
        Level::WARN => "WARNING",
        Level::INFO => "NOTICE",
        Level::DEBUG => "DEBUG",
        Level::TRACE => "INFO",
    }
}

struct MessageVisitor(Option<String>);

impl Visit for MessageVisitor {
    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.0 = Some(value.to_string());
        }
    }

    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        if field.name() == "message" && self.0.is_none() {
            let s = format!("{:?}", value);
            let s = s
                .strip_prefix('"')
                .and_then(|s| s.strip_suffix('"'))
                .map(str::to_string)
                .unwrap_or(s);
            self.0 = Some(s);
        }
    }
}

/// Run `f`, returning its output together with the notices raised while it ran.
pub async fn with_notices<F: Future>(f: F) -> (F::Output, Vec<String>) {
    NOTICES
        .scope(RefCell::new(Vec::new()), async {
            let out = f.await;
            let notices = NOTICES.with(|n| n.take());
            (out, notices)
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tracing_subscriber::layer::SubscriberExt;

    fn emit(level: Level, text: &str) {
        let message = text.to_string();
        match level {
            Level::INFO => tracing::event!(target: "sqlx::postgres::notice", Level::INFO, message),
            Level::WARN => tracing::event!(target: "sqlx::postgres::notice", Level::WARN, message),
            Level::TRACE => {
                tracing::event!(target: "sqlx::postgres::notice", Level::TRACE, message)
            }
            _ => unreachable!(),
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn test_captures_notices_in_scope_only() {
        let subscriber = tracing_subscriber::registry()
            .with(NoticeCaptureLayer.with_filter(NoticeCaptureLayer::filter()));
        let _guard = tracing::subscriber::set_default(subscriber);

        // Outside a scope: silently ignored.
        emit(Level::INFO, "lost");

        let (out, notices) = with_notices(async {
            emit(Level::INFO, "hi 1");
            emit(Level::TRACE, "info msg");
            emit(Level::WARN, "careful");
            tracing::info!(target: "other", "unrelated");
            tokio::task::yield_now().await;
            42
        })
        .await;
        assert_eq!(out, 42);
        assert_eq!(
            notices,
            vec!["NOTICE:  hi 1", "INFO:  info msg", "WARNING:  careful"]
        );

        let (_, again) = with_notices(async {}).await;
        assert!(again.is_empty());
    }
}
