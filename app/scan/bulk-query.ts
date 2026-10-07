/**
 * The bulk query, frozen and fixture-tested. Every field verified against the
 * 2026-07 Admin GraphQL reference (docs/api-notes.md §4):
 *  - top-level connection: productVariants (1 connection)
 *  - nested connection: media(first: 1) (level-1 nesting)
 *  - product and inventoryItem are plain objects (no connection cost)
 *  - groupObjects: never (spec: do not enable)
 *
 * JSONL output shape (per docs/api-notes.md §3):
 *  - variant lines include their plain-object children inline
 *  - media edges appear as separate lines with __parentId = variant id
 */

export const BULK_SCAN_QUERY = /* GraphQL */ `
  query ShelfCheckScan {
    productVariants {
      edges {
        node {
          __typename
          id
          title
          sku
          barcode
          price {
            amount
          }
          compareAtPrice {
            amount
          }
          inventoryPolicy
          inventoryQuantity
          product {
            id
            title
            vendor
            status
            isGiftCard
            variantsCount {
              count
            }
            availablePublicationsCount {
              count
            }
          }
          inventoryItem {
            id
            tracked
            requiresShipping
            unitCost {
              amount
            }
            measurement {
              weight {
                value
                unit
              }
            }
          }
          media {
            edges {
              node {
                id
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * The mutation that starts the operation. groupObjects defaults to false and
 * we pass it explicitly so a future default change can never flip our format.
 */
export const BULK_RUN_MUTATION = /* GraphQL */ `
  mutation ShelfCheckBulkRun($query: String!) {
    bulkOperationRunQuery(query: $query, groupObjects: false) {
      bulkOperation {
        id
        status
        objectCount
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const BULK_STATUS_QUERY = /* GraphQL */ `
  query ShelfCheckBulkStatus($id: ID!) {
    bulkOperation(id: $id) {
      id
      status
      objectCount
      url
      partialDataUrl
      errorCode
      fileSize
    }
  }
`;

export type BulkOperationStatus =
  | "CREATED"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELED"
  | "EXPIRED";

export const BULK_TERMINAL_STATUSES: BulkOperationStatus[] = [
  "COMPLETED",
  "FAILED",
  "CANCELED",
  "EXPIRED",
];

export function isTerminal(status: string): boolean {
  return (BULK_TERMINAL_STATUSES as string[]).includes(status);
}
