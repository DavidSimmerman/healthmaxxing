---
description: Resolve pending health-dashboard items into macros and post them back.
---

# /process-health

You are processing the user's queued food-capture items from the health-dashboard app. The app is intentionally dumb — it captures (barcode / label photo / pasted text / photo + caption) and stores items as `pending`. Your job is to convert each pending item into structured macros and POST the result back.

## Environment

- App base URL: `$HEALTH_APP_URL` (default `http://localhost:5173` in dev). If unset, ask the user.
- Bearer token: `$HEALTH_API_TOKEN`. If `API_TOKEN` env var is unset on the app side, auth is skipped — but still include the header if you have one.

## Workflow

1. **Fetch pending items:**

   ```bash
   curl -s -H "Authorization: Bearer $HEALTH_API_TOKEN" \
     "$HEALTH_APP_URL/api/pending?status=pending"
   ```

2. **For each item**, resolve based on `kind`:
   - **`kind: "barcode"`** — Open Food Facts already missed (the app tried). Search the web for the barcode (UPC databases, manufacturer sites). If you find macros, great. If not, ask the user what the product is — don't guess wildly.

   - **`kind: "label_photo"`** — image at `$HEALTH_APP_URL/api/uploads/{imagePath}` (Bearer auth). Use your vision to read the Nutrition Facts panel. Extract per-serving macros.

   - **`kind: "paste"`** — free-form text describing food (e.g. "Chipotle bowl, double chicken, brown rice, mild salsa, cheese, lettuce"). Use Chipotle's nutrition calculator (or chain's website) when you recognize a chain. Otherwise estimate from cookbook knowledge.

   - **`kind: "photo_with_caption"`** — image + caption. Look at the image, factor in the caption ("Publix bakery dinner rolls, ate 2 of them"), produce a best-guess. Be honest in the `resolverNote` about confidence.

3. **POST the resolution back** for each item:

   ```bash
   curl -s -X POST \
     -H "Authorization: Bearer $HEALTH_API_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{
       "name": "Chobani Greek Yogurt - Plain Nonfat",
       "brand": "Chobani",
       "servingSize": "1 container (170g)",
       "servingGrams": 170,
       "calories": 120,
       "proteinG": 18,
       "carbsG": 9,
       "fatG": 0,
       "source": "claude_code",
       "resolverNote": "OCR from label, high confidence",
       "logToday": true
     }' \
     "$HEALTH_APP_URL/api/pending/{id}/resolve"
   ```

   - `source` should be one of: `claude_code`, `label_ocr`, `estimate`.
   - `resolverNote` should reflect uncertainty (e.g. "estimate based on generic 'dinner roll', ±20%").
   - `logToday: true` adds it to today's log immediately (default `false` — only set true when the user clearly intended to log it now, not just catalog it).

4. **Summarize for the user** at the end: how many resolved, any low-confidence ones flagged, anything you couldn't figure out.

## Macro conventions

- All values **per serving**, not per 100g.
- If the label is per-100g only, scale to a sensible serving size and note it.
- Calories = kcal.
- Round to 1 decimal max for macros, whole for calories.

## When to ask vs. guess

- Brand/SKU foods where you can verify (chain restaurants, supermarket brands): verify, don't guess.
- Generic home-cooked items: estimate with confidence interval in `resolverNote`.
- Truly ambiguous: leave `status: 'pending'`, ask the user a single clarifying question, retry.

Existing foods (by barcode) will be deduped automatically — the resolve endpoint upserts on barcode.
