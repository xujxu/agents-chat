const shared = { model: 'sensevoice-small-q8', repository: 'xujxu/agents-chat', repositoryId: 1260147964 };
export const catalogue = Object.freeze({
  linux: Object.freeze({
    ...shared, platform: 'linux', artifact: 10794617845, run: 35968099304, bytes: 245531591,
    name: 'voice-install-sensevoice-small-q8',
    commit: 'a2f15bff3c05b94433855ce9d16056cac1296133',
    archiveSha256: 'e2be50235ba3f584833750c444c313dd3aa4231c65a6eb1c222e18c06e0e7295',
    manifestSha256: 'ccf50b7ddaef5f9a0cddd58f87c4f08421902c630b2ca2a485bfebaae727f40c',
  }),
  win32: Object.freeze({
    ...shared, platform: 'win32', artifact: 10802394350, run: 35987278609, bytes: 244720035,
    name: 'voice-windows-candidate-sensevoice-small-q8-86fa6716eceaf4254fb020664338fcadcce37868',
    commit: '86fa6716eceaf4254fb020664338fcadcce37868',
    archiveSha256: '2796a7666cf36f1f9597af1978af1df1feeec648bbca1036a226cb99ddebe3ab',
    manifestSha256: 'ed605fe13aacaf21d0aceb18127d6bccb0a1099f561aa0ecef95952975cae905',
  }),
});
export function selectDownload(model, platform = process.platform, arch = process.arch) {
  if (model !== shared.model || arch !== 'x64' || !Object.hasOwn(catalogue, platform)) {
    throw new Error('Experimental download supports only SenseVoiceSmall q8 on Linux/Windows x64.');
  }
  return catalogue[platform];
}
export function validateArtifact(value, entry, now = Date.now()) {
  if (!value || value.id !== entry.artifact || value.name !== entry.name
    || value.expired !== false || typeof value.expires_at !== 'string'
    || !(Date.parse(value.expires_at) > now)
    || value.size_in_bytes !== entry.bytes || value.size_in_bytes > 512 * 1024 ** 2
    || value.digest !== `sha256:${entry.archiveSha256}`
    || value.workflow_run?.id !== entry.run || value.workflow_run?.head_sha !== entry.commit
    || value.workflow_run?.repository_id !== entry.repositoryId
    || value.workflow_run?.head_repository_id !== entry.repositoryId) {
    throw new Error('Untrusted or expired experimental voice artifact; the pinned candidate catalogue needs review. No alternative artifact was selected.');
  }
  return value;
}
