use std::collections::HashSet;

/// Manages a pool of internal SRT ports assigned to source workers.
pub struct PortPool {
    start: u16,
    end: u16,
    allocated: HashSet<u16>,
}

impl PortPool {
    pub fn new(start: u16, end: u16) -> Self {
        Self { start, end, allocated: HashSet::new() }
    }

    /// Allocate the next available port in the range.
    pub fn allocate(&mut self) -> Option<u16> {
        for port in self.start..=self.end {
            if !self.allocated.contains(&port) {
                self.allocated.insert(port);
                return Some(port);
            }
        }
        None
    }

    /// Release a port back to the pool.
    pub fn release(&mut self, port: u16) {
        self.allocated.remove(&port);
    }

    pub fn is_allocated(&self, port: u16) -> bool {
        self.allocated.contains(&port)
    }

    pub fn allocated_count(&self) -> usize {
        self.allocated.len()
    }

    pub fn capacity(&self) -> usize {
        (self.end - self.start + 1) as usize
    }
}
