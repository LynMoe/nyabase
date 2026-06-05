const VALID_OPENSSH_ED25519_FIXTURE_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEAKxELmEG7rqBkGaSOXo9W5iTiZb20hOhtjYZO8lQW2';

export function liveFixtureSshPublicKey(label: string): string {
  const safeLabel = label.replace(/[^a-zA-Z0-9._-]/g, '-');
  return `${VALID_OPENSSH_ED25519_FIXTURE_KEY} ${safeLabel}@nyabase-test`;
}
