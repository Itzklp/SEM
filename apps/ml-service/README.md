# ML service

This isolated Python service loads a versioned model artifact and exposes
`POST /api/v1/score`, `GET /models`, `/health/live`, `/health/ready`, and
Prometheus `/metrics`. It uses the same twelve input features at training and
serving time: transaction amount plus the eleven Redis feature-store fields.
Unknown feature names and malformed scores are rejected.

## Train and run locally

From the repository root, create a virtual environment, install the pinned
requirements, train the synthetic-only candidates, and start the API:

```powershell
python -m venv .venv
.\.venv\Scripts\python -m pip install -r apps/ml-service/requirements.txt
.\.venv\Scripts\python apps/ml-service/app/train.py --rows 100000 --seed 20261031
.\.venv\Scripts\python -m uvicorn app.main:app --app-dir apps/ml-service --host 0.0.0.0 --port 8000
```

The training command writes a deterministic synthetic dataset,
`ml/datasets/evaluation-report.json`, a compressed joblib artifact, and
`ml/models/registry.json`. These generated files are intentionally ignored from
source control. The evaluation report compares logistic regression, random
forest, and histogram gradient boosting using precision, recall, F1, ROC-AUC,
PR-AUC, false-positive rate, false-negative rate, and single-row p99 inference
latency. Selection maximizes PR-AUC among models that meet the 15 ms inference
budget. A controlled comparison then substitutes the learned model signal into
the existing rules provider's rules, weights, behavioural score, and decision
threshold. Results describe only the generated scenarios; they are not
real-world performance claims.

Set `SCORING_PROVIDER=ml` in `.env` and ensure the service is reachable at
`ML_SERVICE_URL`. The Node provider enforces `ML_TIMEOUT_MS`, opens its circuit
after `ML_CIRCUIT_BREAKER_THRESHOLD` consecutive failures, and uses
`ML_FALLBACK_PROVIDER` while open or unavailable. Fallback decisions carry
`ML_UNAVAILABLE` degradation metadata and continue through the normal
decision, persistence, and outbox path.

No real customer or payment data belongs in training or inference. The model
must be retrained and evaluated when representative, appropriately governed
labels become available; synthetic scenario scores alone do not justify
production deployment.
