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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.env.PRIVATE_TOKEN) throw new Error('PRIVATE_TOKEN is required to read cove source')
  const repository = resolveSourceRepository(process.env.GITHUB_REPOSITORY, process.env.SOURCE_REPOSITORY_OVERRIDE)
  // This output stays within the composite action's job; private addresses never become job outputs.
  console.log(`::add-mask::${repository}`)
  console.log(`::add-mask::${repository.split('/')[1]}`)
  await appendFile(process.env.GITHUB_OUTPUT, `repository=${repository}\n`)
}
