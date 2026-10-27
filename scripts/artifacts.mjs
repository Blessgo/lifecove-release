import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { installerNames, releaseVersion, selectTargets, validateVersion } from './build-plan.mjs'

export async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function checksumText(artifacts) {
  return artifacts.map(item => `${item.sha256}  ${item.file}\n`).join('')
}

function verifyBuildNumber(version, buildNumber) {
  validateVersion(version)
  const base = version.split('.').slice(0, 2).join('.')
  assert.equal(version, releaseVersion(base, buildNumber), 'Release version must include the current build number')
}

export async function collectArtifacts({ sourceDirectory, outputDirectory, version, buildNumber, platform, arch, sourceSha, sourceRef, sourceVersion, releaseCommit, runId, runAttempt, electron }) {
  verifyBuildNumber(version, buildNumber)
  const sourceManifest = JSON.parse(await readFile(join(sourceDirectory, 'package.json'), 'utf8'))
  const expected = installerNames({ version, platform, arch, installerPrefix: sourceManifest.name }).sort()
  assert.equal(sourceManifest.version, sourceVersion, 'Source version changed after preparation')
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceDirectory, encoding: 'utf8' }).trim()
  assert.equal(commit, sourceSha, 'Source commit changed after preparation')
  const directory = join(sourceDirectory, 'release')
  const entries = await readdir(directory, { withFileTypes: true })
  const installers = entries.filter(entry => /\.(exe|dmg|zip|AppImage)$/.test(entry.name)).map(entry => entry.name).sort()
  assert.deepEqual(installers, expected, 'Missing or unexpected installers in build output')
  await mkdir(outputDirectory, { recursive: true })
  assert.equal((await readdir(outputDirectory)).length, 0, 'Release output directory must be empty')
  const artifacts = []
  for (const file of expected) {
    const path = join(directory, file)
    const stat = await lstat(path)
    assert.ok(stat.isFile() && stat.size > 0, `Installer is not a nonempty regular file: ${file}`)
    const destination = join(outputDirectory, file)
    await copyFile(path, destination)
    artifacts.push({ file, size: stat.size, sha256: await sha256(destination) })
  }
  const info = {
    product: 'cove', installerPrefix: sourceManifest.name, channel: 'release', version, buildNumber: String(buildNumber), platform, arch, electron,
    source: { ref: sourceRef, commit: sourceSha, version: sourceVersion },
    releaseCommit, runId, runAttempt, builtAt: new Date().toISOString(), updatesEnabled: false, artifacts
  }
  const suffix = `${platform}-${arch}`
  await writeFile(join(outputDirectory, `SHA256SUMS-${suffix}.txt`), checksumText(artifacts))
  await writeFile(join(outputDirectory, `BUILD-INFO-${suffix}.json`), `${JSON.stringify(info, null, 2)}\n`)
  return info
}

