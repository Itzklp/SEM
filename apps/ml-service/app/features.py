"""Canonical serving feature order. Keep aligned with FeatureVector in domain."""

import math

FEATURE_NAMES = (
    "amount_major_units",
    "transaction_count_5m",
    "transaction_count_1h",
    "amount_sum_1h",
    "average_amount_24h",
    "distinct_merchants_1h",
    "distinct_locations_24h",
    "failed_transactions_10m",
    "device_transaction_count",
    "account_age_days",
    "merchant_risk_score",
    "ip_risk_score",
)


def to_model_row(amount_major_units: float, features: dict[str, float]) -> list[float]:
    """Use exactly the online feature names and order used by training."""
    values = [amount_major_units, *(features.get(name, 0.0) for name in FEATURE_NAMES[1:])]
    if any(not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0 for value in values):
        raise ValueError("features must be finite non-negative numbers")
    return [float(value) for value in values]
