use super::*;
use std::time::Duration;

fn ip(value: &str) -> IpAddr {
    value.parse().unwrap()
}

fn settings(global: usize, pending: usize) -> LimitSettings {
    LimitSettings {
        global,
        per_client: global,
        per_site: global,
        pending,
    }
}

#[test]
fn per_client_limit_rejects_only_the_noisy_client() {
    let limiter = ConnectionLimiter::new(LimitSettings::basic(10, 2));
    let first = limiter.try_acquire(ip("192.0.2.1")).unwrap();
    let _second = limiter.try_acquire(ip("192.0.2.1")).unwrap();
    assert_eq!(
        limiter.try_acquire(ip("192.0.2.1")).unwrap_err(),
        LimitRejection::PerClient
    );
    let _other = limiter.try_acquire(ip("192.0.2.2")).unwrap();
    drop(first);
    assert!(limiter.try_acquire(ip("192.0.2.1")).is_ok());
}

#[test]
fn global_limit_applies_across_clients_and_frees_on_drop() {
    let limiter = ConnectionLimiter::new(LimitSettings::basic(2, 10));
    let a = limiter.try_acquire(ip("192.0.2.1")).unwrap();
    let _b = limiter.try_acquire(ip("192.0.2.2")).unwrap();
    assert_eq!(
        limiter.try_acquire(ip("192.0.2.3")).unwrap_err(),
        LimitRejection::Global
    );
    // A rejected attempt must not leak a per-client count.
    assert_eq!(limiter.active_for(ip("192.0.2.3")), 0);
    drop(a);
    assert!(limiter.try_acquire(ip("192.0.2.3")).is_ok());
}

#[test]
fn ipv6_clients_are_bucketed_by_slash_64_and_mapped_v4_by_address() {
    let limiter = ConnectionLimiter::new(LimitSettings::basic(10, 2));
    let _a = limiter.try_acquire(ip("2001:db8:1:2::1")).unwrap();
    let _b = limiter.try_acquire(ip("2001:db8:1:2:ffff::9")).unwrap();
    assert_eq!(
        limiter.try_acquire(ip("2001:db8:1:2:abcd::1")).unwrap_err(),
        LimitRejection::PerClient
    );
    assert!(limiter.try_acquire(ip("2001:db8:1:3::1")).is_ok());

    let _v4 = limiter.try_acquire(ip("198.51.100.7")).unwrap();
    let _mapped = limiter.try_acquire(ip("::ffff:198.51.100.7")).unwrap();
    assert_eq!(
        limiter.try_acquire(ip("198.51.100.7")).unwrap_err(),
        LimitRejection::PerClient
    );
}

#[test]
fn idle_buckets_are_forgotten() {
    let limiter = ConnectionLimiter::new(LimitSettings::basic(10, 2));
    let permit = limiter.try_acquire(ip("192.0.2.1")).unwrap();
    assert_eq!(limiter.tracked_clients(), 1);
    drop(permit);
    assert_eq!(limiter.tracked_clients(), 0);
    assert_eq!(limiter.pending_available(), 10);
}

#[test]
fn ipv6_sites_are_also_capped_per_slash_48() {
    let limiter = ConnectionLimiter::new(LimitSettings {
        per_client: 2,
        per_site: 3,
        ..settings(100, 100)
    });
    let _a = limiter.try_acquire(ip("2001:db8:1:1::1")).unwrap();
    let _b = limiter.try_acquire(ip("2001:db8:1:2::1")).unwrap();
    let c = limiter.try_acquire(ip("2001:db8:1:3::1")).unwrap();
    // A fourth /64 in the same /48 is refused even though its own
    // bucket is empty; another /48 and IPv4 are unaffected.
    assert_eq!(
        limiter.try_acquire(ip("2001:db8:1:4::1")).unwrap_err(),
        LimitRejection::PerSite
    );
    assert!(limiter.try_acquire(ip("2001:db8:2:1::1")).is_ok());
    assert!(limiter.try_acquire(ip("192.0.2.1")).is_ok());
    drop(c);
    assert!(limiter.try_acquire(ip("2001:db8:1:4::1")).is_ok());
}

#[test]
fn pending_slots_are_smaller_than_the_pool_and_freed_on_establishment() {
    let limiter = ConnectionLimiter::new(settings(4, 2));
    let mut a = limiter.try_acquire(ip("192.0.2.1")).unwrap();
    let b = limiter.try_acquire(ip("192.0.2.2")).unwrap();
    assert_eq!(
        limiter.try_acquire(ip("192.0.2.3")).unwrap_err(),
        LimitRejection::Pending
    );
    // A rejected attempt does not leak a per-client count.
    assert_eq!(limiter.active_for(ip("192.0.2.3")), 0);
    a.mark_established();
    let mut c = limiter.try_acquire(ip("192.0.2.3")).unwrap();
    let pending = c.take_pending().expect("pending slot");
    assert_eq!(limiter.pending_available(), 0);
    drop(pending);
    assert_eq!(limiter.pending_available(), 1);
    drop(b);
    let mut d = limiter.try_acquire(ip("192.0.2.4")).unwrap();
    d.mark_established();
    // Established connections still count against the global pool.
    let _e = limiter.try_acquire(ip("192.0.2.5")).unwrap();
    assert_eq!(
        limiter.try_acquire(ip("192.0.2.6")).unwrap_err(),
        LimitRejection::Global
    );
    drop(c);
}

