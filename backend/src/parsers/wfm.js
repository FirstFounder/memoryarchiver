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
const STORE_RE = /WFM\s*#\s*0*(\d+)/i;

// Date line: MM/DD/YY HH:MM — the timestamp line at receipt bottom.
// Must have time component to avoid matching approval codes.
const DATE_LINE_RE = /(\d{1,2})\/(\d{1,2})\/(\d{2})\s+\d{1,2}:\d{2}/;

// PURCHASES section header — tolerates leading OCR noise chars (|, spaces, etc.)
// Also handles OCR split "PURCHASE S"
const PURCHASES_RE = /^[^A-Z0-9]*PURCHASES?\b/i;

// BALANCE line — OCR mangles the leading asterisks in many ways:
// "****  BALANCE  62.27"  → canonical
// "«x«* BALANCE 9.93"    → non-ASCII noise
// "2 ER BALANCE 14.16"   → fully garbled prefix
// "xxx% BALANCE 121.98"  → garbled prefix
// "ome BALANCE gs 52."   → garbled amount too
// Strategy: if BALANCE appears anywhere on the line, extract the LAST
// digit sequence that looks like NN.NN as the subtotal.
const BALANCE_LINE_RE = /BALANCE/i;
const AMOUNT_RE = /(\d+\.\d{2})/g;

// TAX inline line
const TAX_RE = /^TAX\s+([\d]+\.[\d]{2})/i;

// Weight deal line preceding a WT item: "0.56lb @ 1.49/lb"
// tesseract reads "lb" as "1b" — handle both.
const WEIGHT_DEAL_RE = /^([\d.]+)\s*(?:lb|1b)\s*@\s*([\d.]+)\s*\/\s*(?:lb|1b)/i;

// WT prefix on item line: "WT   SERRANO PEPPERS   0.10B"
const WT_PREFIX_RE = /^WT\s+/i;

// Multi-unit deal line: "2 @ 1.99" or "4 @ 2/ 1.00"
// Must start with digits then @
const MULTI_UNIT_RE = /^(\d+)\s*@/;

// Item line: description + price + optional code at end of line.
// Two patterns: strict (2+ spaces) and loose (1+ space).
// Price code B/T/F/R — OCR sometimes produces lowercase.
const ITEM_RE = /^(.+?)\s{2,}([\d]+\.[\d]{2})\s*([BTFRbtfr]?)$/;
const ITEM_LOOSE_RE = /^(.+?)\s+([\d]+\.[\d]{2})\s*([BTFRbtfr]?)$/;

// Lines to always skip regardless of section.
// NOTE: BALANCE and PURCHASES checks happen before this block in the loop,
// so these patterns cannot accidentally suppress those critical lines.
const SKIP_PATTERNS = [
  /^WFM\s*#/i,                              // store header line
  /^\d{1,5}\s+(?:Deerfield|IL-|118th)/i,   // address
  /^(?:Buffalo Grove|Lakemoor|Kenosha)/i,   // city
  /^(?:IL|WI)\s*$/i,                        // state alone
  // Masked card: asterisks NOT followed by the word BALANCE.
  // "***4498" → skip. "**** BALANCE 108.97" → do NOT skip (BALANCE wins above).
  /^[*«x~\s\d]{0,6}\*{2,}(?!.*BALANCE)/i,
  /^[\d]{6,}-[\d]{4,}-[\d]{3}-/,           // approval code NNN-NNN-NNN-APPROVED
  /APPROVED/i,                              // any approval line
  /^(?:Purchase|Cashback|Total)\s+Amount/i,
  /^Debit\s+(?:Receipt|\d)/i,
  /^CHANGE\s+[\d.]/i,
  /^TOTAL\s+(?:TAX|NUMBER)/i,
  /^Woodman/i,
  /^[\d]{10,}$/,                            // barcode / shopper ID
  /^[~\-=]{4,}$/,                          // separator lines
  /^COUPONS\s*$/i,
  /^(?:MC|MFR|INSTANT)\s+/i,              // coupon lines
  /^\d{1,2}\/\d{1,2}\/\d{2}\s+\d{1,2}:\d{2}/, // timestamp
  /^Debit\b/i,          // "Debit (" or "Debit 143.62"
  /^CHANG[EF]\b/i,      // "CHANGE", "CHANGF" (OCR variant)
];

/**
 * @param {string} rawText
 * @returns {object|null}
 */
