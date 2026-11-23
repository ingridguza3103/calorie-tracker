FROM node:24-bookworm-slim AS frontend
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --ignore-scripts
COPY frontend ./
RUN npm run build

FROM python:3.12-slim-bookworm
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app/backend
COPY backend/requirements-ci.lock ./
RUN python -m pip install --no-cache-dir --only-binary=:all: --require-hashes -r requirements-ci.lock
COPY backend/alembic.ini backend/start.sh ./
COPY backend/alembic ./alembic
COPY backend/app ./app
COPY --from=frontend /build/frontend/dist /app/frontend/dist
USER 10001:10001
CMD ["sh", "start.sh"]
