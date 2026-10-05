from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session
from ..db import get_db
from ..auth import verify_password, create_token, current_admin
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
