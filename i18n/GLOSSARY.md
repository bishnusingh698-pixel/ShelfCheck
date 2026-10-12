# ShelfCheck — Translation Glossary

Approved terms per language for the supported locales. Register: match the
formal-but-friendly tone of the Shopify admin in each language (French uses
vous; German uses Sie; Spanish uses tú, as Shopify does; Portuguese (BR)
uses você; Italian uses tu, as Shopify does; Dutch uses je; Swedish uses du;
Chinese (Simplified) and Japanese use the standard polite register).

Never translate: ShelfCheck, SKU, GTIN, CSV, Shopify, Matrixify.

| English | de | fr | es | pt-BR | pt-PT | zh-CN | ja | it | nl | sv |
|---|---|---|---|---|---|---|---|---|---|---|
| catalog | Katalog | catalogue | catálogo | catálogo | catálogo | 目录 | 商品カタログ | catalogo | catalogus | katalog |
| variant | Variante | variante | variante | variante | variante | 变体 | バリエーション | variante | variant | variant |
| barcode | Barcode | code-barres | código de barras | código de barras | código de barras | 条形码 | バーコード | codice a barre | barcode | streckkod |
| inventory | Inventar | stock | inventario | estoque | inventário | 库存 | 在庫 | inventario | voorraad | lager |
| duplicate | Dublikat | doublon | duplicado | duplicado | duplicado | 重复 | 重複 | duplicato | duplicaat | dubblett |
| scan | Scan | analyse | análisis | varredura | análise | 扫描 | スキャン | scansione | scan | genomsökning |
| issue | Problem | problème | problema | problema | problema | 问题 | 問題 | problema | probleem | problem |
| severity | Schweregrad | gravité | gravedade | gravidade | gravidade | 严重程度 | 重要度 | gravità | ernst | allvarlighetsgrad |
| high | Hoch | élevée | alta | alta | alta | 高 | 高 | alta | hoog | hög |
| medium | Mittel | moyenne | media | média | média | 中 | 中 | media | gemiddeld | medel |
| low | Niedrig | faible | baja | baixa | baixa | 低 | 低 | bassa | laag | låg |
| snooze | Zurückstellen | Reporter à plus tard | Aplazar | Adiar | Adiar | 暂缓 | スヌーズ | Rinviare | Uitstellen | Skjut upp |
| intentional | Absichtlich | intentionnel | intencional | intencional | intencional | 有意为之 | 意図的 | intenzionale | opzettelijk | avsiktlig |
| resolved | Behoben | résolu | resuelto | resolvido | resolvido | 已解决 | 解決済み | risolto | opgelost | löst |
| ignored | Ignoriert | ignoré | ignorado | ignorado | ignorado | 已忽略 | 無視 | ignorato | genegeerd | ignorerad |
| activity | Aktivität | activité | actividad | atividade | atividade | 活动 | アクティビティ | attività | activiteit | aktivitet |
| "since your last visit" | „seit Ihrem letzten Besuch" | « depuis votre dernière visite » | « desde tu última visita » | « desde sua última visita » | « desde a sua última visita » | 「自你上次查看以来」 | 「前回閲覧以降」 | « dall'ultima visita » | « sinds je laatste bezoek » | « sedan ditt senaste besök » |
| health score | Health-Score | score de santé | puntaje de salud | pontuação de saúde | pontuação de saúde | 健康评分 | 健康スコア | punteggio di salute | gezondheidsscore | hälsopoäng |
| ignore rule | Ignorierregel | règle d'ignorance | regla para ignorar | regra de ignorar | regra para ignorar | 忽略规则 | 無視ルール | regola di ignoranza | negeerregel | ignoreringsregel |
| webhook | Webhook | webhook | webhook | webhook | webhook | Webhook | Webhook | webhook | webhook | webhook |
| plan (billing) | Tarif | offre | plan | plano | plano | 方案 | プラン | piano | abonnement | abonnemang |

Notes:
- "SKU" and "GTIN" stay in English in every locale (brand/technical terms).
- pt-BR vs pt-PT: "varredura" (BR) vs "análise" (PT) for scan; "estoque"
  (BR) vs "inventário" (PT) for inventory; BR uses "você", PT uses European
  phrasing ("a sua última visita").
- zh-CN and ja plurals: CLDR gives these locales only the `other` category;
  translated plural templates therefore use exact `=0` / `=1` arms plus
  `other` (supported by the ICU subset renderer in `app/i18n/translate.ts`).
