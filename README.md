# Calorie Tracker

A calorie-tracking application in development, using FastAPI, React with
TypeScript, and PostgreSQL. It includes account profiles, calorie plans, and
text-based AI food nutrition estimates, and a daily diary with calorie progress.

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
A fourth migration adds one saved calorie and nutrient plan per profile.
A fifth stores food nutrition estimates with their serving and cooking notes.
A sixth adds dated diary entries, serving multipliers, and safe save retries.

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

The final command should show `0006_diary_entries (head)`. Alembic creates the
users, sessions, profiles, plans, food-estimate, and diary tables in Neon. Existing Docker
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
timeline fits the automatic planner's limits are checked when creating a plan.

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
phone screens, goal cards stack and fields resize to the available width.
After saving a profile, choose **Create my plan** to calculate and save targets.
Returning users load their existing plan without another Groq request.

## Groq maintenance estimates

Groq interprets the saved weekly activity description, gym frequency, and step
count. Python calculates estimated resting energy using the Mifflin-St Jeor
equation, then multiplies the unrounded result by a fixed activity factor and
rounds once to a whole kcal/day value. The response includes the model, activity
interpretation, assumptions, formula basis, profile timestamp, and estimate time.
Weight goals and deadlines do not influence maintenance calories.

### Configure Groq

