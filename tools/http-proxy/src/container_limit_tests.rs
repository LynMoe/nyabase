use super::*;

fn ip(value: &str) -> IpAddr {
    value.parse().unwrap()
}

fn caps(per_container: usize, per_client_per_container: usize, per_owner: usize) -> UpstreamCaps {
    UpstreamCaps {
        per_container,
        per_client_per_container,
        per_owner,
    }
}

#[test]
fn caps_each_container_separately_and_frees_on_drop() {
    let limiter = ContainerLimiter::new(UpstreamCaps::per_container(2));
    let first = limiter
        .try_acquire(ip("192.0.2.1"), "container-a", "user-a")
        .unwrap();
    let _second = limiter
        .try_acquire(ip("192.0.2.2"), "container-a", "user-a")
        .unwrap();
    assert_eq!(
        limiter
            .try_acquire(ip("192.0.2.3"), "container-a", "user-a")
            .unwrap_err(),
        UpstreamRefusal::Container
    );
    assert_eq!(limiter.active_for("container-a"), 2);
    // Another container is unaffected by a full one.
    let other = limiter
        .try_acquire(ip("192.0.2.3"), "container-b", "user-a")
        .unwrap();
    drop(first);
    assert_eq!(limiter.active_for("container-a"), 1);
    assert!(limiter
        .try_acquire(ip("192.0.2.3"), "container-a", "user-a")
        .is_ok());
    drop(other);
    assert_eq!(limiter.active_for("container-b"), 0);
}

#[test]
fn refused_attempts_and_released_permits_leave_no_entry() {
    let limiter = ContainerLimiter::new(caps(1, 1, 1));
    let permit = limiter
        .try_acquire(ip("192.0.2.1"), "container-a", "user-a")
        .unwrap();
    assert!(limiter
        .try_acquire(ip("192.0.2.1"), "container-a", "user-a")
        .is_err());
    assert!(limiter
        .try_acquire(ip("192.0.2.2"), "container-a", "user-a")
        .is_err());
    assert!(limiter
        .try_acquire(ip("192.0.2.2"), "container-b", "user-a")
        .is_err());
    assert_eq!(limiter.active_for("container-a"), 1);
    drop(permit);
    assert_eq!(limiter.tracked_entries(), 0);
}

#[test]
fn a_few_clients_cannot_fill_a_container() {
    let limiter = ContainerLimiter::new(caps(8, 2, 100));
    let held = ["192.0.2.1", "192.0.2.1", "192.0.2.2", "192.0.2.2"]
        .into_iter()
        .map(|client| {
            limiter
                .try_acquire(ip(client), "container-a", "user-a")
                .unwrap()
        })
        .collect::<Vec<_>>();
    assert_eq!(
        limiter
            .try_acquire(ip("192.0.2.1"), "container-a", "user-a")
            .unwrap_err(),
        UpstreamRefusal::ClientPerContainer
    );
    // Other visitors still reach the container, and the noisy client still
    // reaches other containers.
    assert!(limiter
        .try_acquire(ip("192.0.2.9"), "container-a", "user-a")
        .is_ok());
    assert!(limiter
        .try_acquire(ip("192.0.2.1"), "container-b", "user-b")
        .is_ok());
    // An IPv6 client counts per /64.
    let _v6 = limiter
        .try_acquire(ip("2001:db8::1"), "container-a", "user-a")
        .unwrap();
    let _v6b = limiter
        .try_acquire(ip("2001:db8::2"), "container-a", "user-a")
        .unwrap();
    assert_eq!(
        limiter
            .try_acquire(ip("2001:db8::3"), "container-a", "user-a")
            .unwrap_err(),
        UpstreamRefusal::ClientPerContainer
    );
    drop(held);
}

#[test]
fn one_owner_cannot_take_more_than_its_aggregate_share() {
    let limiter = ContainerLimiter::new(caps(2, 2, 3));
    let _a = limiter
        .try_acquire(ip("192.0.2.1"), "container-a", "user-a")
        .unwrap();
    let _b = limiter
        .try_acquire(ip("192.0.2.2"), "container-a", "user-a")
        .unwrap();
    let c = limiter
        .try_acquire(ip("192.0.2.3"), "container-b", "user-a")
        .unwrap();
    // A third container of the same owner is refused even though it is idle.
    assert_eq!(
        limiter
            .try_acquire(ip("192.0.2.4"), "container-c", "user-a")
            .unwrap_err(),
        UpstreamRefusal::Owner
    );
    assert_eq!(limiter.active_for_owner("user-a"), 3);
    // Other owners are unaffected.
    assert!(limiter
        .try_acquire(ip("192.0.2.4"), "container-d", "user-b")
        .is_ok());
    drop(c);
    assert!(limiter
        .try_acquire(ip("192.0.2.4"), "container-c", "user-a")
        .is_ok());
}

#[test]
fn refusals_warn_once_per_interval_per_container() {
    let limiter = ContainerLimiter::new(UpstreamCaps::per_container(1));
    let container = UpstreamRefusal::Container;
    let start = Instant::now();
    assert_eq!(
        limiter.note_refusal(container, "container-a", start),
        Some(1)
    );
    assert_eq!(limiter.note_refusal(container, "container-a", start), None);
    assert_eq!(
        limiter.note_refusal(container, "container-a", start + Duration::from_secs(59)),
        None
    );
    // Another container, and an owner of the same id, have their own budget.
    assert_eq!(
        limiter.note_refusal(container, "container-b", start),
        Some(1)
    );
    assert_eq!(
        limiter.note_refusal(UpstreamRefusal::Owner, "container-a", start),
        Some(1)
    );
    // One client's excess is never warned about.
    assert_eq!(
        limiter.note_refusal(UpstreamRefusal::ClientPerContainer, "container-c", start),
        None
    );
    // The next warning reports the refusals it stood in for.
    let later = start + REFUSAL_WARN_INTERVAL;
    assert_eq!(
        limiter.note_refusal(container, "container-a", later),
        Some(3)
    );
    assert_eq!(limiter.note_refusal(container, "container-a", later), None);
    // Stale entries are pruned once another key is warned about.
    let much_later = later + REFUSAL_WARN_INTERVAL * 2;
    assert_eq!(
        limiter.note_refusal(container, "container-c", much_later),
        Some(1)
    );
    assert_eq!(limiter.refusals.lock().unwrap().len(), 1);
}
