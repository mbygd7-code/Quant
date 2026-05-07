"""Admin user management — invite + role change."""
from __future__ import annotations

import os
import secrets
import string
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, EmailStr, Field

import db.supabase_client as _sb_client

router = APIRouter(prefix="/api/users", tags=["users"])


def _admin():
    return _sb_client.get_admin_client()


def _generate_invite_code(length: int = 12) -> str:
    alphabet = string.ascii_uppercase + string.digits
    return ''.join(secrets.choice(alphabet) for _ in range(length))


class InviteRequest(BaseModel):
    email: EmailStr
    role:  str = Field(default="beta", pattern=r"^(admin|beta|user)$")


@router.post("/invite")
async def invite_user(req: InviteRequest) -> dict[str, Any]:
    sb = _admin()
    code = _generate_invite_code()
    expires_at = (datetime.now(UTC) + timedelta(days=7)).isoformat()

    sb.table("invite_codes").insert({
        "code":       code,
        "email":      req.email,
        "role":       req.role,
        "expires_at": expires_at,
    }).execute()

    # Best-effort: send Supabase Auth invite email so the user lands in /invite/{code}
    site_url = os.environ.get("NEXT_PUBLIC_APP_URL") or "http://localhost:3000"
    redirect_to = f"{site_url}/invite/{code}"
    try:
        sb.auth.admin.invite_user_by_email(
            req.email, options={"redirect_to": redirect_to},
        )
        email_sent = True
    except Exception as exc:
        # invite_codes is the source of truth; admin can copy/share the link manually.
        email_sent = False
        return {
            "ok":         True,
            "code":       code,
            "expires_at": expires_at,
            "invite_url": redirect_to,
            "email_sent": email_sent,
            "warning":    f"email send failed: {exc}",
        }
    return {
        "ok":         True,
        "code":       code,
        "expires_at": expires_at,
        "invite_url": redirect_to,
        "email_sent": email_sent,
    }


class RoleUpdate(BaseModel):
    role: str = Field(..., pattern=r"^(admin|beta|user)$")


@router.patch("/{user_id}/role")
async def update_role(user_id: str, body: RoleUpdate) -> dict[str, Any]:
    sb = _admin()

    rows = sb.table("profiles").select("*").eq("id", user_id).limit(1).execute().data
    if not rows:
        raise HTTPException(404, f"user {user_id} not found")
    before = rows[0]

    sb.table("profiles").update({"role": body.role}).eq("id", user_id).execute()

    sb.table("audit_logs").insert({
        "action":        "user.role_change",
        "resource_type": "profiles",
        "resource_id":   user_id,
        "changes":       {"before": {"role": before["role"]}, "after": {"role": body.role}},
    }).execute()
    return {"ok": True, "user_id": user_id, "role": body.role}


@router.post("/{user_id}/disconnect-telegram")
async def disconnect_telegram(user_id: str) -> dict[str, Any]:
    sb = _admin()
    sb.table("profiles").update({
        "telegram_chat_id":     None,
        "telegram_link_code":   None,
        "link_code_expires_at": None,
    }).eq("id", user_id).execute()
    sb.table("audit_logs").insert({
        "action":        "user.disconnect_telegram",
        "resource_type": "profiles",
        "resource_id":   user_id,
    }).execute()
    return {"ok": True}


@router.delete("/{user_id}")
async def delete_user(user_id: str) -> dict[str, Any]:
    """Hard delete: cascade removes profile, watchlists, paper_trades, etc."""
    sb = _admin()
    rows = sb.table("profiles").select("email, role").eq("id", user_id).limit(1).execute().data
    if not rows:
        raise HTTPException(404, f"user {user_id} not found")

    try:
        sb.auth.admin.delete_user(user_id)
    except Exception as exc:
        raise HTTPException(500, f"auth delete failed: {exc}")

    sb.table("audit_logs").insert({
        "action":        "user.delete",
        "resource_type": "profiles",
        "resource_id":   user_id,
        "changes":       {"before": rows[0]},
    }).execute()
    return {"ok": True, "user_id": user_id}


@router.get("/list")
async def list_users() -> list[dict[str, Any]]:
    sb = _admin()
    rows = (
        sb.table("profiles")
          .select("id, email, display_name, role, telegram_chat_id, "
                  "notification_enabled, created_at, updated_at")
          .order("created_at", desc=True)
          .execute()
          .data
    ) or []
    return rows


@router.get("/stats")
async def user_stats() -> dict[str, Any]:
    sb = _admin()
    rows = sb.table("profiles").select("role, created_at").execute().data or []
    by_role: dict[str, int] = {}
    for r in rows:
        by_role[r["role"]] = by_role.get(r["role"], 0) + 1

    seven_days_ago = (datetime.now(UTC) - timedelta(days=7)).isoformat()
    recent = sum(1 for r in rows if r["created_at"] >= seven_days_ago)

    return {"total": len(rows), "by_role": by_role, "recent_7d": recent}