1. Sign in to [Groq Console](https://console.groq.com) on the Free plan.
2. Create an API key at [API Keys](https://console.groq.com/keys).
3. Add the following to your existing private root `.env`, keeping the working
   database configuration. Replace the placeholder with your own Groq key:

```dotenv
GROQ_API_KEY=replace_with_your_private_groq_key
GROQ_MODEL=openai/gpt-oss-20b
GROQ_TIMEOUT_SECONDS=20
```

Only the key is required; the model and timeout above are built-in defaults.
The timeout accepts 5-60 seconds. A different model must support Groq's strict
`json_schema` structured-output mode; `openai/gpt-oss-120b` is another supported
choice. Check availability and your account's free quota before switching.
There is no automatic fallback to another model or paid plan.

Restart the local API after configuration changes. On Render, add
`GROQ_API_KEY` under the existing calorie-tracker service's **Environment** and
save/redeploy. Set `GROQ_MODEL` or `GROQ_TIMEOUT_SECONDS` there only if overriding
the defaults. Keep the direct Neon `DATABASE_URL` as it is. The frontend needs
no key or `VITE_` variable. `.env.example` need not change for this feature.

For maintenance, only activity description, gym frequency, and daily steps are
sent to Groq. Food estimation sends only its food description. Account identifiers,
cookies, passwords, age, height, weight, gender,
target weights, and deadlines are not sent. The raw provider response and error
body are not logged or returned by the application.

### Test the authenticated endpoint

`POST /api/maintenance/estimate` requires the existing login cookie,
`X-CSRF-Protection: 1`, and a saved profile. Send the empty JSON body `{}`.
The server reads the account from the session and rejects body overrides such
as `user_id`, `model`, or replacement profile fields. Responses are not cached.

1. Start the API and frontend as usual. Log in and finish onboarding.
2. Open http://127.0.0.1:8001/docs using the same hostname as the frontend.
   Browser cookies are shared across ports on the same host.
3. Expand **Maintenance → POST /api/maintenance/estimate**, choose **Try it out**,
   enter `1` for `X-CSRF-Protection`, leave the request body as `{}`, and execute.
4. Expect `200`, a whole-number `maintenance_calories`, and the explanation.
   Repeated tests consume your Groq quota. Nothing calls Groq automatically
   during login, onboarding saves, health checks, or CI.

The maintenance equation is `10 * weight_kg + 6.25 * height_cm - 5 * age + c`,
where `c` is `-161` for female or `5` for male. The existing gender selection is
used as the sex-based equation input, and this assumption is returned explicitly.
For `other` or `prefer_not_to_say`, the app uses the midpoint coefficient `-78`
and labels it as an app approximation, not a separately validated equation.
Resting estimates below one kcal/day from inconsistent measurements are rejected.

| AI activity level | App activity factor |
| --- | --- |
| `sedentary` | 1.2 |
| `light` | 1.375 |
| `moderate` | 1.55 |
| `active` | 1.725 |
| `very_active` | 1.9 |

These factors and AI classifications are approximate starting estimates, not
measurements. The model considers the whole week and is instructed to explain
conflicts or missing activity detail instead of inventing exercise duration.
The backend rejects invalid levels, additional fields, excessive text, refusals,
and truncated completions, even when the upstream API reports success.
This standalone maintenance endpoint returns an estimate without saving a plan.
The plan endpoint below adds timeline validation, nutrients, and persistence.

### Timeout and quota behavior

| Status | Meaning |
| --- | --- |
| `401` | Log in before requesting an estimate. |
| `403` | Missing CSRF header or untrusted browser origin. |
| `409` | Finish and save onboarding first. |
| `422` | Invalid request body or inconsistent profile measurements. |
| `429` | Local request limit or Groq quota exhausted; respect `Retry-After`. |
| `502` | Malformed, refused, or incomplete AI response. |
| `503` | Missing key, invalid model/configuration, or unavailable provider. |
| `504` | The configured overall AI request deadline expired. |

The server makes one provider attempt per accepted request with a 2,048-token
completion cap. It follows no redirects and performs no automatic retries.
Maintenance requests are limited to two per account per minute. Maintenance,
plan creation and food estimation share ten provider attempts per minute per
server process. Food estimation additionally allows six new attempts per account
per minute. These bounds protect the current
single-worker deployment; additional workers/instances will need shared limits.
Groq quotas apply across its organization, so check your actual account limits
before manually retrying. Provider quota responses preserve a sanitized
`Retry-After` duration; unexpected error bodies never reach the browser.

The app can start and pass health checks without a Groq key. Only the estimate
endpoint then returns a configuration error. No database migration is needed.
Automated tests use mocked provider responses and never require a Groq secret.
The existing hash-locked CI install already contains HTTPX; its runtime
requirements now explicitly include HTTPX and its dependencies.

References: [Groq structured outputs](https://console.groq.com/docs/structured-outputs),
[Groq rate limits](https://console.groq.com/docs/rate-limits),
[Groq errors](https://console.groq.com/docs/errors), and
[Mifflin-St Jeor equation](https://pubmed.ncbi.nlm.nih.gov/2305711/).

## Calorie and nutrient plans

The signed-in dashboard shows estimated maintenance, a daily calorie adjustment,
the resulting intake target, protein/carbohydrate/fat grams, and fiber. The layout
uses four nutrient cards on wider screens and two columns on phones, in the
existing pink/white/charcoal theme. Expand **How this was estimated** to see the
activity interpretation and calculation assumptions.

### Apply the new migration

Keep your working `.env` and Groq/Neon settings. From the repository root:

```bash
source backend/.venv/bin/activate
python -m alembic -c backend/alembic.ini upgrade head
python -m alembic -c backend/alembic.ini check
```

Nutrition plans were added in `0004_nutrition_plans`; upgrading to head also
applies later committed migrations. Existing accounts and profiles remain.
Render's startup script applies migrations on deploy. No new packages, secrets,
or configuration are required.

### API and persistence

| Endpoint | Behavior |
| --- | --- |
| `GET /api/plan` | Return the current account's saved plan; `404` if absent, stale, or past its target date. No Groq call. |
| `POST /api/plan` | Send `{}` with the login cookie and `X-CSRF-Protection: 1`. Validate, calculate, and save (`201`), or reuse a current plan (`200`). |

Both endpoints require a saved profile and use `Cache-Control: no-store`.
Clients cannot supply an account ID, maintenance calories, macros, or a model.
The server stores one plan per account, bound to a fingerprint of its profile
values. Changing those values invalidates the old plan; saving identical values
does not. Expired target dates require a profile update. Logout clears the
display and cancels pending browser requests. No profile/plan data is put in
localStorage.

Plan creation shares the maintenance endpoint's Groq client, timeouts, response
validation, and rate limits. A saved plan can still be read if Groq is unavailable.
Saving a profile, refreshing, and logging back in do not automatically request
another estimate. Concurrent saves are serialized on the profile row, and an
edit while Groq is responding prevents the old snapshot from being saved.

### Automatic-plan limits

These are conservative **application policies**, not a medical assessment or a
promise that a particular goal will be reached. A rejected goal returns `422`
with an explanation, the relevant field, and an optional suggested target date.
The interface offers **Adjust goal** to edit the saved details. Structurally
valid profiles may be saved as drafts even when their goal cannot produce a plan.

| Check | Policy |
| --- | --- |
| Target date | Future UTC date within 730 days; use intermediate goals for longer periods. |
| Weekly loss | At most the smaller of 0.9 kg or 1% of current weight. |
| Weekly gain | At most the smaller of 0.5 kg or 0.5% of current weight. |
| Daily deficit/surplus | At most the smaller of 500 kcal or 20% of estimated maintenance. |
| Daily intake floor | 1,200 kcal for the existing female equation choice; 1,500 kcal for the other choices. |
| Loss target | Target BMI must be at least 18.5. This is a screening guard, not a diagnosis. |

Date, weight, and weekly-rate checks happen before spending Groq quota. After
activity estimation, calorie/floor checks may require a further extension.
Suggested dates are estimates from the failed check, not automatic approvals.
If no suitable suggestion fits the supported period, choose a smaller goal.
The application rejects an excessive change instead of silently clamping it and
pretending the requested date remains achievable.

For weight changes, the initial daily adjustment is
`(target_weight_kg - current_weight_kg) * 7700 / days`. It is rounded toward zero
so rounding never increases the requested restriction or surplus. Maintenance
goals use a zero adjustment and no deadline. The 7,700 kcal/kg approximation
does not model metabolic adaptation, water changes, or distinguish fat from
muscle; it cannot guarantee a deadline. Targets should be reviewed as actual
weight and activity change.

Protein starts at 1.6 g/kg of current weight, bounded to 10-25% of daily calories.
Fat uses 30% of calories, and carbohydrates receive the remainder. Calculations
use 4 kcal/g for protein/carbohydrate and 9 kcal/g for fat. Gram values are
rounded to one decimal, so their energy total may differ by less than one kcal.
Fiber uses 14 g per 1,000 kcal, with a 25 g app minimum; fiber is part of the
carbohydrate target rather than an extra calorie allocation.

Background: [CDC gradual weight loss](https://www.cdc.gov/healthy-weight-growth/losing-weight/index.html),
[NHS gradual weight gain](https://www.nhs.uk/live-well/healthy-weight/managing-your-weight/healthy-ways-to-gain-weight/),
[NHLBI dietary strategies](https://www.nhlbi.nih.gov/sites/default/files/media/docs/obesity-evidence-review.pdf),
[ISSN protein position stand](https://pmc.ncbi.nlm.nih.gov/articles/PMC5477153/),
[Dietary Guidelines nutrient tables](https://www.dietaryguidelines.gov/sites/default/files/2020-12/Dietary_Guidelines_for_Americans_2020-2025.pdf),
and [NIDDK on the limits of linear calorie rules](https://www.niddk.nih.gov/health-information/professionals/diabetes-discoveries-practice/nih-body-weight-planner).
These sources inform the defaults; the exact caps and implementation above are
app choices rather than claims that every value is a universal clinical limit.

## Food nutrition from text

After saving a profile, use **What's on your plate?** to describe a food or meal
and choose **Estimate nutrition**. The preview shows one whole-number calorie
estimate, protein/carbohydrate/fat/fiber grams, edible serving weight, and the
serving/cooking assumptions used. Example buttons fill the text without sending
an AI request. All displayed totals cover the complete described serving.

### Migration and configuration

Keep the existing Groq key, model, database configuration, and `.env.example`.
No new dependencies or secrets are needed. Apply migrations through the current
head before starting the updated application locally:

```bash
source backend/.venv/bin/activate
python -m alembic -c backend/alembic.ini upgrade head
python -m alembic -c backend/alembic.ini check
```

Render's existing startup migration command applies it on the next deployment.

### Serving and cooking defaults

| Description | Default basis when no other details are supplied |
| --- | --- |
| `apple` | One medium raw apple, skin included. |
| `egg` | One large whole egg, about 50 g edible portion, with no added fat. |
| `eggs` without a count | Two large eggs. |
| `fried egg` | One large egg with one teaspoon of oil, about 4.5 g. |
| Frying without a fat quantity | One teaspoon of oil for the whole described serving. |
| Explicit butter/oil | Use the stated amount once; add no extra default oil. Assume it is eaten unless the description says otherwise. |
| Boiled, poached, steamed, raw, or oil-free | Add no cooking fat. |
| Rice, pasta, or legumes without raw/cooked status | Use cooked weight and record the assumption. Explicit raw/dry weights override it. |

These rules are instructions to the configured model. The preview records its
actual interpretation so users can check it. A description with several foods
produces one combined result. Stated nutrition-label values and amounts should
be scaled to the serving. Descriptions can use other languages; result names
and notes are requested in English.

Each successful estimate records 1-6 serving notes and 1-6 cooking notes. The
model is asked to use `As described:` for supplied facts and `Assumed:` for missing details. Calories
are a single integer; nutrient grams are rounded to one decimal. Zero-calorie
drinks are supported. An unidentified or non-food description returns `422`
instead of creating a misleading zero-calorie food.

### API, saved assumptions, and reuse

| Endpoint | Behavior |
| --- | --- |
| `POST /api/food/estimate` | Send `{"description":"fried egg cooked with 1 tablespoon of butter"}` with the login cookie and `X-CSRF-Protection: 1`. New estimate: `201`; identical cached estimate: `200`. |
| `GET /api/food/estimates/{id}` | Read one saved estimate belonging to the signed-in account; unknown or other-account IDs return `404`. |

The API accepts a trimmed description of 1-2,000 characters and rejects extra
fields such as `user_id`, `model`, or client-supplied calories. The food API
requires login but does not require body/activity information. The normal
dashboard shows its preview after onboarding. All responses use `no-store`.

The database retains the original trimmed description, validated nutrition,
assumptions, model ID, and estimate time. Cache keys include account, exact
description, model, and the server's food-prompt version. Case and internal
spacing are preserved; units with case-dependent meanings are not normalized.
Identical requests reuse the saved record without consuming Groq quota.
Changing the prompt's estimation rules should also increment
`FOOD_PROMPT_VERSION` to avoid reusing an old interpretation. Unique keys make
concurrent duplicate inserts safe; a browser double submit is also disabled.

Food estimates are separate from dated diary entries. Creating an estimate
does not change the calorie plan or a daily consumed total; **Add to diary**
saves a dated entry using that estimate. The preview stays in component memory,
is cleared when editing its description, and is discarded on logout or reload.
Repeating the description can restore its saved estimate. No food data is put
in localStorage. Leaving or signing out cancels the pending browser operation.

### Validation and limitations

Food and activity estimates share the same backend Groq connection, configured
model, strict response mode, overall timeout, and sanitized provider errors.
POSTs are never automatically retried. Timeout, quota, malformed-response and
session-expiry states preserve the food text for appropriate manual recovery.
Cached estimates remain available without a configured key; new ones need Groq.

The backend validates recognition, integer calories, finite non-negative
nutrients, bounded text, serving mass, fiber within total carbohydrate, and
basic mass/energy-density consistency. Invalid or truncated output is never
saved. The client also validates the response shape before showing it.

This version uses AI approximations rather than a nutrition database or a live
brand lookup. Basic validation cannot establish nutrient accuracy. Users should
review the assumptions and supply better portion, preparation, or label details
when needed. The backend preserves estimated food calories instead of forcing
them to equal a simple 4/4/9 sum; alcohol, fiber and food-specific energy factors
can affect that relationship. See [FDA calorie information](https://www.fda.gov/food/nutrition-facts-label/calories-nutrition-facts-label)
and [USDA food composition documentation](https://fdc.nal.usda.gov/Foundation_Foods_Documentation/).

Automated checks use mocked Groq responses and verify validation, ownership,
cache reuse, quota/timeout handling, and browser cancellation. They do not claim
to measure the configured model's real-world nutrition accuracy. Test the live
connection locally with your existing private Groq key.

## Daily food diary

After estimating a food, choose **Servings to log** and **Add to diary**. One
serving logs the complete description; 0.5 logs half and 2 logs twice that
amount. Multiple foods described in one estimate remain one combined entry.
**Add again** deliberately creates a separate entry using the same estimate.

The dashboard shows consumed calories, progress against the current daily
calorie target, calories remaining (or above target), and protein,
carbohydrate, fat, and fiber totals. Logging remains available without a
current calorie plan. The progress bar stops at its maximum while the text
continues to show the actual amount and percentage.

### Dates, edits, and assumptions

**Diary date** starts at today's date in the browser's local timezone. The
browser refreshes that date after local midnight or when returning to the
window. A deliberately selected earlier date stays selected. The API requires
an explicit calendar date instead of inferring a day from a UTC timestamp.
Travel or a later timezone change does not move existing entries to another
date. Use **Today** to return to the current local day.

**Edit entry** changes the description, serving multiplier, or calendar date.
A changed description requests a fresh Groq estimate before saving its reference.
Changing just servings or date reuses the existing estimate and spends no AI
quota. Each entry retains the estimate's serving and cooking notes.
**Delete entry** removes it from the day's totals. Refreshing or signing back
in restores the saved diary; drafts are kept only in memory.

Historical entries are compared with the **current valid plan**. This version
does not store historical target snapshots. A changed profile or expired plan
hides targets until a current plan is created, without removing food entries.
Calories are scaled with decimal arithmetic and rounded to whole kcal, and
nutrient grams to one decimal. Daily totals add the displayed entry amounts.

### API and persistence

Apply the new migration using the existing database configuration:

```bash
source backend/.venv/bin/activate
python -m alembic -c backend/alembic.ini upgrade head
python -m alembic -c backend/alembic.ini check
python -m alembic -c backend/alembic.ini current
```

The head is `0006_diary_entries`. No new dependencies or environment variables
are needed. Existing Render startup migrations apply it during deployment.

| Endpoint | Request and behavior |
| --- | --- |
| `GET /api/diary?date=YYYY-MM-DD` | Returns owned entries, scaled totals, current targets, remaining calories, and progress for the requested date. |
| `POST /api/diary/entries` | Send `id` (UUIDv4), `food_estimate_id`, `entry_date`, and `servings`. New entry: `201`; a replay of the same save: `200`. |
| `PUT /api/diary/entries/{id}` | Send `food_estimate_id`, `entry_date`, `servings`, and the last read `version`. Replaces entry details and returns its current version. |
| `DELETE /api/diary/entries/{id}?version=N` | Removes the owned entry from the diary. A repeated delete also returns `204`. |

All endpoints use the existing session cookie and `Cache-Control: no-store`.
Mutations require the existing CSRF header and trusted origin. Account IDs
and nutrition totals are derived on the server. A composite foreign key
prevents an entry from referencing another account's estimate. Servings accept
0.01–20 with at most two decimal places.

A save creates one UUID per intentional addition and keeps that identifier
across uncertain retries, preventing duplicate meals after a lost response.
Intentionally repeated foods receive new identifiers. Updates use a version
check to reject stale changes from another tab, while replaying an already
applied update is safe. Deletion retains an internal tombstone so a delayed
create retry cannot bring the entry back. Deleted entries are excluded from
all diary reads and totals. Deleting the account cascades to its diary rows.

Automated tests cover CRUD, date isolation, totals and rounding, private
ownership, database constraints, repeated saves/deletes, stale edits,
local midnight rollover, and cancellation of late replies after navigation
or logout. Groq responses remain mocked in tests.


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

## Browser journeys and release checks

See [the verification checkpoint](docs/release-checks.md) for the live desktop
review and the remaining browser/device checks.

The browser suite runs the compiled frontend and real FastAPI endpoints against
the existing local Docker PostgreSQL database. Only the Groq transport is
replaced with deterministic activity/apple responses. It does not consume AI
quota or use Neon. The production entry point has no test mode or test routes.

### Run desktop and phone checks locally

Start the existing database and activate the backend environment. Stop any
other test server using port 18002; the normal Vite/API ports remain available.

```bash
source backend/.venv/bin/activate
docker compose up -d --wait --wait-timeout 60 db
npm --prefix frontend ci --ignore-scripts
npm --prefix frontend run build
(cd frontend && npx --no-install playwright install --with-deps chromium webkit)
npm --prefix frontend run test:e2e
```

The first browser installation also installs the required Linux libraries.
The test server applies the existing migrations. It forces local connection
URLs and verifies that the resulting database host is loopback. It uses the
existing local password and other Docker settings from the root configuration.

The suite contains 14 scenarios in each of three browser projects:

| Project | Engine and viewport |
| --- | --- |
| Desktop | Chromium, 1366 × 900 |
| Small Android | Chromium with touch emulation, 360 × 800 |
| iPhone 14 Pro Max | WebKit with iPhone device emulation |

Scenarios cover maintain/gain/lose onboarding, plan creation, food logging,
refresh and re-login persistence, editing servings, moving dates, deletion,
two-account isolation through the real API, lost-save reply retries, local
midnight, theme persistence, and controls fitting the viewport. Failure tests
simulate a waking HTML page, slow replies, transient/network failures,
persistent API failures, AI quota errors, and session expiry.

Browser emulation checks layout and interaction; test a physical phone before
a release as well. The cold-start scenarios simulate failures without
deliberately stopping Render or Neon.

Each test gets a fresh browser context and unique generated E2E credentials.
On normal shutdown, the local server deletes only the exact E2E account IDs
it observed creating, with cascading cleanup of their related data. Existing
accounts remain untouched. A forced process kill may leave temporary E2E rows.
Do not use this harness as a hosted service; it binds to loopback and its
fixture responses are only for this suite.

Run one project while developing, or open the local report after a run:

```bash
npm --prefix frontend run test:e2e -- --project=desktop
(cd frontend && npx --no-install playwright show-report)
```

CI runs all three projects before the coverage/SonarQube gate. Browser specs
and configuration are excluded from application coverage; the existing 80%
combined line/branch requirement remains in force. Browser reports, session
state, videos, and screenshots are not committed. Traces and recordings are
disabled; generated HTML reports remain local.

### Read-only deployed checks

The deployed checks default to the Calorie Tracker Render origin. Run them
after Render finishes deploying:

```bash
npm --prefix frontend run test:deployed
```

Alternatively, after merging this change, open **Actions → Deployed checks →
Run workflow**. The current Render origin is prefilled; override it only for
another intended deployment. This workflow is manual, so it does not
race Render's deployment after the regular CI job.

The default target is https://calorie-tracker-e6b4.onrender.com/. To check
a different HTTPS origin locally, set `E2E_BASE_URL` for that command.

These checks allow up to 120 seconds for readiness, inspect the actual
deployed page on all three browser projects, check theme persistence and
viewport fit, verify API health, and confirm anonymous access to private APIs
returns 401 with no-store caching. They create no accounts, change no saved
records, and make no Groq requests. They do not establish authenticated live
journey or nutrition accuracy.

Before calling the release verified, use two dedicated test accounts on the
actual Render URL and a real phone:

1. Register account A, complete onboarding, create a plan, and estimate/log a
   food using the configured Groq model.
2. Reload, edit its amount and date, return to the chosen day, and confirm its
   totals persist. Delete it and confirm it stays deleted after another reload.
3. Log out and sign into account B. Confirm A's profile, entries, and drafts are
   absent. Sign back into A and confirm its saved data is still present.
4. Check the login, target-date field, diary-date field, and entry editor in
   both themes on the phone. Confirm controls fit and the keyboard is usable.
5. After the services have naturally idled, open the site again and confirm it
   recovers. The read-only probe can wake them; run the cold-start observation
   before that probe when checking a genuinely idle deployment.

Playwright references: [web server](https://playwright.dev/docs/test-webserver),
[device emulation](https://playwright.dev/docs/emulation), and
[network mocking](https://playwright.dev/docs/mock).


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
