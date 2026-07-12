FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

RUN apt-get update \
    && apt-get install --no-install-recommends -y libgeos-dev libproj-dev libspatialindex-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY detour_router.py detour_api.py prepare_graphs.py traffic_restrictions.py ./

RUN useradd --create-home --uid 10001 detour \
    && mkdir -p /app/data /app/cache \
    && chown -R detour:detour /app

USER detour
EXPOSE 8001

CMD ["uvicorn", "detour_api:app", "--host", "0.0.0.0", "--port", "8001", "--workers", "1"]
