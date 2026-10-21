//! Supervision of long-running top-level tasks.

use std::future::Future;

use anyhow::{anyhow, Context, Result};
use tokio::task::JoinSet;

pub type SupervisedTasks = JoinSet<(&'static str, Result<()>)>;

pub fn spawn_supervised<F>(tasks: &mut SupervisedTasks, name: &'static str, future: F)
where
    F: Future<Output = Result<()>> + Send + 'static,
{
    tasks.spawn(async move { (name, future.await) });
}

/// Waits for Ctrl-C or the first supervised task to finish, then aborts the
/// rest. `label` names the process in error messages (e.g. "SSH proxy").
pub async fn supervise_until_shutdown(label: &str, tasks: &mut SupervisedTasks) -> Result<()> {
    let outcome = tokio::select! {
        signal = tokio::signal::ctrl_c() => {
            signal.with_context(|| format!("failed to wait for {label} shutdown signal"))?;
            Ok(())
        }
        completed = tasks.join_next() => {
            match completed {
                Some(Ok((name, Ok(())))) => Err(anyhow!("{name} exited unexpectedly")),
                Some(Ok((name, Err(error)))) => Err(error).with_context(|| format!("{name} failed")),
                Some(Err(error)) => Err(anyhow!("supervised {label} task failed: {error}")),
                None => Err(anyhow!("all supervised {label} tasks exited unexpectedly")),
            }
        }
    };
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn supervised_task_exit_is_a_process_error() {
        let mut tasks = JoinSet::new();
        spawn_supervised(&mut tasks, "test listener", async { Ok(()) });

        let error = supervise_until_shutdown("test proxy", &mut tasks)
            .await
            .expect_err("unexpected top-level exit must fail the process");

        assert!(error
            .to_string()
            .contains("test listener exited unexpectedly"));
    }

    #[tokio::test]
    async fn supervised_task_failure_is_wrapped_with_its_name() {
        let mut tasks = JoinSet::new();
        spawn_supervised(&mut tasks, "test listener", async { Err(anyhow!("boom")) });

        let error = supervise_until_shutdown("test proxy", &mut tasks)
            .await
            .expect_err("task failure must fail the process");

        assert!(format!("{error:#}").contains("test listener failed: boom"));
    }

    #[tokio::test]
    async fn empty_task_set_names_the_proxy_in_the_error() {
        let mut tasks = SupervisedTasks::new();

        let error = supervise_until_shutdown("test proxy", &mut tasks)
            .await
            .expect_err("an empty task set must fail the process");

        assert!(error
            .to_string()
            .contains("all supervised test proxy tasks exited unexpectedly"));
    }
}
