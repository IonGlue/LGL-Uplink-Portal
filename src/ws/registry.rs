use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};
use uuid::Uuid;

/// A handle to send messages to a connected device's WebSocket
pub type DeviceSender = mpsc::Sender<String>;

#[derive(Clone, Default)]
pub struct WsRegistry {
    inner: Arc<RwLock<HashMap<Uuid, DeviceSender>>>,
}

impl WsRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn insert(&self, device_id: Uuid, tx: DeviceSender) {
        self.inner.write().await.insert(device_id, tx);
    }

    pub async fn remove(&self, device_id: Uuid) {
        self.inner.write().await.remove(&device_id);
    }

    pub async fn is_connected(&self, device_id: Uuid) -> bool {
        self.inner.read().await.contains_key(&device_id)
    }

    pub async fn send(&self, device_id: Uuid, msg: String) -> bool {
        if let Some(tx) = self.inner.read().await.get(&device_id) {
            tx.send(msg).await.is_ok()
        } else {
            false
        }
    }
}
