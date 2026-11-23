# Calorie Tracker

A calorie-tracking application in development, using FastAPI, React with
TypeScript, and PostgreSQL. Text-based AI food logging is planned.

## Local development

Requires Python 3.12, Node.js 24, and Docker with Docker Compose.
Run these commands from the repository root.

For a fresh clone, copy `.env.example` to `.env` and replace its password
placeholder with a private local password before starting PostgreSQL.
An existing installation should keep its working `.env` and database password.

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

Alembic uses the same connection settings as the application. The initial
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
8001, using either `127.0.0.1` or `localhost`. Before deployment, set
`CALORIE_ALLOWED_ORIGINS` to the exact trusted HTTPS origins and set
`CALORIE_COOKIE_SECURE=true`. Keep the API behind the frontend's `/api` path.
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

The onboarding form is the next implementation step. No profile form or AI
calorie calculations are included yet.

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
coverage script enforces at least 80% combined backend/frontend line coverage.
Migration files are outside application coverage and remain available for
static analysis.
