//! Ordering of discovery results. A discovery takes a number when it is spawned; a result is applied
//! only if nothing newer was applied first. An action's post-mutation discovery takes its number at
//! completion, so it outranks any discovery that was already running mid-mutation.

#[derive(Debug, Default)]
pub struct DiscoveryOrder {
    issued: u64,
    applied: u64,
}

impl DiscoveryOrder {
    pub fn issue(&mut self) -> u64 {
        self.issued += 1;
        self.issued
    }

    /// True (and remembered) when `seq` is newer than everything applied so far.
    pub fn accept(&mut self, seq: u64) -> bool {
        let newer = seq > self.applied;
        if newer {
            self.applied = seq;
        }
        newer
    }
}

#[cfg(test)]
mod tests;
