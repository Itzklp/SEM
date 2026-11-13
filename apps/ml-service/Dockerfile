# Built from the repo root as context (docker-compose.yml) so parents[3]
# inside app/main.py and app/train.py still resolves to /app the same way
# it resolves to the real repo root on the host — same code, same paths,
# no MODEL_DIR override needed.
FROM python:3.11-slim

WORKDIR /app

COPY apps/ml-service/requirements.txt apps/ml-service/requirements.txt
RUN pip install --no-cache-dir -r apps/ml-service/requirements.txt

COPY apps/ml-service/app apps/ml-service/app
COPY apps/ml-service/docker-entrypoint.sh docker-entrypoint.sh
RUN chmod +x docker-entrypoint.sh

# ml/models and ml/datasets are a volume mount (docker-compose.yml) — a
# model trained in this container persists on the host and survives a
# container rebuild, the same artifact `pnpm ml:train` would have produced.
RUN mkdir -p ml/models ml/datasets

EXPOSE 8000
ENTRYPOINT ["./docker-entrypoint.sh"]
