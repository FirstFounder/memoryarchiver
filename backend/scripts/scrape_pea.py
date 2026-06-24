#!/usr/bin/env python3
"""
Scrape the ICC ComEd filing registry to find the current month's
Purchased Electricity Adjustment (PEA) Hourly pricing factor.
Output (stdout, JSON):
  { "rate_month": "YYYY-MM", "pea_cents": 0.23 }
Exit 0 on success, exit 1 on failure.
"""
import sys
import json
import re
import io
from datetime import datetime, timezone

try:
    import requests
    import pdfplumber
    from bs4 import BeautifulSoup
except ImportError as e:
    print(f"Missing dependency: {e}", file=sys.stderr)
    sys.exit(1)

ICC_FILING_URL = "https://icc.illinois.gov/emdb/ucdb/entity/U295/filing-list"
SEARCH_TEXT = "Purchase Electricity Adjustment Factor"

MONTH_NAMES = {
    "January": 1, "February": 2, "March": 3, "April": 4,
    "May": 5, "June": 6, "July": 7, "August": 8,
    "September": 9, "October": 10, "November": 11, "December": 12
}


def parse_value(s):
    s = s.strip()
    if not s or s.upper() == "TBD":
        return None
    if s.startswith("(") and s.endswith(")"):
        return -float(s[1:-1])
    try:
        return float(s)
    except ValueError:
        return None


def main():
    now = datetime.now(timezone.utc)
    target_year = now.year
    target_month = now.month
    target_month_str = f"{target_year}-{target_month:02d}"

    target_month_names = [n for n, m in MONTH_NAMES.items() if m == target_month]
    if not target_month_names:
        print("Could not determine target month name", file=sys.stderr)
        sys.exit(1)
    target_month_name = target_month_names[0]

    try:
        resp = requests.get(ICC_FILING_URL, headers={"User-Agent": "Mozilla/5.0"}, timeout=30)
        resp.raise_for_status()
    except Exception as e:
        print(f"Failed to fetch ICC filing index: {e}", file=sys.stderr)
        sys.exit(1)

    soup = BeautifulSoup(resp.text, "html.parser")
    pdf_url = None
    for link in soup.find_all("a", href=True):
        if SEARCH_TEXT in link.get_text():
            href = link["href"]
            if href.startswith("/"):
                href = f"https://icc.illinois.gov{href}"
            pdf_url = href
            break

    if not pdf_url:
        print(
            f"Could not find PEA filing link on ICC index (searched for '{SEARCH_TEXT}')",
            file=sys.stderr
        )
        sys.exit(1)

    try:
        pdf_resp = requests.get(pdf_url, headers={"User-Agent": "Mozilla/5.0"}, timeout=30)
        pdf_resp.raise_for_status()
    except Exception as e:
        print(f"Failed to download PEA PDF from {pdf_url}: {e}", file=sys.stderr)
        sys.exit(1)

    try:
        with pdfplumber.open(io.BytesIO(pdf_resp.content)) as pdf:
            for page in pdf.pages:
                text = page.extract_text() or ""
                if "Hourly" not in text and "BES-H" not in text:
                    continue
                pattern = re.compile(
                    rf"({target_month_name})\s+({target_year})\s+([\d.()\-]+|TBD)",
                    re.IGNORECASE
                )
                match = pattern.search(text)
                if match:
                    val = parse_value(match.group(3))
                    if val is not None:
                        result = {
                            "rate_month": target_month_str,
                            "pea_cents":  round(val, 4)
                        }
                        print(json.dumps(result))
                        sys.exit(0)
    except Exception as e:
        print(f"Failed to parse PEA PDF: {e}", file=sys.stderr)
        sys.exit(1)

    print(
        f"Could not find Hourly PEA row for {target_month_name} {target_year} in PDF",
        file=sys.stderr
    )
    sys.exit(1)


if __name__ == "__main__":
    main()
