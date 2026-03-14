use argon2::{
    password_hash::{PasswordHash, PasswordVerifier},
    Argon2,
};

fn main() {
    let password = "changeme";
    let hash_str = "$argon2id$v=19$m=19456,t=2,p=1$TRTxti3Wuek/eor6+zD8HA$wLfSVLz6YMg2MgyIPQV1YXaxn/0bCfpGhTGXjPoYucg";

    let parsed = PasswordHash::new(hash_str).expect("invalid hash");
    let result = Argon2::default()
        .verify_password(password.as_bytes(), &parsed);

    match result {
        Ok(_) => println!("Password matches!"),
        Err(e) => println!("Password verification failed: {}", e),
    }
}
