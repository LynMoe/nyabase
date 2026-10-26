//! Per-process instance ids.

/// A random id for this process, so the Backend can tell a restarted proxy
/// (whose counters and sequence numbers started again from zero) from the
/// one it replaced.
pub fn new_instance_id() -> String {
    let mut bytes = [0_u8; 16];
    if rustls::crypto::ring::default_provider()
        .secure_random
        .fill(&mut bytes)
        .is_err()
    {
        // Uniqueness, not secrecy, is what matters here.
        let seed = crate::clock::now_ms() as u128 ^ (std::process::id() as u128) << 64;
        bytes = seed.to_le_bytes();
    }
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
