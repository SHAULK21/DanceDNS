fn main() {
    // Windows: embed the icon and the manifest (Administrator rights for port 53 and changing
    // the system DNS, Common Controls v6 for the native look).
    if std::env::var_os("CARGO_CFG_WINDOWS").is_some() {
        embed_resource::compile("dancedns.rc", embed_resource::NONE).manifest_required().expect("Windows resources");
    }
    println!("cargo:rerun-if-changed=dancedns.rc");
    println!("cargo:rerun-if-changed=dancedns.ico");
    println!("cargo:rerun-if-changed=dancedns.manifest");
}
