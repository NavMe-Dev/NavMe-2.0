"""Admin auth: bcrypt password hashes + HS256 JWT bearer tokens. Admin users are created via the CLI."""
from datetime import datetime, timedelta, timezone
import bcrypt, jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session
from .config import get_settings
from .db import get_db
from . import models

oauth2 = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login", auto_error=False)


def hash_password(pw: str) -> str:
    return bcrypt.hashpw(pw.encode(), bcrypt.gensalt()).decode()


def verify_password(pw: str, h: str) -> bool:
    try:
        return bcrypt.checkpw(pw.encode(), h.encode())
    except Exception:
        return False


def create_token(email: str) -> str:
    s = get_settings()
    exp = datetime.now(timezone.utc) + timedelta(minutes=s.jwt_expire_minutes)
    return jwt.encode({"sub": email, "exp": exp, "role": "admin"}, s.jwt_secret, algorithm="HS256")


def current_admin(token: str | None = Depends(oauth2), db: Session = Depends(get_db)) -> models.User:
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "not authenticated", headers={"WWW-Authenticate": "Bearer"})
    try:
        p = jwt.decode(token, get_settings().jwt_secret, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid or expired token", headers={"WWW-Authenticate": "Bearer"})
    u = db.query(models.User).filter_by(email=p.get("sub")).first()
    if not u or not u.is_admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "admin required")
    return u
