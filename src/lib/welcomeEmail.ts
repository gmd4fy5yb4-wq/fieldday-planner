// One-time welcome email, sent through Resend on a user's first sign-in.
//
// emails/welcome.html is the send-ready HTML from the design handoff (nested
// tables, every style inlined, tested in Gmail / Outlook / Apple Mail). It is
// read and sent verbatim — never rebuilt as components. The subject line lives
// in the comment on line 2 of that file, so copy edits stay in one place.
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const FROM = 'Greg at Alfred Digital <hello@alfred-digital.com>' // only alfred-digital.com is verified in Resend
const REPLY_TO = 'help@alfred-digital.com'                    // the copy promises a person reads replies

// Sent-marker lives in app_metadata: admin-only, so a user cannot clear it and
// re-trigger the send. App-prefixed because auth.users is shared by every Sports app.
export const SENT_KEY = 'fd_welcome_sent_at'

type WelcomeUser = { id: string; email?: string; app_metadata?: Record<string, unknown> }
type AdminClient = {
  auth: { admin: { updateUserById: (id: string, attrs: { app_metadata: Record<string, unknown> }) => Promise<unknown> } }
}

export function parseSubject(html: string): string | undefined {
  return html.match(/<!-- Suggested subject: (.+?) -->/)?.[1]
}

/** Safe to call on every sign-in — it only sends once per user. */
export async function sendWelcomeEmail(
  user: WelcomeUser,
  svc: AdminClient,
): Promise<'sent' | 'already-sent' | 'skipped'> {
  if (!user.email || user.app_metadata?.[SENT_KEY]) return 'already-sent'
  if (!process.env.RESEND_API_KEY) return 'skipped'

  const html = await readFile(path.join(process.cwd(), 'emails', 'welcome.html'), 'utf8')
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM,
      to: [user.email],
      reply_to: REPLY_TO,
      subject: parseSubject(html) ?? 'Welcome to FieldDay Planner',
      html,
    }),
  })
  if (!res.ok) {
    console.error('Welcome email failed:', res.status, await res.text().catch(() => ''))
    return 'skipped'
  }
  // ponytail: check-then-mark, so two simultaneous first sign-ins could both send; harmless for a welcome note.
  await svc.auth.admin.updateUserById(user.id, { app_metadata: { [SENT_KEY]: new Date().toISOString() } })
  return 'sent'
}
