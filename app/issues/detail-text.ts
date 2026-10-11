/**
 * Localized detail sentence for an issue row (pure; used by the issues
 * table, the detail panel, and the CSV `detail` column). The type label is
 * rendered separately; this is the sentence that explains the finding.
 */

export type Translate = (key: string, params?: Record<string, unknown>) => string;

export interface IssueDetailLike {
  type: string;
  details: Record<string, unknown>;
}

export function issueDetailText(t: Translate, issue: IssueDetailLike): string {
  const d = issue.details ?? {};

  if (issue.type === "COMPARE_AT_INVALID") {
    if (d.reason === "equal") return t("issue.detail.COMPARE_AT_INVALID_equal");
    if (d.reason === "lower") return t("issue.detail.COMPARE_AT_INVALID_lower");
    return "";
  }

  if (issue.type === "INVALID_BARCODE" && typeof d.hint === "string") {
    return t(`issue.hint.${d.hint}`);
  }

  if ((issue.type === "DUPLICATE_SKU" || issue.type === "DUPLICATE_BARCODE") && d.case_or_space_only) {
    return t("issue.detail.case_or_space_only");
  }

  if (d.group_grew === true) {
    return t("issue.detail.group_grew");
  }

  return "";
}
