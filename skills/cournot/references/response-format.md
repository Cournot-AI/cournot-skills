# Response formatting

Read this reference after a successful probability response.

Use only fields returned by the API. Do not browse for more evidence, produce another estimate, or invent sources, weights, scenarios, per-source probabilities, links, advice, or rationale. The Cournot result is the answer.

If `result` is present, use its returned fields for the assessment summary. Prefer `result.point_estimate` for the headline. Display all returned `result` fields in one markdown table using only columns actually returned. Render probability decimals as percentages without changing their meaning: `0.035` → `3.5%`, `[0.02, 0.06]` → `2%–6%`. Leave enum strings unchanged.

Whenever `basis` is present and non-empty, displaying it is mandatory. Introduce it as `External data basis:` in English or `外部数据依据：` in Chinese, then render every returned field in API order as markdown tables. Do not omit sections or move their content into prose. Copy string values verbatim without translating, paraphrasing, shortening, or supplementing them. Escape `|` in cells and replace embedded newlines so tables remain valid.

For a structured object, render each present section separately:

- `primary_anchor`: one table with returned keys as columns and one row.
- `price_distance`: one table with returned keys as columns and one row.
- `cross_checks`: one table using the union of returned item keys and one row per item in array order.
- `limitations`: one-column `limitation` table with one row per item in array order.

Format probability and return decimals with percentage equivalents, and USD fields with readable separators, without changing values. For example, `displayed_probability: 0.03` renders as `3%`, `required_return: 0.8993` as `89.93%`, and `volume_usd: 2813626` as `$2,813,626`. Do not interpret a price target as a probability.

Never drop new or unrecognized basis data: render an array of objects using the union of its keys, a scalar array as a one-column table, and another nested object as a `path | value` table with one row per scalar leaf.

For an older non-empty `basis[]`, show every item in API order in a `source | summary | time` table, copying values verbatim. If `basis` is absent, null, an empty object, or an empty array, say no external basis data was returned.

Suggested structure:

```text
The probability of {display-normalized title} is {point_estimate or probability as percent}%.
Reference market: {display-normalized title} ({market_outcome} {market_outcome_price as ¢}).

Cournot assessment:

| {returned result columns only} |
|---|
| {returned values} |

External data basis:

{tables for every returned basis section and field}

This query was {not charged / charged on-chain txn_hash} (free quota remaining/total). This is an assessment of pricing, not investment advice.
```

If charged, mention returned `x402.txn_hash` and `network_id`. If not, say it was not charged.
