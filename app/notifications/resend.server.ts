/**
 * Resend transport. The HTTP client is injectable so tests and the UI harness
 * can pass a fake transport; production uses the module default below.
 *
 * With no RESEND_API_KEY configured the transport fails loudly with
 * errorCode "missing_api_key" — the digest records that as a failed send,
 * which surfaces in Settings > Delivery problems. Never silently dropped.
 */

export interface EmailSendInput {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
}

export interface EmailSendResult {
  id?: string;
  error?: string;
  errorCode?: string;
}

export interface EmailTransport {
  send(input: EmailSendInput): Promise<EmailSendResult>;
}

export function resendTransport(
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch,
): EmailTransport {
  return {
    async send(input: EmailSendInput): Promise<EmailSendResult> {
      if (!apiKey) {
        return { error: "RESEND_API_KEY is not configured", errorCode: "missing_api_key" };
      }
      let res: Response;
      try {
        res = await fetchImpl("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            from: input.from,
            to: [input.to],
            subject: input.subject,
            html: input.html,
            text: input.text,
            headers: input.headers,
          }),
        });
      } catch (err) {
        return { error: String(err), errorCode: "network_error" };
      }
      if (!res.ok) {
        let body = "";
        try {
          body = await res.text();
        } catch {
          body = "";
        }
        return { error: `resend ${res.status}: ${body.slice(0, 300)}`, errorCode: `resend_${res.status}` };
      }
      const json = (await res.json().catch(() => ({}))) as { id?: string };
      if (!json.id) {
        return { error: "resend response missing id", errorCode: "bad_response" };
      }
      return { id: json.id };
    },
  };
}
