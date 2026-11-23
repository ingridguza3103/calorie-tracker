import ssl
from collections.abc import Mapping

from sqlalchemy import URL, make_url
from sqlalchemy.exc import ArgumentError

LOCAL_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})


def _hostname(url: URL) -> str:
    return (url.host or "").lower().rstrip(".")


def is_neon_pooled(url: URL) -> bool:
    host = _hostname(url)
    return host.endswith(".neon.tech") and host.split(".")[0].endswith("-pooler")


def _secure_remote_url(url: URL) -> URL:
    if _hostname(url) in LOCAL_HOSTS:
        return url

    mode = url.query.get("sslmode", "verify-full")
    if mode not in {"require", "verify-ca", "verify-full"}:
        raise ValueError("Remote PostgreSQL connections require SSL certificate verification.")

    query = dict(url.query)
    # Strengthen the Console's sslmode=require while preserving channel binding.
    query["sslmode"] = "verify-full"
    if not query.get("sslrootcert"):
        certificate_file = ssl.get_default_verify_paths().cafile
        if certificate_file is None:
            raise ValueError(
                "No system CA bundle was found. Install CA certificates or add "
                "sslrootcert=/path/to/ca-bundle.pem to your database URL."
            )
        query["sslrootcert"] = certificate_file
    return url.set(query=query)


def _parse_url(value: str, variable: str) -> URL:
    try:
        url = make_url(value)
        if (
            url.drivername not in {"postgres", "postgresql", "postgresql+psycopg"}
            or not url.host
            or not url.username
            or not url.database
            or (url.port is not None and not 1 <= url.port <= 65535)
        ):
            raise ValueError
    except (ArgumentError, ValueError):
        # Parser exceptions can contain the original URL, including its password.
        raise ValueError(
            f"{variable} must be a PostgreSQL URL with a host, user, database, and valid port."
        ) from None

    return _secure_remote_url(url.set(drivername="postgresql+psycopg"))


def load_database_url(values: Mapping[str, str]) -> URL:
    value = values.get("DATABASE_URL", "").strip()
    if value:
        return _parse_url(value, "DATABASE_URL")

    password = values.get("CALORIE_DB_PASSWORD")
    if not password:
        raise ValueError("Set CALORIE_DB_PASSWORD for local PostgreSQL, or set DATABASE_URL.")
    try:
        port = int(values.get("CALORIE_DB_PORT", "5433"))
        if not 1 <= port <= 65535:
            raise ValueError
    except ValueError:
        raise ValueError("CALORIE_DB_PORT must be a port number from 1 to 65535.") from None

    return _secure_remote_url(URL.create(
        drivername="postgresql+psycopg",
        username=values.get("CALORIE_DB_USER", "calorie_app"),
        password=password,
        host=values.get("CALORIE_DB_HOST", "127.0.0.1"),
        port=port,
        database=values.get("CALORIE_DB_NAME", "calorie_tracker"),
    ))


def get_migration_database_url(values: Mapping[str, str], application_url: URL) -> URL:
    value = values.get("DATABASE_URL_UNPOOLED", "").strip()
    if not value:
        if is_neon_pooled(application_url):
            raise ValueError("Set DATABASE_URL_UNPOOLED to Neon's direct URL before running migrations.")
        return application_url

    url = _parse_url(value, "DATABASE_URL_UNPOOLED")
    if is_neon_pooled(url):
        raise ValueError("DATABASE_URL_UNPOOLED must use the direct hostname, without -pooler.")
    application_host = _hostname(application_url)
    if is_neon_pooled(application_url):
        application_host = application_host.replace("-pooler.", ".", 1)
    if (
        _hostname(url) != application_host
        or url.database != application_url.database
        or (url.port or 5432) != (application_url.port or 5432)
    ):
        raise ValueError("DATABASE_URL_UNPOOLED must point to the same endpoint and database as DATABASE_URL.")
    return url


def database_connect_args(url: URL) -> dict[str, int | None]:
    args: dict[str, int | None] = {}
    if "connect_timeout" not in url.query:
        args["connect_timeout"] = 3 if _hostname(url) in LOCAL_HOSTS else 10
    if is_neon_pooled(url):
        # Avoid depending on the transaction pooler's prepared-statement settings.
        args["prepare_threshold"] = None
    return args
