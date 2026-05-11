/**
 * Woodman's Food Market receipt parser.
 *
 * parse(rawText) → structured object | null
 * Returns null when the text does not look like a WFM receipt.
 *
 * Handles OCR output from tesseract 5.x on scan-app image PDFs.
 * OCR artifacts are common: inconsistent spacing, digit/letter substitution,
 * split words, noise lines. The parser is intentionally tolerant.
 */

const WFM_STORES = {
  42: '1550 Deerfield Pkwy, Buffalo Grove IL',
  43: '27555 IL-120, Lakemoor IL',
  27: '7145 118th Avenue, Kenosha WI',
};

// Store number: specifically "WFM #NN" or "WFM#NN"
// Must anchor to WFM to avoid false matches on card numbers / approval codes.
const STORE_RE = /WFM\s*#\s*0*(\d+)/i;

// Date line: MM/DD/YY HH:MM or MM/DD/YYYY HH:MM at end of receipt.
// The date is always on the timestamp line: "11/26/25 01:25pm 42 81 104 781"
// Two-digit years only (WFM receipts use YY not YYYY).
// We use a strict pattern: exactly MM/DD/YY followed by space and time.
const DATE_LINE_RE = /(\d{1,2})\/(\d{1,2})\/(\d{2})\s+\d{1,2}:\d{2}/;

// Balance line: "**** BALANCE  62.27" — this is the subtotal
const BALANCE_RE = /^\*+\s*BALANCE\s+([\d]+\.[\d]{2})/i;

// TAX inline line: "TAX  0.50" — a line that is just TAX + amount
const TAX_RE = /^TAX\s+([\d]+\.[\d]{2})/i;

// COUPONS section header and coupon lines — skip entirely
const COUPONS_HEADER_RE = /^COUPONS\s*$/i;
const COUPON_LINE_RE = /^(MC|MFR|INSTANT)\s+/i;

