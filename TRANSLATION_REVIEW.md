# Translation Review — lower-confidence strings

Reviewed per spec §localization item 6: natural, native e-commerce
language, not word-for-word. These entries are where confidence is
lowest; a native reviewer should check them first. Everything not listed
here is standard e-commerce vocabulary matching the Shopify admin.

## de (German, Sie register)
- `issue.snooze.days` — "Zurückstellen" for snooze; Shopify has no direct
  equivalent; alternative "Später erinnern" was rejected because issues
  reappear automatically, not as a reminder.
- `rules.title` — "Ignorierregel" is a coinage; "Ausschlussregel" was
  considered but "ignorieren" matches the issue action verb.
- `plans.feature.watchers` — "Webhook-Watcher" keeps the English "Watcher"
  (common in German dev tooling); verify against Shopify's webhook wording.

## fr (French, vous)
- `dashboard.title` — "Santé du catalogue": check that "santé" (health)
  reads naturally; alternative "qualité du catalogue".
- `rules.title` — "Règles d'ignorance" is a coinage; alternative "Règles
  d'exclusion" if it reads better.

## es (Spanish, tú)
- `issue.detail.COMPARE_AT_INVALID` — "Precio barrado" is the common
  LatAm/e-commerce term for compare-at price; Peninsular Spanish often
  uses "precio comparativo". The listing copy uses "precio comparativo"
  in body text for clarity.
- `plans.feature.watchers` — "Webhooks de vigilancia"; confirm register.

## pt-BR
- `issue.snooze.actions` — "Adiar" for snooze; standard BR e-commerce.
- `dashboard.scan.title` — "Varredura" chosen over "escaneamento"
  (glossary); confirm it reads naturally in the dashboard heading.

## pt-PT
- Diverged from pt-BR per glossary ("análise", "inventário", "detalhe"
  register); verify "pontuação de estado" vs "índice de saúde" for
  health score.

## zh-CN
- `issue.status.snoozed` — "已暂缓" for snoozed; alternative "已延后".
- `settings.autoTag.help` — quote style uses full-width 「」 per zh
  typography; confirm the tag literal `shelfcheck-fix` stays ASCII.
- `issue.hint.scientific_notation` — technical phrasing; confirm the
  CSV-corruption explanation is clear.

## ja
- `issue.snooze.days` — "スヌーズ" is a loanword; confirm it is acceptable
  vs "一時非表示".
- `activity.kind.snoozes_reopened` — long phrase; confirm naturalness.

## it (tu register)
- `rules.title` — "Regole di ignoranza" coinage; alternative "Regole di
  esclusione".
- `dashboard.band.needs_attention` — "Da migliorare" for the amber band
  (score-friendly tone); alternative "Richiede attenzione".

## nl
- `issue.actions.unsnooze` — "Herstellen" doubles as "restore"; the
  intent is "un-snooze". Alternative "Terugzetten".

## sv
- `toast.undone` — fixed during this review pass: "Ångrad" (was the
  nonstandard "Ångradet"); confirm register against Shopify sv strings.

## Same-as-English allowlist (scripts/i18n-check.ts)
Reviewed and justified per locale: brand terms (ShelfCheck, SKU, GTIN,
CSV, Shopify, Matrixify), the MIME value `text/csv`, plan names
(Starter/Pro must map exactly to the Partner Dashboard names), format
templates (`app.documentTitle`, `auth.shopDetails`), and established
loanwords identical in that language ("Dashboard"/"Status"/"Open"/
"Variant"/"Product"/"Scan(nen)"/"Upgrade" in de/nl/sv etc.).
