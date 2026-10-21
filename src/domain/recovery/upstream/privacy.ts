/** Applied before opening any file; excluded secrets never enter the blob store. */
export function isPrivateRecoveryPath(path: string): boolean {
  return path.split('/').some(segment =>
    /^(?:\.git|node_modules|\.ssh|\.aws|\.azure|\.gnupg|\.npmrc|\.pypirc|credentials|secrets)$/i.test(segment)
    || /^\.env(?:\.|$)/i.test(segment)
    || /\.(?:pem|p12|pfx|key|kdbx)$/i.test(segment)
    || /^(?:id_rsa|id_ed25519|auth\.json|tokens?\.json)$/i.test(segment));
}
