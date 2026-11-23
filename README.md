# Calorie Tracker

A calorie-tracking application in development, using FastAPI, React with
TypeScript, and PostgreSQL. Text-based AI food logging is planned.

## Local development

Requires Python 3.12, Node.js 24, and Docker with Docker Compose.
Run these commands from the repository root.

For a fresh clone, copy `.env.example` to `.env` and replace its password
placeholder with a private local password before starting PostgreSQL.
An existing installation should keep its working `.env` and database password.
For local development, only `CALORIE_DB_PASSWORD` is required; the other local
settings have defaults. `.env.example` documents optional configuration.

```bash
python3 -m venv backend/.venv
source backend/.venv/bin/activate
python -m pip install --only-binary :all: --require-hashes -r backend/requirements-ci.lock
npm --prefix frontend ci --ignore-scripts

docker compose up -d --wait --wait-timeout 60 db
python -m alembic -c backend/alembic.ini upgrade head
python -m alembic -c backend/alembic.ini check
```

Start the API in the activated backend environment:

```bash
python -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8001 --reload
```

In a second terminal, run:

```bash
npm --prefix frontend run dev
```

Open http://127.0.0.1:5174 for the frontend and
http://127.0.0.1:8001/docs for the API documentation.

## Database changes

Alembic uses the application's database by default and the direct connection
when `DATABASE_URL_UNPOOLED` is set. The initial
migration creates `users` with a unique, case-sensitive username, a password
hash field, and a creation timestamp. A second migration adds revocable login
sessions in the same PostgreSQL database. The third migration adds one profile
per account, including activity information and weight goals. Existing accounts
can continue signing in before creating a profile.

After editing the SQLAlchemy models, generate and review a migration:

```bash
python -m alembic -c backend/alembic.ini revision --autogenerate -m "describe schema change"
```

Apply committed migrations with `upgrade head`, then run `check` to detect
differences between the database schema and the application models.

## Neon PostgreSQL

Local Docker remains the default. With `DATABASE_URL` blank or unset, the API
uses the existing `CALORIE_DB_*` settings. With a non-empty `DATABASE_URL`, that
URL takes precedence and a local database password is not required by the API.
Docker Compose still uses `CALORIE_DB_PASSWORD` when starting the local service.

### Configure your Neon project

1. Create a project on Neon's Free plan, using PostgreSQL 17 to match Docker.
   Choose a region near your intended application host.
2. Open **Connect** for the project and select the branch, compute, database,
   and role that the application should use.
3. Turn **Connection pooling off** and copy the direct connection string into
   `DATABASE_URL` in your root `.env` file.
4. Leave `DATABASE_URL_UNPOOLED` unset or blank. This single direct URL is used
   by both the application and Alembic. Its hostname has no `-pooler` suffix.

Keep your existing local settings in `.env`. Add your actual copied Neon URL:

```dotenv
# Example only: replace this with your own copied direct connection string.
DATABASE_URL='postgresql://ROLE:PASSWORD@ep-YOUR-ENDPOINT.REGION.aws.neon.tech/neondb?sslmode=require&channel_binding=require'
```

Use the actual database name and hostname from Neon. Keep the password's URL
escaping exactly as copied. `postgres://`, `postgresql://`, and
`postgresql+psycopg://` prefixes are accepted; the app uses the installed
psycopg 3 driver. These values belong only in server configuration; `.env` is
ignored by Git. The committed `.env.example` contains blank URL fields.

### Apply the existing migrations

From the repository root, with the Neon values saved in `.env`:

```bash
source backend/.venv/bin/activate
python -m alembic -c backend/alembic.ini current
python -m alembic -c backend/alembic.ini upgrade head
python -m alembic -c backend/alembic.ini check
python -m alembic -c backend/alembic.ini current
```

The final command should show `0003_user_profiles (head)`. Alembic creates the
existing users, login sessions, and profile tables in Neon. Existing Docker
records require a separate data import; schema migrations do not copy them.
You can register a fresh account when testing the Neon-backed application.

Alembic uses a direct engine with no persistent client connection pool. If you
later choose a pooled application URL, set `DATABASE_URL` to that pooled URL and
`DATABASE_URL_UNPOOLED` to the direct URL for the same endpoint and database.
This two-URL setup is optional. A supplied migration URL must target the same
endpoint, database, and port; its role may differ from the application role.

Restart the API after changing database settings, then run the frontend as
usual. `GET /api/ready` should return `{"status":"ready","database":"connected"}`.
Sign up, save an onboarding profile, and refresh to check persistence.

### SSL and connection behavior

All non-loopback database connections use `sslmode=verify-full`, verifying both
the certificate chain and the server hostname. A copied `sslmode=require` or
`verify-ca` is strengthened automatically. Other URL parameters, including
`channel_binding=require`, are preserved. Settings that disable SSL or permit
an unencrypted fallback are rejected for remote hosts.