#[test]
fn one_source_may_use_its_whole_per_ip_total_while_the_pool_has_room() {
    // One office NAT behind a single IPv4 address (or one IPv6 /48) opening
    // many connections at once: nothing but its per-IP / per-/48 totals
    // limits it while the pending pool has room.
    let limiter = ConnectionLimiter::new(LimitSettings {
        per_client: 16,
        per_site: 24,
        ..settings(100, 50)
    });
    let office = (0..16)
        .map(|_| limiter.try_acquire(ip("192.0.2.1")).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(limiter.pending_for(ip("192.0.2.1")), 16);
    assert_eq!(
        limiter.try_acquire(ip("192.0.2.1")).unwrap_err(),
        LimitRejection::PerClient
    );

    let site = (1..=24)
        .map(|n| {
            limiter
                .try_acquire(ip(&format!("2001:db8:1:{n:x}::1")))
                .unwrap()
        })
        .collect::<Vec<_>>();
    assert_eq!(
        limiter.try_acquire(ip("2001:db8:1:ff::1")).unwrap_err(),
        LimitRejection::PerSite
    );
    assert_eq!(limiter.pending_available(), 10);
    assert_eq!(limiter.evicted_total(), 0);
    drop((office, site));
    assert_eq!(limiter.pending_available(), 50);
}

#[tokio::test]
async fn a_full_pending_pool_evicts_the_heaviest_source_for_a_lighter_one() {
    let limiter = ConnectionLimiter::new(settings(100, 4));
    let mut heavy = (0..3)
        .map(|_| limiter.try_acquire(ip("203.0.113.9")).unwrap())
        .collect::<Vec<_>>();
    let mut light = limiter.try_acquire(ip("192.0.2.1")).unwrap();
    assert_eq!(limiter.pending_available(), 0);
    let evictions = heavy
        .iter_mut()
        .map(|permit| permit.take_pending().unwrap())
        .collect::<Vec<_>>();
    let watchers = evictions
        .iter()
        .map(PendingPermit::eviction)
        .collect::<Vec<_>>();

    // A fresh source gets in by evicting the heavy source's oldest pending
    // connection, which is told so and no longer counts.
    let mut fresh = limiter.try_acquire(ip("192.0.2.2")).unwrap();
    tokio::time::timeout(Duration::from_secs(1), watchers[0].wait())
        .await
        .expect("the oldest pending connection of the heaviest source was not evicted");
    assert!(!watchers[1].is_evicted());
    assert_eq!(limiter.pending_for(ip("203.0.113.9")), 2);
    assert_eq!(limiter.active_for(ip("203.0.113.9")), 3);
    assert_eq!(limiter.evicted_total(), 1);

    // Dropping the evicted permit later does not release a second slot.
    drop(evictions);
    assert_eq!(limiter.pending_available(), 2);
    assert_eq!(limiter.pending_for(ip("203.0.113.9")), 0);

    // With every source equally light the pool refuses instead.
    let _p = limiter.try_acquire(ip("192.0.2.3")).unwrap();
    let _q = limiter.try_acquire(ip("192.0.2.4")).unwrap();
    assert_eq!(
        limiter.try_acquire(ip("192.0.2.5")).unwrap_err(),
        LimitRejection::Pending
    );
    // A source never evicts itself.
    assert_eq!(
        limiter.try_acquire(ip("192.0.2.1")).unwrap_err(),
        LimitRejection::Pending
    );
    light.mark_established();
    fresh.mark_established();
}

#[tokio::test]
async fn an_established_connection_is_never_evicted() {
    let limiter = ConnectionLimiter::new(settings(100, 2));
    let mut first = limiter.try_acquire(ip("203.0.113.9")).unwrap();
    let pending = first.take_pending().unwrap();
    let eviction = pending.eviction();
    drop(pending);
    let _second = limiter.try_acquire(ip("203.0.113.9")).unwrap();
    let _third = limiter.try_acquire(ip("203.0.113.9")).unwrap();
    // The pool is full of the same source again; a newcomer evicts one of
    // the pending ones, never the established connection.
    let _fresh = limiter.try_acquire(ip("192.0.2.1")).unwrap();
    assert!(!eviction.is_evicted());
    assert!(
        tokio::time::timeout(Duration::from_millis(20), eviction.wait())
            .await
            .is_err()
    );
}

#[test]
fn ipv6_sources_are_weighed_per_slash_48() {
    let limiter = ConnectionLimiter::new(settings(100, 3));
    // Three /64s of one /48, one pending slot each: one heavy source.
    let _a = limiter.try_acquire(ip("2001:db8:1:1::1")).unwrap();
    let _b = limiter.try_acquire(ip("2001:db8:1:2::1")).unwrap();
    let _c = limiter.try_acquire(ip("2001:db8:1:3::1")).unwrap();
    assert!(limiter.try_acquire(ip("192.0.2.1")).is_ok());
    assert_eq!(limiter.evicted_total(), 1);
}

#[test]
fn limits_are_bounded_and_name_the_variable() {
    assert_eq!(validate_limit("X", 1, 1, 4).unwrap(), 1);
    assert_eq!(validate_limit("X", 4, 1, 4).unwrap(), 4);
    assert!(validate_limit("X", 0, 1, 4).is_err());
    let error = validate_limit("NYABASE_X_PER_IP", 5, 1, 4).unwrap_err();
    assert!(error.to_string().contains("NYABASE_X_PER_IP"));
}
