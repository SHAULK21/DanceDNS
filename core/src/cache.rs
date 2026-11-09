//! LRU response cache honouring record TTLs (clamped to min/max).

use bytes::Bytes;
use lru::LruCache;
use parking_lot::Mutex;
use std::num::NonZeroUsize;
use std::time::{Duration, Instant};

struct Entry {
    payload: Bytes,
    expires: Instant,
}

pub struct DnsCache {
    inner: Mutex<LruCache<String, Entry>>,
    min_ttl: u32,
    max_ttl: u32,
}

impl DnsCache {
    pub fn new(capacity: usize, min_ttl: u32, max_ttl: u32) -> Self {
        let cap = NonZeroUsize::new(capacity.max(16)).unwrap();
        Self { inner: Mutex::new(LruCache::new(cap)), min_ttl, max_ttl: max_ttl.max(min_ttl) }
    }

    pub fn get(&self, key: &str) -> Option<Bytes> {
        let mut c = self.inner.lock();
        match c.get(key) {
            Some(e) if e.expires > Instant::now() => Some(e.payload.clone()),
            Some(_) => {
                c.pop(key);
                None
            }
            None => None,
        }
    }

    pub fn insert(&self, key: String, payload: Bytes, ttl: u32) {
        let ttl = ttl.clamp(self.min_ttl, self.max_ttl);
        if ttl == 0 {
            return;
        }
        self.inner.lock().put(key, Entry { payload, expires: Instant::now() + Duration::from_secs(ttl as u64) });
    }

    pub fn clear(&self) {
        self.inner.lock().clear();
    }

}
