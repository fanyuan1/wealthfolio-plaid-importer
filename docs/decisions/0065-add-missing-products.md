# 0065 — D64: Add missing products

## Context
A ScholarShare 529 Item came back with only `transactions`, although Plaid lists `investments` for the institution. Its investment accounts were marked unsupported and nothing imported (2026-11-27).

## Decision
Each account check reads the Item's products from `/item/get` and compares them with the products its account types need (investment → `investments`, depository and credit → `transactions`). The difference, kept to products the institution offers in `/institutions/get_by_id`, is saved as `missing` on the connection. New York's 529 offers no `investments`, so it gets no button. When a new connection finishes, the addon calls each missing product's endpoint at once: the user just linked accounts that need it, and the Link they finished already asked for `investments` as an optional product. Plaid bills a product once its endpoint is called. For an older connection, Connections shows an "Add …" button, and the addon adds the product only after the user clicks. The click calls the product's endpoint. If Plaid answers `ADDITIONAL_CONSENT_REQUIRED`, the addon opens Link in update mode with `additional_consented_products` and calls the endpoint again after the user finishes. If Plaid answers with a login error such as `ITEM_LOGIN_REQUIRED`, the connection is marked Reconnect needed and the same update-mode Link renews the login and asks for the consent at once. Accounts marked unsupported get their real kind once the product is there.

## Consequences
New links keep `investments` in `optional_products`, which already asks for consent. Only `investments` and `transactions` have an endpoint to add them.
