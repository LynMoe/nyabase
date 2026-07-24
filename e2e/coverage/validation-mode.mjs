export function parseValidationMode(argv) {
  const failures = [];
  const profileArgs = argv.filter((arg) => arg.startsWith('--require-profile='));
  const evidenceArgs = argv.filter((arg) => arg.startsWith('--evidence='));
  const candidateArgs = argv.filter((arg) => arg === '--full-chain-candidate');
  const malformed = argv.filter((arg) =>
    arg === '--require-profile'
    || arg === '--evidence'
    || (arg.startsWith('--full-chain-candidate=') && arg !== '--full-chain-candidate'));

  if (profileArgs.length > 1) failures.push('--require-profile may be specified only once');
  if (evidenceArgs.length > 1) failures.push('--evidence may be specified only once');
  if (candidateArgs.length > 1) failures.push('--full-chain-candidate may be specified only once');
  for (const arg of malformed) failures.push(`malformed validation flag ${arg}`);

  const requiredProfile = profileArgs[0]?.slice('--require-profile='.length);
  const evidenceValue = evidenceArgs[0]?.slice('--evidence='.length);
  const fullChainCandidate = candidateArgs.length === 1;
  if (requiredProfile === '') failures.push('--require-profile requires a non-empty value');
  if (evidenceValue === '') failures.push('--evidence requires a non-empty value');
  if (evidenceArgs.length > 0 && !requiredProfile) {
    failures.push('--evidence requires --require-profile so runtime evidence is actually evaluated');
  }
  if (fullChainCandidate && requiredProfile !== 'full') {
    failures.push('--full-chain-candidate is restricted to --require-profile=full');
  }
  return { requiredProfile, evidenceValue, fullChainCandidate, failures };
}

export function behavioralClosureLabel({ requiredProfile, fullChainCandidate, pending }) {
  if (!requiredProfile) return 'STATIC CONTRACT ONLY (runtime evidence not evaluated)';
  if (fullChainCandidate) {
    return 'FULL CANDIDATE ONLY (one cold Full run; release closure not verified)';
  }
  return pending === 0
    ? `${requiredProfile.toUpperCase()} RUNTIME EVIDENCE VERIFIED`
    : `${requiredProfile.toUpperCase()} RUNTIME EVIDENCE INCOMPLETE`;
}
