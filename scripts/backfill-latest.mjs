import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { downloadAliases, writeDownloadAliases } from './artifacts.mjs'
import { TARGETS } from './build-plan.mjs'

const repository = process.env.GITHUB_REPOSITORY
assert.match(repository ?? '', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'GITHUB_REPOSITORY is required')
const gh = args => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })
const release = JSON.parse(gh(['api', `repos/${repository}/releases/latest`]))
assert.ok(!release.draft && !release.prerelease, 'Only a published stable release can be backfilled')
assert.match(release.tag_name, /^v\d+\.\d+\.\d+$/, 'Invalid release tag')
const directory = await mkdtemp(join(tmpdir(), 'cove-latest-'))
try {
  const download = file => gh(['release', 'download', release.tag_name, '--repo', repository, '--pattern', file, '--dir', directory])
  download('BUILD-INFO.json')
  const manifest = JSON.parse(await readFile(join(directory, 'BUILD-INFO.json'), 'utf8'))
  assert.equal(manifest.product, 'cove', 'Unexpected release product')
  assert.equal(`v${manifest.version}`, release.tag_name, 'Release manifest version mismatch')
  assert.deepEqual(manifest.builds.map(build => `${build.platform}/${build.arch}`).sort(), TARGETS.map(target => `${target.platform}/${target.arch}`).sort(), 'Latest must include all platforms')
  assert.ok(manifest.builds.every(build => build.version === manifest.version), 'Mismatched platform versions')
  const aliases = downloadAliases(manifest.builds)
  const checksum = aliases.map(item => `${item.sha256}  ${item.file}\n`).join('')
  const checksumFile = {
    file: 'SHA256SUMS-latest.txt', size: Buffer.byteLength(checksum),
    sha256: createHash('sha256').update(checksum).digest('hex')
  }
  const assets = new Map(release.assets.map(asset => [asset.name, asset]))
  const missing = [...aliases, checksumFile].filter(item => {
    const existing = assets.get(item.file)
    if (!existing) return true
    assert.equal(existing.size, item.size, `Existing alias size mismatch: ${item.file}`)
    assert.equal(existing.digest, `sha256:${item.sha256}`, `Existing alias checksum mismatch: ${item.file}`)
    return false
  })
  if (missing.length) {
    assert.ok(!release.immutable, 'This release is immutable; publish a new full release to add aliases')
    const missingAliases = aliases.filter(item => missing.includes(item))
    for (const alias of missingAliases) download(alias.sourceFile)
    await writeDownloadAliases({ directory, aliases: missingAliases })
    await writeFile(join(directory, checksumFile.file), checksum)
    // Append missing assets only. Published installers and existing aliases are never replaced.
    gh(['release', 'upload', release.tag_name, ...missing.map(item => join(directory, item.file)), '--repo', repository])
  }
  console.log(`Latest ${release.tag_name}: added ${missing.length} missing download asset(s); existing files preserved`)
} finally {
  await rm(directory, { recursive: true, force: true })
}
