export async function copyOneTimeSecret(
  secret: string,
  clipboard: Pick<Clipboard, 'writeText'> | undefined = globalThis.navigator?.clipboard,
): Promise<boolean> {
  if (!clipboard) return false;
  try {
    await clipboard.writeText(secret);
    return true;
  } catch {
    return false;
  }
}
