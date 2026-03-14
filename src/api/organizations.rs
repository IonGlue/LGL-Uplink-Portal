use axum::{extract::State, Json};

use crate::{
    auth::middleware::AuthUser,
    error::{AppError, Result},
    models::organization::OrgWithCounts,
    AppState,
};

pub async fn get_org(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
) -> Result<Json<OrgWithCounts>> {
    let org = crate::models::organization::Organization::find_with_counts(claims.org_id, &state.db)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(Json(org))
}
