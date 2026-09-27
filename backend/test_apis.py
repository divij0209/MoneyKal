"""Standalone reachability check for every external API key in backend/.env.

    python -m backend.test_apis

WHY EVERYTHING IS INSIDE main()
-------------------------------
This file used to run at import time: `load_dotenv(...)`, seven live network
calls and a page of printed output all sat at module level. Importing it — which
a linter, an IDE indexer or anything that walks the `backend` package does
without being asked — fired real requests against Gemini, Groq, NewsAPI, FRED,
Alpha Vantage and CoinGecko, burned rate-limited quota, and mutated os.environ
as a side effect.

The per-service functions are named `check_*` rather than `test_*` for the same
reason. The module is called `test_apis`, so pytest collects it; with `test_`
prefixes pytest would have treated each network probe as a unit test and run
them on every CI run. Nothing here is a unit test — it is an operator tool that
answers "are my keys valid today".
"""
import os


def _report(name, fn):
    try:
        result = fn()
        print(f"[ok]   {name}: {result}")
        return True
    except Exception as e:  # noqa: BLE001 — a diagnostic reports every failure
        print(f"[FAIL] {name}: {e}")
        return False


def check_gemini():
    from backend.services.gemini_service import gemini_service
    if not gemini_service.available():
        raise RuntimeError("client not configured / key missing")
    return gemini_service.generate("Say 'ok' and nothing else.", temperature=0.0, max_output_tokens=5)


def check_groq():
    from backend.services.groq_service import groq_service
    if not groq_service.available():
        raise RuntimeError("client not configured / key missing")
    return groq_service.generate("Say 'ok' and nothing else.")


def check_news():
    from backend.market_intelligence.api_clients import NewsAPIClient
    articles = NewsAPIClient().get_news("startup")
    if not articles:
        raise RuntimeError("no articles returned (key may be invalid or rate-limited)")
    return f"{len(articles)} articles, first: {articles[0].get('title')}"


def check_fred():
    from backend.market_intelligence.api_clients import FREDClient
    value = FREDClient().get_indicator("CPIAUCSL")
    if value is None:
        raise RuntimeError("no value returned (key or series id may be invalid)")
    return value


def check_exchange_rate():
    from backend.market_intelligence.api_clients import ExchangeRateClient
    rate = ExchangeRateClient().get_exchange_rate("USD", "INR")
    if rate is None:
        raise RuntimeError("no rate returned (key or endpoint may be invalid)")
    return rate


def check_alpha_vantage():
    from backend.market_intelligence.api_clients import AlphaVantageClient
    price = AlphaVantageClient().get_quote("AAPL")
    if price is None:
        raise RuntimeError("no price returned (key may be invalid or rate-limited)")
    return price


def check_coingecko():
    from backend.market_intelligence.api_clients import CoinGeckoClient
    price = CoinGeckoClient().get_price("bitcoin", "usd")
    if price is None:
        raise RuntimeError("no price returned")
    return price


CHECKS = (
    ("Gemini", check_gemini),
    ("Groq", check_groq),
    ("NewsAPI", check_news),
    ("FRED", check_fred),
    ("ExchangeRate", check_exchange_rate),
    ("AlphaVantage", check_alpha_vantage),
    ("CoinGecko", check_coingecko),
)


def main() -> int:
    # Loaded here, not at import: reading .env into os.environ is a global side
    # effect that no importer asked for.
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

    print("=== Testing external APIs ===\n")
    passed = sum(1 for name, fn in CHECKS if _report(name, fn))
    print(f"\n=== {passed}/{len(CHECKS)} reachable ===")
    # Non-zero when something is unreachable, so this is usable from a script.
    return 0 if passed == len(CHECKS) else 1


if __name__ == "__main__":
    raise SystemExit(main())
