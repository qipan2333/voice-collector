ARG PYTHON_IMAGE=python:3.13-slim
FROM ${PYTHON_IMAGE}

ARG APT_MIRROR=https://mirrors.aliyun.com

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN --mount=type=cache,id=voice-collector-apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=voice-collector-apt-lists,target=/var/lib/apt/lists,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
    && sed -i \
      -e "s|http://deb.debian.org/debian-security|${APT_MIRROR}/debian-security|g" \
      -e "s|http://deb.debian.org/debian|${APT_MIRROR}/debian|g" \
      -e "s|https://deb.debian.org/debian-security|${APT_MIRROR}/debian-security|g" \
      -e "s|https://deb.debian.org/debian|${APT_MIRROR}/debian|g" \
      /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get -o Binary::apt::APT::Keep-Downloaded-Packages=true install -y --no-install-recommends ffmpeg curl

WORKDIR /app
COPY requirements.txt .
ARG PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/
ARG PIP_TRUSTED_HOST=
RUN --mount=type=cache,id=voice-collector-pip,target=/root/.cache/pip,sharing=locked \
    pip install --disable-pip-version-check --prefer-binary -r requirements.txt

RUN useradd --create-home --uid 10001 appuser \
    && mkdir -p /srv/voice-collector \
    && chown appuser:appuser /app /srv/voice-collector

COPY --chown=appuser:appuser app ./app
COPY --chown=appuser:appuser alembic.ini ./alembic.ini
COPY --chown=appuser:appuser alembic ./alembic

USER appuser

EXPOSE 8000
CMD ["sh", "-c", "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8000"]