// Purchase/cashback/total summary lines in footer — skip
const FOOTER_RE = /^(Purchase Amount|Cashback Amount|Total Amount|Debit|CHANGE|TOTAL TAX|TOTAL NUMBER|Woodman'?s Shopper)/i;

// Approval / card lines — skip
const APPROVAL_RE = /^[\d]+-[\d]+-[\d]+-APPROVED$/i;
const MASKED_CARD_RE = /^\*{4,}/;

// Weight deal line preceding an item: "0.56lb @ 1.49/lb" or "0.071b @ 1.49/1b"
// Note: tesseract often reads "lb" as "1b" — handle both.
const WEIGHT_DEAL_RE = /^([\d.]+)\s*(?:lb|1b)\s*@\s*([\d.]+)\s*\/\s*(?:lb|1b)/i;

// WT prefix on item line: "WT   SERRANO PEPPERS   0.10B"
const WT_PREFIX_RE = /^WT\s+/i;

// Multi-unit deal line: "2 @ 1.99" or "4 @ 2/ 1.00" or "2 @ 2.79BUY 2/ 5.00SAVE 0.58"
// We use these to annotate the NEXT item(s), not as items themselves.
const MULTI_UNIT_RE = /^(\d+)\s*@\s*([\d.]+)/;

// Item line: description followed by price+code.
// Price code: B, T, F, R (optional). OCR sometimes reads B as 8 or 6.
// We use a looser right-anchor: price at end of line after whitespace.
// The key insight: price is always rightmost, format NN.NN optionally followed by [BTFR].
const ITEM_RE = /^(.+?)\s{2,}([\d]+\.[\d]{2})\s*([BTFRbtfr]?)$/;

// Looser item match for lines where OCR collapsed spaces:
// If line ends in " N.NNX" or " N.NN" we try to extract it.
const ITEM_LOOSE_RE = /^(.+?)\s+([\d]+\.[\d]{2})\s*([BTFRbtfr]?)$/;

// Skip patterns — lines that are definitely not items
const SKIP_PATTERNS = [
  /^PURCHASES\s*$/i,           // section header (no amount)
  /^PURCHASE\s+S\s*$/i,        // OCR split "PURCHASE S"
  /^\*+\s*BALANCE/i,           // balance line (captured separately)
  /^WFM\s*#/i,                 // store header
  /^[\d]+\s+(?:Deerfield|IL-|118th|Avenue|Pkwy)/i, // address
  /^(?:Buffalo Grove|Lakemoor|Kenosha)/i,           // city
  /^(?:IL|WI)\s*$/i,           // state alone
  /^\*{4,}/,                   // masked card / approval
  /^[\d]{6}-[\d]{6}-[\d]{3}-/,// approval code
  /^(?:Purchase|Cashback|Total)\s+Amount/i,
  /^Debit\s+[\d]/i,
  /^CHANGE\s+[\d]/i,
  /^TOTAL\s+(?:TAX|NUMBER)/i,
  /^Woodman/i,
  /^[\d]{10,}$/,               // barcode
  /^[~\-]{4,}$/,               // separator lines
  /^COUPONS\s*$/i,
  /^(?:MC|MFR|INSTANT)\s+/i,   // coupon lines
  /^Debit\s+Receipt/i,
  /^\d{1,2}\/\d{1,2}\/\d{2}\s+\d{1,2}:\d{2}/,  // timestamp (date line, captured separately)
];

/**
 * @param {string} rawText
 * @returns {object|null}
 */
export function parse(rawText) {
  // Must contain PURCHASES (possibly split by OCR as "PURCHASE S")
  if (!rawText.includes('PURCHASES') && !/PURCHASE\s+S/i.test(rawText)) {
    return null;
  }

  const result = {
    store_number: null,
    store_address: null,
    date: null,
    items: [],
    subtotal: null,
    tax_amount: null,
    total: null,
  };

  let pendingWeightDeal = null;   // { weight, rate } from a weight deal line
  let pendingMultiUnit = null;    // { qty, unitPrice } from a multi-unit line
  let inItemSection = false;      // true after PURCHASES header, false after BALANCE

  for (const rawLine of rawText.split('\n')) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Store number — only match WFM #NN pattern
    if (result.store_number === null) {
      const sm = trimmed.match(STORE_RE);
      if (sm) {
        const num = parseInt(sm[1], 10);
        result.store_number = num;
        result.store_address = WFM_STORES[num] ?? null;
        continue;
      }
    }

    // Date — tight pattern, only matches the timestamp line
    if (result.date === null) {
      const dm = trimmed.match(DATE_LINE_RE);
      if (dm) {
        const month = dm[1].padStart(2, '0');
        const day = dm[2].padStart(2, '0');
        const year = `20${dm[3]}`;
        result.date = `${year}-${month}-${day}`;
        continue;
      }
    }

    // PURCHASES section header — enter item section
    if (/^PURCHASES\s*$/i.test(trimmed) || /^PURCHASE\s+S\s*$/i.test(trimmed)) {
      inItemSection = true;
      continue;
    }

    // BALANCE line — exit item section, capture subtotal
    {
      const m = trimmed.match(BALANCE_RE);
      if (m) {
        result.subtotal = parseFloat(m[1]);
        inItemSection = false;
        continue;
      }
    }

    // TAX inline line
    {
      const m = trimmed.match(TAX_RE);
      if (m) {
        result.tax_amount = parseFloat(m[1]);
        continue;
      }
    }

    // Skip footer / header / noise lines
    if (SKIP_PATTERNS.some(re => re.test(trimmed))) {
      continue;
    }

    // Only parse items within the PURCHASES section
    if (!inItemSection) continue;

    // Weight deal line: "0.56lb @ 1.49/lb"
    {
      const m = trimmed.match(WEIGHT_DEAL_RE);
      if (m) {
        pendingWeightDeal = {
          weight: parseFloat(m[1]),
          rate: parseFloat(m[2]),
          description: null,
        };
        continue;
      }
    }

    // Multi-unit line: "2 @ 1.99" or "4 @ 2/ 1.00"
    {
      const m = trimmed.match(MULTI_UNIT_RE);
      // Only treat as multi-unit if the line is JUST the deal (no item description before it)
      // A line like "2 @ 1.99" with nothing before the quantity is a deal line.
      // Distinguish from item lines that happen to start with a number.
      if (m && /^[\d]+\s*@/.test(trimmed)) {
        pendingMultiUnit = {
          qty: parseInt(m[1], 10),
          raw: trimmed,
        };
        continue;
      }
    }

    // WT-prefixed item line: "WT   SERRANO PEPPERS   0.10B"
    if (WT_PREFIX_RE.test(trimmed)) {
      const withoutWT = trimmed.replace(WT_PREFIX_RE, '').trim();
      const itemMatch = withoutWT.match(ITEM_RE) || withoutWT.match(ITEM_LOOSE_RE);
      if (itemMatch) {
        const description = itemMatch[1].trim();
        const price = parseFloat(itemMatch[2]);
        const price_code = itemMatch[3].toUpperCase() || null;
        const item = {
          description,
          price,
          price_code: price_code || null,
          is_weight_item: true,
          quantity: null,
          unit_price: null,
        };
        if (pendingWeightDeal) {
          item.weight = pendingWeightDeal.weight;
          item.rate_per_lb = pendingWeightDeal.rate;
          pendingWeightDeal = null;
        }
        result.items.push(item);
        pendingMultiUnit = null;
        continue;
      }
    }

    // Regular item line
    {
      const itemMatch = trimmed.match(ITEM_RE) || trimmed.match(ITEM_LOOSE_RE);
      if (itemMatch) {
        const description = itemMatch[1].trim();
        const price = parseFloat(itemMatch[2]);
        const price_code = itemMatch[3].toUpperCase() || null;

        // Skip lines where description looks like noise (very short or all symbols)
        if (description.length < 2) continue;

        const item = {
          description,
          price,
          price_code: price_code || null,
          is_weight_item: false,
          quantity: null,
          unit_price: null,
        };

        if (pendingWeightDeal) {
          // This shouldn't happen (weight items use WT prefix) but handle gracefully
          item.is_weight_item = true;
          item.weight = pendingWeightDeal.weight;
          item.rate_per_lb = pendingWeightDeal.rate;
          pendingWeightDeal = null;
        }

        if (pendingMultiUnit) {
          item.quantity = pendingMultiUnit.qty;
          pendingMultiUnit = null;
        }

        result.items.push(item);
        continue;
      }
    }

    // Line didn't match anything useful — clear pending weight deal
    // (it was for a line that couldn't be parsed as an item)
    if (pendingWeightDeal && trimmed.length > 3) {
      pendingWeightDeal = null;
    }
  }

  // A receipt with no items and no store number is probably a false positive
  if (result.items.length === 0 && result.store_number === null) {
    return null;
  }

  return result;
}
