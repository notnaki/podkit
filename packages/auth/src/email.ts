// Dev email sink. In dev/test there is no SMTP provider, so transactional
// emails (password reset, email verification) are simply LOGGED — recipient +
// subject + the link/token — and reported as sent. This keeps the auth flows
// fully exercisable end-to-end without a network dependency.
//
// ponytail: logged dev email; real delivery is pluggable via setEmailSender().
//   Upgrade path: wire a provider (Resend/SES/Postmark/SMTP) behind sendEmail
//   by calling setEmailSender() at boot — do NOT add an SMTP dependency here.

export interface EmailMessage {
  to: string;
  subject: string;
  // The human-facing body. For dev, callers pass the action link/token here so
  // it shows up in the log and can be copy-pasted into the flow.
  text: string;
}

export type EmailSender = (msg: EmailMessage) => Promise<void> | void;

// The default sink: log to stderr (so it doesn't pollute stdout protocols).
const defaultSender: EmailSender = (msg) => {
  console.error(
    `[podkit:email] (dev sink) to=${msg.to} subject="${msg.subject}"\n${msg.text}`,
  );
};

let sender: EmailSender = defaultSender;

// Override the active sender (e.g. plug a real provider at boot). Tests use this
// to capture sent messages instead of logging them.
export function setEmailSender(next: EmailSender): void {
  sender = next;
}

// Restore the default (logging) sink. Mainly for test isolation.
export function resetEmailSender(): void {
  sender = defaultSender;
}

// Send a transactional email through the active sender. Never throws to the
// caller for delivery problems in the default sink (logging can't fail); a
// real sender may throw and the caller decides how to handle it.
export async function sendEmail(msg: EmailMessage): Promise<void> {
  await sender(msg);
}
