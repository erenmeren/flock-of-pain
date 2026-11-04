# API: one uvicorn process over SQLite. Mount /data for the database file.
FROM python:3.13-slim
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock README.md ./
COPY src ./src
RUN uv sync --frozen --no-dev --extra api
ENV FLOCK_DB=/data/flock.db PATH="/app/.venv/bin:$PATH"
VOLUME /data
EXPOSE 8000
CMD ["uvicorn", "flock_of_pain.api:app", "--host", "0.0.0.0", "--port", "8000"]
