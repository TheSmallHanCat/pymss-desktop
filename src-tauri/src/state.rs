use crate::model_dir_migration::ModelDirMigrationSession;
use std::collections::HashMap;
use std::process::Child;
use std::sync::{Arc, Mutex};

pub type SharedChild = Arc<Mutex<Child>>;
pub type SharedMigrationSession = Arc<ModelDirMigrationSession>;

#[derive(Clone, Debug, Default)]
pub struct ProxySettings {
    pub mode: String,
    pub url: String,
    pub bypass: String,
}

pub struct AppState {
    pub tasks: Mutex<HashMap<String, SharedChild>>,
    pub migrations: Arc<Mutex<HashMap<String, SharedMigrationSession>>>,
    pub proxy_settings: Mutex<ProxySettings>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            tasks: Mutex::new(HashMap::new()),
            migrations: Arc::new(Mutex::new(HashMap::new())),
            proxy_settings: Mutex::new(ProxySettings {
                mode: "system".into(),
                ..ProxySettings::default()
            }),
        }
    }
}
