fn main() {
    println!("cargo:rerun-if-changed=icons");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed=../package.json");
    for key in [
        "PYMSS_BUILD_GIT_COMMIT",
        "PYMSS_BUILD_GIT_TAG",
        "PYMSS_BUILD_GIT_REF",
        "PYMSS_BUILD_RUN_ID",
        "PYMSS_BUILD_RUN_ATTEMPT",
        "PYMSS_BUILD_REPOSITORY",
        "PYMSS_BUILD_REPOSITORY_OWNER",
        "PYMSS_BUILD_TIME",
        "PYMSS_BUILD_TARGET",
        "PYMSS_BUILD_VARIANT",
        "PYMSS_BUILD_UPDATE_SUPPORTED",
        "PYMSS_BUILD_OFFICIAL",
    ] {
        println!("cargo:rerun-if-env-changed={key}");
        if let Ok(value) = std::env::var(key) {
            println!("cargo:rustc-env={key}={value}");
        }
    }
    tauri_build::build()
}