export async function assembleRelease({ directory, version, buildNumber, sourceSha, sourceVersion, releaseCommit, runId, platform = 'all' }) {
  verifyBuildNumber(version, buildNumber)
  const expectedFiles = []
  const builds = []
  const artifacts = []
  const installerProducts = new Set()
  for (const target of selectTargets(platform)) {
    const suffix = `${target.platform}-${target.arch}`
    const infoName = `BUILD-INFO-${suffix}.json`
    const sumsName = `SHA256SUMS-${suffix}.txt`
    const info = JSON.parse(await readFile(join(directory, infoName), 'utf8'))
    assert.equal(info.product, 'cove', 'Mismatched release product')
    assert.equal(info.channel, 'release', 'Only release installers can be published')
    assert.equal(info.version, version, 'Mismatched release version')
    assert.equal(info.buildNumber, String(buildNumber), 'Mismatched build number')
    assert.equal(info.platform, target.platform, 'Mismatched build platform')
    assert.equal(info.arch, target.arch, 'Mismatched build architecture')
    assert.deepEqual(Object.keys(info.source).sort(), ['commit', 'ref', 'version'], 'Source metadata must not include repository addresses')
    assert.equal(info.source.commit, sourceSha, 'Mismatched source commit')
    assert.equal(info.source.version, sourceVersion, 'Mismatched source version')
    assert.equal(info.releaseCommit, releaseCommit, 'Mismatched release tooling commit')
    assert.equal(info.runId, runId, 'Mismatched workflow run')
    const expected = installerNames({ version, ...target, installerPrefix: info.installerPrefix }).sort()
    installerProducts.add(info.installerPrefix)
    assert.deepEqual(info.artifacts.map(item => item.file).sort(), expected, 'Missing or unexpected installer in manifest')
    assert.equal(await readFile(join(directory, sumsName), 'utf8'), checksumText(info.artifacts), 'Mismatched checksum manifest')
    for (const item of info.artifacts) {
      const path = join(directory, item.file)
      const stat = await lstat(path)
      assert.ok(stat.isFile() && stat.size > 0, `Invalid installer: ${item.file}`)
      assert.equal(stat.size, item.size, `Installer size mismatch: ${item.file}`)
      assert.equal(await sha256(path), item.sha256, `Installer checksum mismatch: ${item.file}`)
      artifacts.push(item)
    }
    expectedFiles.push(infoName, sumsName, ...expected)
    builds.push(info)
  }
  assert.equal(installerProducts.size, 1, 'Mismatched installer product names')
  assert.deepEqual((await readdir(directory)).sort(), expectedFiles.sort(), 'Unexpected files in release artifacts')
  artifacts.sort((a, b) => a.file.localeCompare(b.file))
  await writeFile(join(directory, 'SHA256SUMS.txt'), checksumText(artifacts))
  await writeFile(join(directory, 'BUILD-INFO.json'), `${JSON.stringify({ product: 'cove', version, buildNumber: String(buildNumber), sourceSha, releaseCommit, builds }, null, 2)}\n`)
  const targets = builds.map(build => `${build.platform}/${build.arch}`).join(', ')
  const notes = `cove v${version}\n\nBuild: ${buildNumber}\n\nSource commit: ${sourceSha}\n\nPlatforms: ${targets}\n\nVerify downloads using SHA256SUMS.txt. BUILD-INFO.json records version and build details.\n\nCode signing depends on the configured CI certificates. macOS builds without a certificate use ad-hoc signing and are not notarized. Automatic updates are not configured by this workflow.\n`
  await writeFile(join(directory, 'RELEASE-NOTES.md'), notes)
  return { builds, artifacts }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const expected = {
    version: process.env.BUILD_VERSION,
    buildNumber: process.env.GITHUB_RUN_NUMBER,
    sourceSha: process.env.SOURCE_SHA,
    sourceVersion: process.env.SOURCE_VERSION,
    releaseCommit: process.env.GITHUB_SHA,
    runId: process.env.GITHUB_RUN_ID
  }
  if (process.argv[2] === 'collect') {
    const sourceDirectory = resolve(process.argv[3] ?? 'source')
    const electron = JSON.parse(await readFile(join(sourceDirectory, 'node_modules', 'electron', 'package.json'), 'utf8')).version
    const info = await collectArtifacts({
      ...expected, sourceDirectory, outputDirectory: resolve(process.argv[4] ?? 'release'), electron,
      platform: process.env.BUILD_PLATFORM, arch: process.env.BUILD_ARCH,
      sourceRef: process.env.SOURCE_REF, runAttempt: process.env.GITHUB_RUN_ATTEMPT
    })
    console.log(`Collected ${info.artifacts.length} cove ${info.version} installer(s) for ${info.platform}/${info.arch}`)
  } else if (process.argv[2] === 'release') {
    const result = await assembleRelease({ ...expected, directory: resolve(process.argv[3] ?? 'release'), platform: process.env.BUILD_PLATFORM_SELECTION || 'all' })
    console.log(`Verified ${result.artifacts.length} installers from ${result.builds.length} targets`)
  } else {
    throw new Error('Usage: node scripts/artifacts.mjs collect <source> <output> | release <release-directory>')
  }
}
