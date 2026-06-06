use crate::model_dir_migration::ModelDirMigrationSession;
use std::collections::HashMap;
use std::process::Child;
use std::sync::{Arc, Mutex};

pub type SharedChild = Arc<Mutex<Child>>;
pub type SharedMigrationSession = Arc<ModelDirMigrationSession>;

pub struct AppState {
    pub tasks: Mutex<HashMap<String, SharedChild>>,
    pub migrations: Arc<Mutex<HashMap<String, SharedMigrationSession>>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            tasks: Mutex::new(HashMap::new()),
            migrations: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}