The application supplies the CA bundle discovered by Python's system SSL
configuration. If no bundle is available, install the operating system's CA
certificates or provide a trusted `sslrootcert=/path/to/ca-bundle.pem` in the
URL. An explicitly provided `sslrootcert` is preserved. Certificate failures
should be fixed by correcting the trust store or hostname.

Connection timeouts default to three seconds for loopback and ten seconds for
remote databases; a URL's explicit `connect_timeout` is preserved. The existing
connection health check remains enabled. Automatic psycopg prepared statements
are disabled on Neon pooled connections, avoiding reliance on pooler settings.

### Return to Docker development

Clear both URL values in `.env` while keeping your working `CALORIE_DB_*` values:

```dotenv
DATABASE_URL=
DATABASE_URL_UNPOOLED=
```

If you previously exported either URL in your shell, clear those exports too:

```bash
unset DATABASE_URL DATABASE_URL_UNPOOLED
docker compose up -d --wait --wait-timeout 60 db
python -m alembic -c backend/alembic.ini upgrade head
```

Restart the API to use Docker again. Shell environment variables take precedence
over `.env`. Run the automated database tests with your local Docker settings;
CI continues to use its PostgreSQL service and needs no Neon credentials.

Connection details: [Neon pooling](https://neon.com/docs/connect/connection-pooling),
[Neon SSL](https://neon.com/docs/connect/connect-securely), and
[PostgreSQL SSL verification](https://www.postgresql.org/docs/17/libpq-ssl.html).

## Accounts and appearance

The frontend includes registration, login, session restoration, and logout.
Usernames use 3–64 ASCII letters or numbers and are case-sensitive. Passwords
use 8–128 characters; spaces and symbols are accepted. Passwords are hashed
with Argon2id. Registration also signs the new user in.

Login sessions last up to seven days and are carried in an HttpOnly cookie.
Only a hash of each random session token is stored in PostgreSQL. Logout
revokes the current session on the server. Expired sessions for an account are
removed when that account signs in again.

Account mutations require `X-CSRF-Protection: 1` and reject untrusted browser
origins. The frontend sends this header automatically. In the API documentation,
enter `1` in that header field when trying account POST endpoints.

Local defaults allow the frontend on port 5174 and API documentation on port
8001, using either `127.0.0.1` or `localhost`. Render's `RENDER_EXTERNAL_URL`
automatically selects the trusted origin and enables Secure cookies. For a
custom domain, set `APP_ORIGIN` to its HTTPS origin. The optional existing
`CALORIE_ALLOWED_ORIGINS` and `CALORIE_COOKIE_SECURE` overrides remain supported;
an HTTPS origin cannot disable Secure cookies. Keep the API behind the
frontend's `/api` path.
Authentication currently allows ten attempts per client per minute, per server
process. Multiple server workers or instances will need a shared rate limiter.

The interface uses hot pink `#FF69B4`, white `#FCFFFF`, and charcoal `#3C4142`.
The theme button swaps the background and text colors; pink remains the accent.
The browser remembers the selected theme. Only this appearance preference is
stored in localStorage.

## Profiles and weight goals

The profile API uses the existing login cookie. Each account can read and replace
only its own profile; the server takes the account ID from the session. Profile
responses use `Cache-Control: no-store`.

| Endpoint | Behavior |
| --- | --- |
| `GET /api/profile` | Returns the current profile, or `404` if none has been saved. |
| `PUT /api/profile` | Creates a profile (`201`) or replaces it (`200`). |

`PUT` requires `X-CSRF-Protection: 1` and a trusted origin when an Origin header
is present. In `/docs`, sign in through the account endpoint first and enter `1`
in the profile endpoint's CSRF header field. Use the same hostname as the frontend
when reusing a browser login cookie.

Send the complete profile on every `PUT`. Partial updates and unknown body fields
(including `user_id`) are rejected. Height uses centimetres and weights use
kilograms. This first version accepts adult profiles, with age 18–120. Supported
goals are `gain`, `lose`, and `maintain`; gender values are `female`, `male`,
`other`, and `prefer_not_to_say`.

A maintenance profile looks like this:

```json
{
  "goal": "maintain",
  "age": 30,
  "height_cm": 175.5,
  "current_weight_kg": 75,
  "gender": "female",
  "activity_description": "Gym twice a week and regular walks.",
  "gym_sessions_per_week": 2,
  "steps_per_day": 6000
}
```

For `gain` or `lose`, also supply `target_weight_kg` and `target_date` in
`YYYY-MM-DD` format. The target must be above or below the current weight to match
the goal, and the date must be later than today's UTC date when saving. For
`maintain`, omit both target fields or send `null`; replacing a weight-change
profile this way clears its previous target and deadline. Saved profiles remain
readable after their deadlines pass.

Activity descriptions are trimmed and must contain 1–2,000 characters. Input
limits are 50–300 cm for height, 20–500 kg for weights, 0–21 gym sessions per
week, and 0–100,000 steps per day. Age, gym frequency, and steps must be whole
numbers. These bounds check input shape; calorie targets and whether a goal's
timeline is realistic will be calculated in a later feature.

After signing in, new accounts see a responsive onboarding wizard: goal, body
and weekly activity details, then target weight and date. Maintenance goals use
only the first two steps. Inline checks match the API's input limits, and the
wizard keeps entered values when moving back and forth. A failed save preserves
the draft so it can be corrected or retried.

Successful saves show a profile summary. Returning users load their saved
profile from the API and can choose **Edit profile** to change it; **Cancel**
discards those edits. Unsaved drafts stay in memory and are discarded on reload
or logout. Profile data is not stored in localStorage. An expired login session
returns the user to the login form.

The wizard supports keyboard controls and the existing light/dark theme. On
phone screens, goal cards stack and fields resize to the available width. AI
calorie calculations and timeline-feasibility checks are later features.

## Checks

Start PostgreSQL and apply migrations before running backend tests.
Database tests use temporary test rows and roll back their transactions.

```bash
python -m pytest --cov --cov-config=pyproject.toml --cov-report=term-missing --cov-report=xml:backend/coverage.xml --cov-report=json:backend/coverage.json
npm --prefix frontend run lint
npm --prefix frontend run build
npm --prefix frontend run test:coverage
python scripts/check_coverage.py
```

CI runs these checks and imports coverage into SonarQube Cloud. The local
coverage script enforces at least 80% combined backend/frontend line and branch coverage.
Migration files are outside application coverage and remain available for
static analysis.

## Render deployment and CD

The root `Dockerfile` builds React and packages its output with FastAPI in one
image. `backend/start.sh` applies Alembic migrations and starts the production
entry point on `0.0.0.0:$PORT` (default `10000`). One Uvicorn worker runs as a
non-root user. Frontend HTML is revalidated so a new deploy can load its current
bundled assets. Local Vite development still uses ports 5174 and 8001.

### Create the Render service once

1. Apply this change on your feature branch and open a pull request. Wait for
   the checks, merge into `main`, and wait for the `main` CI run to pass.
2. Open Render in the GitHub-connected account used for Budget Assistant.
   Choose **New → Blueprint** and connect the `calorie-tracker` repository.
   Use its `main` branch and root `render.yaml` file.
3. Review the proposed **Free** Docker web service in **Frankfurt**.
4. When prompted for `DATABASE_URL`, enter the **direct** Neon connection URL
   from the calorie-tracker project. This is the only manually required secret.
   The same URL is used by the app and startup migrations. The private local
   `.env` is excluded from the Docker build.
5. Create the Blueprint and wait for the initial deployment. Open the assigned
   HTTPS `onrender.com` address, register an account, save a profile, and reload.

The Blueprint sets `autoDeployTrigger: checksPass`. Confirm **Auto-Deploy →
After CI Checks Pass** in the service settings. Future changes on `main` are
automatically rebuilt and deployed after their GitHub checks pass. Connect the
GitHub repository through Render's integration so Render can see those checks.
The initial creation is performed after the commit's checks have already passed.

CI builds the deployment image and starts it against the CI PostgreSQL service,
then checks the React index, linked JS/CSS assets, API health, and database
readiness. This is part of the same required CI job, alongside tests, the
line-and-branch coverage gate, and the configured SonarQube quality gate.

### Health and cold starts

| Endpoint | Purpose |
| --- | --- |
| `/api/health` | Render's frequent liveness probe; performs no database query. |
| `/api/ready` | Explicitly checks database connectivity; use during verification. |

Startup migrations check the database before the HTTP server starts. A
frequent Render liveness probe does not continually wake the Neon database.

Render Free services can sleep while idle. The browser allows up to 90 seconds
per API operation and shows a waiting notice after five seconds. GET requests
retry up to twice after transient server/network errors or a temporary HTML
waking page, within that overall time limit. Login, registration, logout, and
profile saves are never automatically repeated. Existing retry controls remain
available after failure. Leaving the page or signing out cancels pending
profile reads and saves.

### Optional local production check

With a working Neon `DATABASE_URL` in your private root `.env`:

```bash
docker build --tag calorie-tracker:local .
docker run --rm --env-file .env \
  --env APP_ORIGIN=http://127.0.0.1:10000 \
  --publish 127.0.0.1:10000:10000 calorie-tracker:local
```

In another terminal, from the repository root:

```bash
python scripts/check_deployment.py http://127.0.0.1:10000
```

This local container uses the Neon URL. The existing Compose service remains
available for the normal local development workflow.

References: [Render deployments](https://render.com/docs/deploys),
[Blueprints](https://render.com/docs/blueprint-spec),
[health checks](https://render.com/docs/health-checks), and
[free service behavior](https://render.com/docs/free).
