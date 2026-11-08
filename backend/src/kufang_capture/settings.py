from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="CAPTURE_", env_file=None, extra="ignore")

    data_dir: Path = Path("./data")
    static_dir: Path = Path("../frontend/dist")
    public_origin: str = "http://127.0.0.1:5173"
    password_hash: str | None = None
    session_secret: str | None = None
    dev_password: str | None = None
    min_free_bytes: int = 4 * 1024**3
    max_photo_bytes: int = 50 * 1024**2
    app_version: str = "dev"


@lru_cache
def get_settings() -> Settings:
    return Settings()
