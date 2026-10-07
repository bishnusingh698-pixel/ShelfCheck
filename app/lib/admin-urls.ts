/**
 * Admin URL builders.
 * - Inside the embedded app: App Bridge-compatible `shopify://admin/...` links.
 * - Emails, Telegram, CSV: `https://admin.shopify.com/store/<handle>/...`.
 */

export function adminHttpsUrl(handle: string, path: string): string {
  const clean = path.replace(/^\/+/, "");
  return `https://admin.shopify.com/store/${handle}/${clean}`;
}

export function appBridgeUrl(path: string): string {
  const clean = path.replace(/^\/+/, "");
  return `shopify://admin/${clean}`;
}

export function productAdminPath(handle: string, productIdGid: string): string {
  const id = productIdGid.replace(/^gid:\/\/shopify\/Product\//, "");
  return adminHttpsUrl(handle, `products/${id}`);
}

export function variantInventoryAdminPath(handle: string, inventoryItemIdGid: string): string {
  const id = inventoryItemIdGid.replace(/^gid:\/\/shopify\/InventoryItem\//, "");
  return adminHttpsUrl(handle, `inventory/inventoryitems/${id}`);
}

export function appPath(appHandle: string, path = ""): string {
  const clean = path.replace(/^\/+/, "");
  return `https://admin.shopify.com/store/${appHandle}/apps/${clean}`;
}
