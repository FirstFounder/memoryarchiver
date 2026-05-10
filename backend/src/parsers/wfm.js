/**
 * Whole Foods Market receipt parser.
 *
 * parse(rawText) → structured object | null
 * Returns null when the text does not look like a WFM receipt.
 */

const WFM_STORES = {
  42: '1550 Deerfield Pkwy, Buffalo Grove IL',
  43: '27555 IL-120, Lakemoor IL',
  27: '7145 118th Avenue, Kenosha WI',
};

// Matches a money amount at the end of a string, with an optional price code.
// Price codes: B=bulk, T=taxable, F=?, R=refund (all optional per spec)
const PRICE_RE = /^([\d]+\.[\d]{2})\s*([BTFR]?)$/;

// Two-or-more spaces separate description from price on item lines.
const ITEM_SEP_RE = /\s{2,}/;

// Weight sub-line: "WT  0.56 lb @ 19.99/lb  5.59 B"
// Captures the final charged price (last money token before optional code).
const WT_LINE_RE = /^WT\b/i;
const WT_PRICE_RE = /([\d]+\.[\d]{2})\s*([BTFR]?)$/;

// Produce deal: "4 @ 2/ 1.00" — N items at M for TOTAL
const DEAL_RE = /^(\d+)\s*@\s*(\d+)\/\s*([\d]+\.[\d]{2})\s*([BTFR]?)$/;

// TAX inline: "TAX  0.50"
const TAX_RE = /^TAX\s+([\d]+\.[\d]{2})/i;

// Totals
const PURCHASES_RE = /^PURCHASES\s+([\d]+\.[\d]{2})/i;
const SUBTOTAL_RE = /^SUBTOTAL\s+([\d]+\.[\d]{2})/i;
const TOTAL_RE = /^TOTAL\s+([\d]+\.[\d]{2})/i;

// Store number: "#042", "Store #42", "Store: 42"
const STORE_RE = /(?:store\s*#?|#\s*)0*(\d+)/i;

// Date: MM/DD/YYYY or MM-DD-YYYY
const DATE_RE = /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/;

/**
 * @param {string} rawText
 * @returns {object|null}
 */
export function parse(rawText) {
  if (!rawText.includes('PURCHASES')) return null;

  const result = {
    store_number: null,
    store_address: null,
    date: null,
    items: [],
    subtotal: null,
    tax_amount: null,
    total: null,
  };

  // pendingDescription: item description seen without a price yet (weight item pattern)
  let pendingDescription = null;
  // pendingWeightPrice: price seen on a WT line, to be attached to the next description
  let pendingWeightPrice = null;
  let pendingWeightCode = null;

  for (const rawLine of rawText.split('\n')) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Store number
    if (result.store_number === null) {
      const sm = trimmed.match(STORE_RE);
      if (sm) {
        const num = parseInt(sm[1], 10);
        result.store_number = num;
        result.store_address = WFM_STORES[num] ?? null;
        continue;
      }
    }

    // Date (first match wins)
    if (result.date === null) {
      const dm = trimmed.match(DATE_RE);
      if (dm) {
        const month = dm[1].padStart(2, '0');
        const day = dm[2].padStart(2, '0');
        let year = dm[3];
        if (year.length === 2) year = `20${year}`;
        result.date = `${year}-${month}-${day}`;
        // Don't continue — the date may appear inside a header line that
        // also contains other parseable data.
      }
    }

    // TAX line — capture amount, not an item
    {
      const m = trimmed.match(TAX_RE);
      if (m) {
        result.tax_amount = parseFloat(m[1]);
        continue;
      }
    }

    // Summary lines
    {
      const m = trimmed.match(PURCHASES_RE);
      if (m) { result.subtotal = parseFloat(m[1]); continue; }
    }
    {
      const m = trimmed.match(SUBTOTAL_RE);
      if (m) { result.subtotal = parseFloat(m[1]); continue; }
    }
    {
      const m = trimmed.match(TOTAL_RE);
      if (m) { result.total = parseFloat(m[1]); continue; }
    }

    // WT line — sets pendingWeightPrice; description comes after (or was already pending)
    if (WT_LINE_RE.test(trimmed)) {
      const pm = trimmed.match(WT_PRICE_RE);
      if (pm) {
        if (pendingDescription !== null) {
          // Description was already buffered; emit the weight item now.
          result.items.push({
            description: pendingDescription,
            price: parseFloat(pm[1]),
            price_code: pm[2] || null,
            is_weight_item: true,
            quantity: null,
            unit_price: null,
          });
          pendingDescription = null;
        } else {
          // Description comes on the next line.
          pendingWeightPrice = parseFloat(pm[1]);
          pendingWeightCode = pm[2] || null;
        }
      }
      continue;
    }

    // Produce deal line: "4 @ 2/ 1.00 [code]"
    {
      const m = trimmed.match(DEAL_RE);
      if (m) {
        if (result.items.length > 0) {
          // Attach deal metadata to the most recent item.
          const last = result.items[result.items.length - 1];
          last.quantity = parseInt(m[1], 10);
          last.deal_unit_count = parseInt(m[2], 10);
          last.price = parseFloat(m[3]);
          if (m[4]) last.price_code = m[4];
        }
        continue;
      }
    }

    // Regular item line: "DESCRIPTION  PRICE [CODE]"
    // Split on two-or-more spaces, price token is the last segment.
    {
      const parts = trimmed.split(ITEM_SEP_RE);
      if (parts.length >= 2) {
        const last = parts[parts.length - 1].trim();
        const pm = last.match(PRICE_RE);
        if (pm) {
          const description = parts.slice(0, parts.length - 1).join('  ').trim();
          const price = parseFloat(pm[1]);
          const price_code = pm[2] || null;

          if (pendingWeightPrice !== null) {
            // WT line preceded this description line.
            result.items.push({
              description,
              price: pendingWeightPrice,
              price_code: pendingWeightCode,
              is_weight_item: true,
              quantity: null,
              unit_price: null,
            });
            pendingWeightPrice = null;
            pendingWeightCode = null;
          } else {
            result.items.push({
              description,
              price,
              price_code,
              is_weight_item: false,
              quantity: null,
              unit_price: null,
            });
          }
          pendingDescription = null;
          continue;
        }
      }
    }

    // Description-only line (no price): buffer it for the next WT line.
    // Only buffer if it looks like an item name (not a header/footer keyword).
    if (
      trimmed.length > 1 &&
      !/^(?:whole foods|member|rewards|items sold|thank you|cashier|terminal|ref #)/i.test(trimmed)
    ) {
      pendingDescription = trimmed;
    }
  }

  return result;
}
