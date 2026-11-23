import secrets
from types import SimpleNamespace

import pytest
from sqlalchemy import URL

from app import database_settings as settings

DIRECT_HOST = "ep-config-check.eu-central-1.aws.neon.tech"
POOLED_HOST = "ep-config-check-pooler.eu-central-1.aws.neon.tech"


@pytest.fixture(autouse=True)
def system_ca_bundle(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        settings.ssl, "get_default_verify_paths",
        lambda: SimpleNamespace(cafile="/etc/ssl/certs/ca-certificates.crt"),
    )


def cloud_url(host: str = POOLED_HOST, **query: str) -> str:
    return URL.create(
        "postgresql", username="neon_user", password=secrets.token_urlsafe(24),
        host=host, database="neondb", query=query,
    ).render_as_string(hide_password=False)


def test_local_defaults_do_not_require_neon_or_ssl() -> None:
    password = secrets.token_urlsafe(24)
    url = settings.load_database_url({"CALORIE_DB_PASSWORD": password})
    assert url.drivername == "postgresql+psycopg"
    assert url.username == "calorie_app" and url.password == password
    assert url.host == "127.0.0.1" and url.port == 5433
    assert url.database == "calorie_tracker" and not url.query
    assert settings.database_connect_args(url) == {"connect_timeout": 3}
    assert settings.get_migration_database_url({}, url) is url


def test_local_settings_and_password_special_characters_are_preserved() -> None:
    password = secrets.token_urlsafe(24) + "@:/%?#"
    url = settings.load_database_url({
        "DATABASE_URL": "  ", "CALORIE_DB_HOST": "localhost", "CALORIE_DB_PORT": "5432",
        "CALORIE_DB_NAME": "local_custom", "CALORIE_DB_USER": "custom_user",
        "CALORIE_DB_PASSWORD": password,
    })
    assert url.host == "localhost" and url.port == 5432
    assert url.database == "local_custom" and url.username == "custom_user"
    assert url.password == password and not url.query


def test_neon_url_takes_precedence_without_a_local_password() -> None:
    url = settings.load_database_url({
        "DATABASE_URL": cloud_url(), "CALORIE_DB_PORT": "unused-invalid-value",
    })
    assert url.host == POOLED_HOST and url.database == "neondb"
    assert url.query["sslmode"] == "verify-full"
    assert url.query["sslrootcert"] == "/etc/ssl/certs/ca-certificates.crt"
    assert settings.database_connect_args(url) == {"connect_timeout": 10, "prepare_threshold": None}


@pytest.mark.parametrize("scheme", ["postgres", "postgresql", "postgresql+psycopg"])
def test_supported_schemes_and_url_escaping(scheme: str) -> None:
    password = secrets.token_urlsafe(24) + "@:/%?#"
    original = URL.create(
        scheme, username="neon_user", password=password, host=DIRECT_HOST,
        database="neondb", query={"channel_binding": "require"},
    ).render_as_string(hide_password=False)
    url = settings.load_database_url({"DATABASE_URL": original})
    assert url.drivername == "postgresql+psycopg"
    assert url.password == password
    assert url.query["channel_binding"] == "require"


@pytest.mark.parametrize("mode", [None, "require", "verify-ca", "verify-full"])
def test_remote_connections_always_verify_the_certificate_and_hostname(mode: str | None) -> None:
    query = {"sslmode": mode} if mode else {}
    url = settings.load_database_url({"DATABASE_URL": cloud_url(**query)})
    assert url.query["sslmode"] == "verify-full"
    assert url.query["sslrootcert"]


@pytest.mark.parametrize("mode", ["disable", "allow", "prefer", "unknown"])
def test_remote_ssl_downgrades_are_rejected(mode: str) -> None:
    with pytest.raises(ValueError, match="SSL certificate verification"):
        settings.load_database_url({"DATABASE_URL": cloud_url(sslmode=mode)})


def test_explicit_ca_bundle_does_not_require_a_system_bundle(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings.ssl, "get_default_verify_paths", lambda: SimpleNamespace(cafile=None))
    url = settings.load_database_url({
        "DATABASE_URL": cloud_url(sslrootcert="/private/custom-ca.pem", channel_binding="require"),
    })
    assert url.query["sslrootcert"] == "/private/custom-ca.pem"
    assert url.query["channel_binding"] == "require"


def test_missing_ca_bundle_fails_without_disabling_verification(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings.ssl, "get_default_verify_paths", lambda: SimpleNamespace(cafile=None))
    with pytest.raises(ValueError, match="No system CA bundle"):
        settings.load_database_url({"DATABASE_URL": cloud_url()})


@pytest.mark.parametrize("host", ["localhost", "127.0.0.1", "::1"])
def test_loopback_urls_keep_local_connection_options(host: str) -> None:
    url = settings.load_database_url({"DATABASE_URL": cloud_url(host)})
    assert not url.query
    assert settings.database_connect_args(url) == {"connect_timeout": 3}


