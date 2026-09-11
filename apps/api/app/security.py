import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone

import pyotp
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

from .config import get_settings


password_hasher = PasswordHasher()


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def digest(value: str) -> str:
    settings = get_settings()
    return hmac.new(settings.app_secret.encode(), value.encode(), hashlib.sha256).hexdigest()


def new_token() -> str:
    return secrets.token_urlsafe(32)


def hash_password(password: str) -> str:
    return password_hasher.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    try:
        return password_hasher.verify(password_hash, password)
    except VerifyMismatchError:
        return False


def verify_otp(secret: str | None, otp: str | None) -> bool:
    if not secret:
        return True
    return bool(otp and pyotp.TOTP(secret).verify(otp, valid_window=1))


def expires_in(seconds: int) -> datetime:
    return utcnow() + timedelta(seconds=seconds)

