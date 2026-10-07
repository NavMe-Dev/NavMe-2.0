from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel, EmailStr
from sqlalchemy.orm import Session
from ..db import get_db
from ..auth import verify_password, hash_password, create_token, current_admin
from ..config import get_settings
from .. import models, schemas

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])


@router.post("/login", response_model=schemas.Token)
def login(form: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    u = db.query(models.User).filter_by(email=form.username.lower().strip()).first()
    if not u or not verify_password(form.password, u.password_hash):
        raise HTTPException(401, "wrong email or password")
    return {"access_token": create_token(u.email)}


@router.get("/me")
def me(u: models.User = Depends(current_admin)):
    return {"email": u.email, "is_admin": u.is_admin}


class _BootstrapIn(BaseModel):
    email: EmailStr
    password: str


@router.post("/bootstrap-admin")
def bootstrap_admin(body: _BootstrapIn, request: Request, db: Session = Depends(get_db)):
    """Create the very first admin user over HTTP — for hosts with no Shell access
    (e.g. Render's free plan). Gated by BOOTSTRAP_SECRET (sent as X-Bootstrap-Secret)
    and only works while the users table is empty, so it's useless to an attacker
    once the real admin exists. Equivalent to `wayfinding create-admin`."""
    cfg = get_settings()
    secret = getattr(cfg, "bootstrap_secret", "") or ""
    if not secret or request.headers.get("x-bootstrap-secret", "") != secret:
        raise HTTPException(403, "invalid or missing bootstrap secret")
    if db.query(models.User).count() > 0:
        raise HTTPException(409, "an admin user already exists — use the admin panel to manage users instead")
    u = models.User(email=body.email.lower().strip(), password_hash=hash_password(body.password), is_admin=True)
    db.add(u); db.commit()
    return {"created": u.email}