def test_missing_local_password_has_an_actionable_error() -> None:
    with pytest.raises(ValueError, match="CALORIE_DB_PASSWORD"):
        settings.load_database_url({})


@pytest.mark.parametrize("port", ["not-a-port", "0", "65536"])
def test_invalid_local_ports_are_rejected(port: str) -> None:
    with pytest.raises(ValueError, match="CALORIE_DB_PORT"):
        settings.load_database_url({"CALORIE_DB_PASSWORD": secrets.token_urlsafe(24), "CALORIE_DB_PORT": port})


@pytest.mark.parametrize("value", [
    "not-a-url", "sqlite:///local.db", "postgresql+psycopg2://user@host/db",
    "postgresql://user@/db", "postgresql://host/db", "postgresql://user@host/",
    "postgresql://user@host:not-a-port/db", "postgresql://user@host:65536/db",
])
def test_invalid_urls_have_safe_configuration_errors(value: str) -> None:
    with pytest.raises(ValueError, match="DATABASE_URL must be a PostgreSQL URL") as error:
        settings.load_database_url({"DATABASE_URL": value})
    assert value not in str(error.value)


def test_invalid_urls_never_echo_the_password() -> None:
    secret = secrets.token_urlsafe(24)
    value = f"postgresql://user:{secret}@host:invalid/db"
    with pytest.raises(ValueError) as error:
        settings.load_database_url({"DATABASE_URL": value})
    assert secret not in str(error.value)
    assert error.value.__suppress_context__


def test_remote_calorie_settings_also_require_verified_ssl() -> None:
    url = settings.load_database_url({"CALORIE_DB_HOST": DIRECT_HOST, "CALORIE_DB_PASSWORD": secrets.token_urlsafe(24)})
    assert url.query["sslmode"] == "verify-full"


def test_direct_application_urls_also_work_for_migrations() -> None:
    url = settings.load_database_url({"DATABASE_URL": cloud_url(DIRECT_HOST)})
    assert settings.get_migration_database_url({"DATABASE_URL_UNPOOLED": " "}, url) is url
    assert settings.database_connect_args(url) == {"connect_timeout": 10}


def test_neon_migrations_use_a_separate_direct_url() -> None:
    application = settings.load_database_url({"DATABASE_URL": cloud_url()})
    direct = settings.get_migration_database_url({"DATABASE_URL_UNPOOLED": cloud_url(DIRECT_HOST)}, application)
    assert direct.host == DIRECT_HOST
    assert direct.query["sslmode"] == "verify-full"
    assert not settings.is_neon_pooled(direct)
    assert settings.database_connect_args(direct) == {"connect_timeout": 10}


def test_pooled_neon_migrations_require_the_direct_url() -> None:
    application = settings.load_database_url({"DATABASE_URL": cloud_url()})
    with pytest.raises(ValueError, match="Set DATABASE_URL_UNPOOLED"):
        settings.get_migration_database_url({}, application)
    with pytest.raises(ValueError, match="without -pooler"):
        settings.get_migration_database_url({"DATABASE_URL_UNPOOLED": cloud_url()}, application)


@pytest.mark.parametrize("change", [
    {"host": "ep-different.eu-central-1.aws.neon.tech"},
    {"database": "different_db"}, {"port": 5433},
])
def test_migrations_cannot_target_a_different_endpoint_or_database(change: dict[str, object]) -> None:
    application = settings.load_database_url({"DATABASE_URL": cloud_url()})
    direct = URL.create(
        "postgresql", username="migration_user", password=secrets.token_urlsafe(24),
        host=DIRECT_HOST, database="neondb",
    ).set(**change).render_as_string(hide_password=False)
    with pytest.raises(ValueError, match="same endpoint and database"):
        settings.get_migration_database_url({"DATABASE_URL_UNPOOLED": direct}, application)


def test_migrations_may_use_a_different_role_and_explicit_default_port() -> None:
    application = settings.load_database_url({"DATABASE_URL": cloud_url()})
    direct = URL.create(
        "postgresql", username="migration_user", password=secrets.token_urlsafe(24),
        host=DIRECT_HOST, port=5432, database="neondb",
    ).render_as_string(hide_password=False)
    url = settings.get_migration_database_url({"DATABASE_URL_UNPOOLED": direct}, application)
    assert url.username == "migration_user" and url.port == 5432


def test_invalid_migration_url_names_the_correct_setting() -> None:
    application = settings.load_database_url({"DATABASE_URL": cloud_url()})
    with pytest.raises(ValueError, match="DATABASE_URL_UNPOOLED must be a PostgreSQL URL"):
        settings.get_migration_database_url({"DATABASE_URL_UNPOOLED": "bad-url"}, application)


def test_explicit_connection_timeouts_are_preserved() -> None:
    url = settings.load_database_url({"DATABASE_URL": cloud_url(connect_timeout="30")})
    assert url.query["connect_timeout"] == "30"
    assert settings.database_connect_args(url) == {"prepare_threshold": None}
