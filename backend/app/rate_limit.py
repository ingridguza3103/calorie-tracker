from threading import Lock
from time import monotonic

from fastapi import HTTPException, Request


class AuthRateLimiter:
    """Bounded, per-process protection for expensive authentication requests."""

    def __init__(self, limit: int = 10, window_seconds: int = 60) -> None:
        self.limit = limit
        self.window_seconds = window_seconds
        self._started = monotonic()
        self._attempts: dict[str, int] = {}
        self._lock = Lock()

    def check(self, key: str) -> None:
        with self._lock:
            now = monotonic()
            if now - self._started >= self.window_seconds:
                self._attempts.clear()
                self._started = now

            attempts = self._attempts.get(key, 0)
            if attempts >= self.limit or (
                key not in self._attempts and len(self._attempts) >= 10_000
            ):
                raise HTTPException(
                    status_code=429,
                    detail="Too many attempts. Please wait a minute and try again.",
                    headers={"Retry-After": str(self.window_seconds)},
                )
            self._attempts[key] = attempts + 1


auth_limiter = AuthRateLimiter()


def check_auth_rate_limit(request: Request) -> None:
    key = request.client.host if request.client else "unknown"
    auth_limiter.check(key)
