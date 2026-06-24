#!/usr/bin/env python3
"""
Scrape ComEd Informational Sheet 36.1 (Rider CFRA) and extract rates
for the current calendar month.
Output (stdout, JSON):
  { "rate_month": "YYYY-MM", "cfra_cents": -1.344, "cfra_partial": false }
Partial mode: if the CFRMR column for the target month is "TBD", use only
the CFR Adjustment value and set cfra_partial = true. If neither column has
a value, fail.
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
except ImportError as e:
    print(f"Missing dependency: {e}", file=sys.stderr)
    sys.exit(1)

CFRA_PDF_URL = (
    "https://www.comed.com/cdn/assets/v3/assets/"
    "blt3ebb3fed6084be2a/bltad9c638b99bc5016/"
    "6920b4a29eaaa8ce05e16e25/"
    "96_Carbon-Free_Resource_Adjustment_-_Info_Sheet_36.1.pdf"
)

MONTH_NAMES = {
    "January": 1, "February": 2, "March": 3, "April": 4,
    "May": 5, "June": 6, "July": 7, "August": 8,
    "September": 9, "October": 10, "November": 11, "December": 12
}


def parse_value(s):
    """Parse a CFRA table cell value. (X.XXX) = credit (negative). Returns float or None."""
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

    target_month_names = [name for name, num in MONTH_NAMES.items() if num == target_month]
    if not target_month_names:
        print("Could not determine target month name", file=sys.stderr)
        sys.exit(1)
    target_month_name = target_month_names[0]

    try:
        resp = requests.get(CFRA_PDF_URL, headers={"User-Agent": "Mozilla/5.0"}, timeout=30)
        resp.raise_for_status()
    except Exception as e:
        print(f"Failed to download CFRA PDF: {e}", file=sys.stderr)
        sys.exit(1)

    try:
        with pdfplumber.open(io.BytesIO(resp.content)) as pdf:
            text = ""
            for page in pdf.pages:
                text += page.extract_text() or ""
    except Exception as e:
        print(f"Failed to parse CFRA PDF: {e}", file=sys.stderr)
        sys.exit(1)

    pattern = re.compile(
        rf"({target_month_name})\s+({target_year})\s+"
        r"([\d.()\-]+|TBD)\s+"
        r"([\d.()\-]+|TBD)\s+"
        r"([\d.()\-]+|TBD)",
        re.IGNORECASE
    )
    match = pattern.search(text)
    if not match:
        print(
            f"Could not find row for {target_month_name} {target_year} in CFRA PDF. "
            f"The CDN URL may need to be updated.",
            file=sys.stderr
        )
        sys.exit(1)

    cfr_adj_str = match.group(3)
    total_str   = match.group(5)

    total_val = parse_value(total_str)
    cfr_adj_val = parse_value(cfr_adj_str)

    if total_val is not None:
        result = {
            "rate_month":   target_month_str,
            "cfra_cents":   round(total_val, 4),
            "cfra_partial": False
        }
    elif cfr_adj_val is not None:
        result = {
            "rate_month":   target_month_str,
            "cfra_cents":   round(cfr_adj_val, 4),
            "cfra_partial": True
        }
    else:
        print(
            f"Both total and CFR Adjustment are TBD for {target_month_name} {target_year}",
            file=sys.stderr
        )
        sys.exit(1)

    print(json.dumps(result))


if __name__ == "__main__":
    main()
