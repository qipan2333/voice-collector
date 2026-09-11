from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_env: str = "development"
    app_secret: str = "change-me"
    database_url: str = "sqlite:///./voice_collector.db"
    media_root: Path = Path("./data/recordings")
    public_base_url: str = "http://localhost:5173"
    max_upload_bytes: int = 50 * 1024 * 1024
    max_recording_seconds: int = 480
    expected_recording_seconds: int = 180
    admin_username: str = "researcher"
    admin_password: str = "change-me"
    admin_totp_secret: str = ""
    participant_session_seconds: int = 2 * 60 * 60
    admin_session_seconds: int = 8 * 60 * 60
    mimo_api_key: str = ""
    mimo_base_url: str = "https://api.xiaomimimo.com/v1"
    mimo_asr_model: str = "mimo-v2.5-asr"
    mimo_asr_rpm_limit: int = 90
    mimo_asr_participant_interval_seconds: float = 7.5
    mimo_required_consent_version: str = "consent-v2-mimo-asr"
    mimo_asr_timeout_seconds: float = 20.0

    model_config = SettingsConfigDict(env_file=".env", extra="ignore", case_sensitive=False)


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    settings.media_root.mkdir(parents=True, exist_ok=True)
    (settings.media_root / "incoming").mkdir(parents=True, exist_ok=True)
    (settings.media_root / "original").mkdir(parents=True, exist_ok=True)
    (settings.media_root / "normalized").mkdir(parents=True, exist_ok=True)
    return settings
