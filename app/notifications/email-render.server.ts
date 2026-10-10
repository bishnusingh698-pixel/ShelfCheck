import { makeT } from "../i18n/i18n.server.js";

/**
 * Digest email rendering (spec <notifications>): localized with plurals,
 * HTML and plain-text versions, top-5 new issues with deep links, a link
 * into the app, and the signed one-click unsubscribe footer.
 *
 * All strings come from locales/*.json through the shared ICU renderer —
 * no hard-coded user-facing text.
 */

export interface DigestEmailIssue {
  id: string;
  type: string;
  severity: string;
}

export interface RenderDigestInput {
  locale: string;
  newCount: number;
  openCount: number;
  issues: DigestEmailIssue[];
  /** Deep link builder for one issue detail (public app URL). */
  issueUrl: (id: string) => string;
  appUrl: string;
  unsubscribeUrl: string;
}

export interface DigestEmailContent {
  subject: string;
  text: string;
  html: string;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

const ESCAPES: Record<string, string> = {
  "&": "&#38;",
  "<": "&#60;",
  ">": "&#62;",
  '"': "&#34;",
  "'": "&#39;",
};

export function renderDigestEmail(input: RenderDigestInput): DigestEmailContent {
  const t = makeT(input.locale);
  const newIssuesLine = t("email.digest.newIssues", { count: input.newCount });
  const stillOpenLine = t("email.digest.stillOpen", { count: input.openCount });
  const subject = t("email.digest.subject");
  const greeting = t("email.digest.greeting");
  const summary = t("email.digest.summary", { newCount: newIssuesLine, openCount: stillOpenLine });
  const top = t("email.digest.top");
  const openApp = t("email.digest.openApp");
  const unsubscribe = t("email.digest.unsubscribe");
  const unsubscribeHelp = t("email.digest.unsubscribeHelp");
  const footer = t("email.digest.footer");

  const lines = input.issues.map((issue) => ({
    label: `${t(`issue.type.${issue.type}`)} · ${t(`issue.severity.${issue.severity}`)}`,
    url: input.issueUrl(issue.id),
  }));

  const text = [
    greeting,
    "",
    summary,
    "",
    lines.length ? top : "",
    ...lines.map((l) => `- ${l.label}: ${l.url}`),
    "",
    `${openApp}: ${input.appUrl}`,
    "",
    unsubscribeHelp,
    `${unsubscribe}: ${input.unsubscribeUrl}`,
    "",
    footer,
  ]
    .filter((l) => l !== "")
    .join("\n");

  const items = lines
    .map(
      (l) =>
        `<li style="margin:4px 0"><a href="${escapeHtml(l.url)}" style="color:#30373e">${escapeHtml(l.label)}</a></li>`,
    )
    .join("");
  const html = `<!DOCTYPE html>
<html lang="${escapeHtml(input.locale)}">
<body style="margin:0;padding:24px;background:#f6f6f7;color:#30373e;font-family:Inter,Sans-Serif">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:24px">
    <p style="margin:0 0 8px">${escapeHtml(greeting)}</p>
    <p style="margin:0 0 16px;font-size:16px">${escapeHtml(summary)}</p>
    ${lines.length ? `<h2 style="font-size:14px;text-transform:uppercase;color:#6d7175">${escapeHtml(top)}</h2><ul style="padding-left:18px;margin:0 0 16px">${items}</ul>` : ""}
    <p style="margin:0 0 16px"><a href="${escapeHtml(input.appUrl)}" style="display:inline-block;padding:8px 14px;background:#30373e;color:#ffffff;border-radius:8px;text-decoration:none">${escapeHtml(openApp)}</a></p>
    <hr style="border:none;border-top:1px solid #e3e5e7;margin:16px 0" />
    <p style="margin:0 0 4px;font-size:12px;color:#6d7175">${escapeHtml(unsubscribeHelp)}</p>
    <p style="margin:0;font-size:12px"><a href="${escapeHtml(input.unsubscribeUrl)}" style="color:#6d7175">${escapeHtml(unsubscribe)}</a> · ${escapeHtml(footer)}</p>
  </div>
</body>
</html>`;

  return { subject, text, html };
}
