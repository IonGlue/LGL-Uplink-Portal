use chrono::Utc;
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AppError, Result};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DeviceClaims {
    pub sub: Uuid,
    pub device_id: String,
    #[serde(rename = "type")]
    pub token_type: String,
    pub exp: i64,
    pub iat: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UserClaims {
    pub sub: Uuid,
    pub org_id: Uuid,
    pub role: String,
    #[serde(rename = "type")]
    pub token_type: String,
    pub exp: i64,
    pub iat: i64,
}

pub fn generate_device_token(
    device_uuid: Uuid,
    device_id: &str,
    secret: &str,
    ttl_secs: u64,
) -> Result<String> {
    let now = Utc::now().timestamp();
    let claims = DeviceClaims {
        sub: device_uuid,
        device_id: device_id.to_string(),
        token_type: "device".to_string(),
        exp: now + ttl_secs as i64,
        iat: now,
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| AppError::Internal(anyhow::anyhow!("JWT encode error: {e}")))
}

pub fn generate_user_token(
    user_id: Uuid,
    org_id: Uuid,
    role: &str,
    secret: &str,
    ttl_secs: u64,
) -> Result<String> {
    let now = Utc::now().timestamp();
    let claims = UserClaims {
        sub: user_id,
        org_id,
        role: role.to_string(),
        token_type: "user".to_string(),
        exp: now + ttl_secs as i64,
        iat: now,
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| AppError::Internal(anyhow::anyhow!("JWT encode error: {e}")))
}

pub fn validate_user_token(token: &str, secret: &str) -> Result<UserClaims> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.validate_exp = true;

    let data = decode::<UserClaims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .map_err(|_| AppError::Unauthorized)?;

    if data.claims.token_type != "user" {
        return Err(AppError::Unauthorized);
    }

    Ok(data.claims)
}

pub fn validate_device_token(token: &str, secret: &str) -> Result<DeviceClaims> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.validate_exp = true;

    let data = decode::<DeviceClaims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .map_err(|_| AppError::Unauthorized)?;

    if data.claims.token_type != "device" {
        return Err(AppError::Unauthorized);
    }

    Ok(data.claims)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_device_token_roundtrip() {
        let device_uuid = Uuid::new_v4();
        let device_id = "abc123def456";
        let secret = "test-secret";
        let token = generate_device_token(device_uuid, device_id, secret, 3600).unwrap();
        let claims = validate_device_token(&token, secret).unwrap();
        assert_eq!(claims.sub, device_uuid);
        assert_eq!(claims.device_id, device_id);
        assert_eq!(claims.token_type, "device");
    }

    #[test]
    fn test_user_token_roundtrip() {
        let user_id = Uuid::new_v4();
        let org_id = Uuid::new_v4();
        let secret = "test-secret";
        let token = generate_user_token(user_id, org_id, "admin", secret, 3600).unwrap();
        let claims = validate_user_token(&token, secret).unwrap();
        assert_eq!(claims.sub, user_id);
        assert_eq!(claims.org_id, org_id);
        assert_eq!(claims.role, "admin");
    }

    #[test]
    fn test_wrong_token_type_rejected() {
        let device_uuid = Uuid::new_v4();
        let secret = "test-secret";
        let token = generate_device_token(device_uuid, "id", secret, 3600).unwrap();
        // Device token should not validate as user token
        assert!(validate_user_token(&token, secret).is_err());
    }
}