export function parse(rawText) {
  // Must contain PURCHASES (possibly split by OCR noise)
  if (!/(?:PURCHASES?|URCHASES?|HASES?)/i.test(rawText)) return null;

  const result = {
    store_number: null,
    store_address: null,
    date: null,
    items: [],
    subtotal: null,
    tax_amount: null,
    total: null,
  };

  let pendingWeightDeal = null;  // weight deal line seen, waiting for WT item
  let pendingMultiUnit  = null;  // multi-unit deal line, annotates next item
  let inItemSection     = false; // true between PURCHASES and BALANCE

  for (const rawLine of rawText.split('\n')) {
    const line    = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) continue;

    // --- Store number ---
    if (result.store_number === null) {
      const sm = trimmed.match(STORE_RE);
      if (sm) {
        const num = parseInt(sm[1], 10);
        result.store_number  = num;
        result.store_address = WFM_STORES[num] ?? null;
        continue;
      }
    }

    // --- Date (tight: requires time component) ---
    if (result.date === null) {
      const dm = trimmed.match(DATE_LINE_RE);
      if (dm) {
        const month = dm[1].padStart(2, '0');
        const day   = dm[2].padStart(2, '0');
        const year  = `20${dm[3]}`;
        result.date = `${year}-${month}-${day}`;
        continue;
      }
    }

    // --- PURCHASES section header → enter item section ---
    // Checked before SKIP_PATTERNS so noise-prefixed PURCHASES lines aren't eaten.
    if (PURCHASES_RE.test(trimmed)) {
      inItemSection = true;
      continue;
    }

    // --- BALANCE line → capture subtotal, exit item section ---
    // Checked before SKIP_PATTERNS so "**** BALANCE NN.NN" isn't eaten by the
    // masked-card skip pattern.
    if (BALANCE_LINE_RE.test(trimmed)) {
      // Extract the last NN.NN amount on the line as the subtotal
      const amounts = [...trimmed.matchAll(AMOUNT_RE)].map(m => parseFloat(m[1]));
      if (amounts.length > 0) {
        result.subtotal = amounts[amounts.length - 1];
      }
      inItemSection = false;
      continue;
    }

    // --- TAX ---
    {
      const m = trimmed.match(TAX_RE);
      if (m) {
        result.tax_amount = parseFloat(m[1]);
        continue;
      }
    }

    // --- Always-skip patterns ---
    if (SKIP_PATTERNS.some(re => re.test(trimmed))) continue;

    // Only parse items inside the item section
    if (!inItemSection) continue;

    // --- Weight deal line: "0.071b @ 1.49/1b" ---
    {
      const m = trimmed.match(WEIGHT_DEAL_RE);
      if (m) {
        pendingWeightDeal = { weight: parseFloat(m[1]), rate: parseFloat(m[2]) };
        continue;
      }
    }

    // --- Multi-unit deal line: "2 @ 1.99" or "4 @ 2/ 1.00" ---
    // Only treat as deal if line starts with digits+@ (no description before it)
    if (MULTI_UNIT_RE.test(trimmed) && /^[\d]+\s*@/.test(trimmed)) {
      const m = trimmed.match(MULTI_UNIT_RE);
      pendingMultiUnit = { qty: parseInt(m[1], 10) };
      continue;
    }

    // --- WT-prefixed weight item line: "WT  SERRANO PEPPERS  0.10B" ---
    if (WT_PREFIX_RE.test(trimmed)) {
      const withoutWT   = trimmed.replace(WT_PREFIX_RE, '').trim();
      const itemMatch   = withoutWT.match(ITEM_RE) || withoutWT.match(ITEM_LOOSE_RE);
      if (itemMatch) {
        const description = itemMatch[1].trim();
        const price       = parseFloat(itemMatch[2]);
        const price_code  = itemMatch[3].toUpperCase() || null;
        const item = {
          description,
          price,
          price_code: price_code || null,
          is_weight_item: true,
          quantity: null,
          unit_price: null,
        };
        if (pendingWeightDeal) {
          item.weight      = pendingWeightDeal.weight;
          item.rate_per_lb = pendingWeightDeal.rate;
          pendingWeightDeal = null;
        }
        result.items.push(item);
        pendingMultiUnit = null;
      }
      continue;
    }

    // --- Regular item line ---
    {
      const itemMatch = trimmed.match(ITEM_RE) || trimmed.match(ITEM_LOOSE_RE);
      if (itemMatch) {
        const description = itemMatch[1].trim();
        const price       = parseFloat(itemMatch[2]);
        const price_code  = itemMatch[3].toUpperCase() || null;

        // Skip descriptions that are too short or look like noise
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
          item.is_weight_item = true;
          item.weight         = pendingWeightDeal.weight;
          item.rate_per_lb    = pendingWeightDeal.rate;
          pendingWeightDeal   = null;
        }

        if (pendingMultiUnit) {
          item.quantity    = pendingMultiUnit.qty;
          pendingMultiUnit = null;
        }

        result.items.push(item);
        continue;
      }
    }

    // Line didn't match — clear stale weight deal
    if (pendingWeightDeal && trimmed.length > 3) {
      pendingWeightDeal = null;
    }
  }

  // A result with no items and no store number is likely a false positive
  if (result.items.length === 0 && result.store_number === null) return null;

  return result;
}
