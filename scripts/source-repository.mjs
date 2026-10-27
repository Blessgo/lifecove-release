import { appendFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function resolveSourceRepository(releaseRepository, override = '') {
  const suffix = '-release'
  const repository = override || (typeof releaseRepository === 'string' && releaseRepository.endsWith(suffix) ? releaseRepository.slice(0, -suffix.length) : '')
  const match = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.exec(repository)
  if (!match || match[0] !== repository || repository === releaseRepository) {
    throw new Error('Set COVE_SOURCE_REPOSITORY when the release repository does not use the <source>-release naming convention')
  }
  return repository
}

export function normalizePrivateToken(value) {
  const token = typeof value === 'string' ? value.trim() : ''
  if (!token) throw new Error('PRIVATE_TOKEN is required to read cove source')
  if (!/^[\x21-\x7e]+$/.test(token)) throw new Error('PRIVATE_TOKEN must contain the raw token value without whitespace or header prefixes')
  return token
}

export async function verifySourceAccess({ repository, token, ref, request = fetch, report = console.log }) {
  const checks = [
    ['metadata', ''],
    ['contents', `/contents/package.json?ref=${encodeURIComponent(ref)}`]
  ]
  for (const [label, path] of checks) {
    const response = await request(`https://api.github.com/repos/${repository}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
    })
    const body = await response.json().catch(() => ({}))
    report(`cove source ${label}: HTTP ${response.status}`)
    if (!response.ok) {
      const message = typeof body.message === 'string'
        ? body.message.replaceAll(token, '[redacted]').replaceAll(repository, 'cove').replace(/[\r\n]/g, ' ')
        : 'GitHub denied access'
      throw new Error(`PRIVATE_TOKEN ${label} check failed: HTTP ${response.status}, ${message}. The token needs access to the private source repository with Contents: Read and any required organization authorization.`)
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const token = normalizePrivateToken(process.env.PRIVATE_TOKEN)
  const repository = resolveSourceRepository(process.env.GITHUB_REPOSITORY, process.env.SOURCE_REPOSITORY_OVERRIDE)
  // This output stays within the composite action's job; private addresses never become job outputs.
  console.log(`::add-mask::${token}`)
  console.log(`::add-mask::${repository}`)
  console.log(`::add-mask::${repository.split('/')[1]}`)
  await verifySourceAccess({ repository, token, ref: process.env.SOURCE_REF || 'main' })
  await appendFile(process.env.GITHUB_OUTPUT, `repository=${repository}\ntoken=${token}\n`)
}
