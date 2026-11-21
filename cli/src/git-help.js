// Maps the stderr of a failed git step to a section of the public guide
// https://eminzo.dev/help/commit-signing/ (the anchors are stable, identical in both languages).
// Topics: `ssh-auth` (authenticate with GitHub over HTTPS with gh), `signing` (set up signing so it
// works without a terminal; reserved, no git error maps to it today) and `troubleshooting` (the error table).

export const HELP_TOPICS = ['ssh-auth', 'signing', 'troubleshooting'];

const SSH_AUTH = [
  /Permission denied \(publickey/i,
  /Host key verification failed/i,
];

// GPG and SSH signing failures. `failed to write commit object` alone is not matched: it also follows unrelated errors.
const SIGNING = [
  /gpg failed to sign the data/i,
  /gpg: signing failed/i,
  /^error: gpg/im,
  /gpg: skipped .*: No secret key/i,
  /Couldn't sign message/i,
  /Load key ".*": incorrect passphrase/i,
];

/** 'es' when the first of LC_ALL, LC_MESSAGES, LANG that is set starts with `es`, else 'en'. */
export function helpLocale(env = process.env) {
  const value = [env.LC_ALL, env.LC_MESSAGES, env.LANG].find((v) => v);
  return /^es/i.test(value ?? '') ? 'es' : 'en';
}

/** @returns {{ topic: string, url: string } | null} */
export function gitHelp(stderr, locale = 'en') {
  const text = String(stderr ?? '');
  const topic = SSH_AUTH.some((re) => re.test(text)) ? 'ssh-auth'
    : SIGNING.some((re) => re.test(text)) ? 'troubleshooting'
      : null;
  if (!topic) return null;
  return { topic, url: `https://eminzo.dev/${locale === 'es' ? 'es/' : ''}help/commit-signing/#${topic}` };
}
