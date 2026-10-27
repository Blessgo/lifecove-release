import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createBuildPlan, installerNames, releaseVersion, selectTargets, TARGETS } from '../scripts/build-plan.mjs'
import { assembleRelease, collectArtifacts, downloadAliases, sha256, writeDownloadAliases } from '../scripts/artifacts.mjs'
import { normalizePrivateToken, resolveSourceRepository, verifySourceAccess } from '../scripts/source-repository.mjs'

const version = '0.1.42'
const sourceVersion = '0.1.0'
const installerPrefix = 'original-product'
const sourceSha = 'a'.repeat(40)
const releaseCommit = 'b'.repeat(40)
const defaults = { eventName: 'workflow_dispatch', sourceRef: 'main', sourceSha, sourceVersion, runNumber: '42' }

test('source repository is derived from the release name without a hardcoded address', () => {
  assert.equal(resolveSourceRepository('example/cove-release'), 'example/cove')
  assert.equal(resolveSourceRepository('example/cove-release', 'example/private-cove'), 'example/private-cove')
  assert.throws(() => resolveSourceRepository('example/downloads'), /COVE_SOURCE_REPOSITORY/)
  assert.throws(() => resolveSourceRepository('example/cove-release', 'example/private-cove\n'), /COVE_SOURCE_REPOSITORY/)
  assert.throws(() => resolveSourceRepository('example/cove-release', 'example/cove-release'), /COVE_SOURCE_REPOSITORY/)
})

test('private token normalization trims pasted whitespace without accepting embedded headers', () => {
  assert.equal(normalizePrivateToken(' \tfixture-token\r\n'), 'fixture-token')
  assert.throws(() => normalizePrivateToken('Bearer fixture-token'), /raw token value/)
  assert.throws(() => normalizePrivateToken(' \n'), /required/)
})

test('source access checks require contents access for the requested ref', async () => {
  const requests = []
  await verifySourceAccess({
    repository: 'example/cove', token: 'fixture-token', ref: 'feature/ui', report: () => {},
    request: async (url, options) => {
      requests.push({ url, options })
      return { ok: true, status: 200, json: async () => ({}) }
    }
  })
  assert.equal(requests.length, 2)
  assert.ok(requests[1].url.endsWith('/contents/package.json?ref=feature%2Fui'))
  assert.equal(requests[1].options.headers.Authorization, 'Bearer fixture-token')
  await assert.rejects(verifySourceAccess({
    repository: 'example/cove', token: 'fixture-token', ref: 'main', report: () => {},
    request: async () => ({ ok: false, status: 403, json: async () => ({ message: 'Resource not accessible by personal access token' }) })
  }), /HTTP 403, Resource not accessible by personal access token/)
})

test('a source version keeps its major.minor and gains the current build number', () => {
  const plan = createBuildPlan(defaults)
  assert.equal(plan.version, '0.1.42')
  assert.equal(plan.release_tag, 'v0.1.42')
  assert.equal(plan.source_version, '0.1.0')
  assert.equal(plan.source_sha, sourceSha)
  assert.equal(plan.matrix.include.length, 4)
  assert.equal(createBuildPlan({ ...defaults, sourceVersion: '0.1.99' }).version, '0.1.42')
})

test('new runs increment versions while reruns keep the same version', () => {
  assert.equal(createBuildPlan({ ...defaults, runNumber: '43' }).version, '0.1.43')
  assert.equal(createBuildPlan(defaults).version, createBuildPlan(defaults).version)
  assert.equal(releaseVersion('v2.3', '42'), '2.3.42')
})

test('manual prefixes and version-series tags are independent of source refs', () => {
  assert.equal(createBuildPlan({ ...defaults, baseVersion: 'v1.2' }).version, '1.2.42')
  const plan = createBuildPlan({ ...defaults, eventName: 'push', ref: 'refs/tags/v0.1' })
  assert.equal(plan.version, version)
  assert.equal(plan.source_ref, 'main')
  assert.throws(() => createBuildPlan({ ...defaults, eventName: 'push', ref: 'refs/tags/v0.1.0' }), /Version series/)
})

test('macOS selection includes both architectures and other platforms remain selectable', () => {
  assert.deepEqual(createBuildPlan({ ...defaults, platform: 'macos' }).matrix.include.map(target => target.arch), ['x64', 'arm64'])
  assert.equal(selectTargets('windows').length, 1)
  assert.equal(selectTargets('linux').length, 1)
})

test('invalid version series, counters, source refs and targets are rejected', () => {
  for (const invalid of ['v0.01', 'v0.1.0', 'v0.1-rc', 'v0.1\n', 'v0.1\nother=value']) {
    assert.throws(() => releaseVersion(invalid, '42'), /Version series/)
  }
  for (const invalid of [undefined, '0', '01', '-1', '1.2', '42\n', '9007199254740992']) {
    assert.throws(() => releaseVersion('v0.1', invalid), /Build number/)
  }
  assert.throws(() => createBuildPlan({ ...defaults, sourceSha: `${sourceSha}\n` }), /full SHA/)
  assert.throws(() => createBuildPlan({ ...defaults, sourceRef: 'main\nversion=1.2.3' }), /source ref/)
  assert.throws(() => createBuildPlan({ ...defaults, sourceVersion: '0.1.0\n' }), /package version/)
  assert.throws(() => createBuildPlan({ ...defaults, platform: 'android' }), /platform/)
})

test('release installer names include the build version and distinguish architectures', () => {
  const names = TARGETS.flatMap(target => installerNames({ ...target, version, installerPrefix }))
  assert.equal(names.length, 6)
  assert.equal(new Set(names).size, 6)
  assert.ok(names.every(name => name.startsWith('original-product-0.1.42-')))
  assert.ok(names.includes('original-product-0.1.42-linux-x86_64.AppImage'))
  assert.throws(() => installerNames({ ...TARGETS[0], version, installerPrefix: '../outside' }), /product name/)
})

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'cove release test '))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const sourceDirectory = join(directory, 'private source')
  await mkdir(sourceDirectory)
  await writeFile(join(sourceDirectory, 'package.json'), JSON.stringify({ name: installerPrefix, version: sourceVersion }))
  execFileSync('git', ['init', '--quiet'], { cwd: sourceDirectory })
  execFileSync('git', ['add', 'package.json'], { cwd: sourceDirectory })
  execFileSync('git', ['-c', 'user.name=Release Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'Fixture'], { cwd: sourceDirectory })
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceDirectory, encoding: 'utf8' }).trim()
  return {
    directory, sourceDirectory, outputDirectory: join(directory, 'release'),
    version, sourceVersion, installerPrefix, buildNumber: '42', sourceSha: commit, sourceRef: 'main', releaseCommit,
    runId: '123', runAttempt: '1', electron: '45.0.0'
  }
}

test('packaging preserves upstream product names and embeds the generated release version', async t => {
  const options = await fixture(t)
  await writeFile(join(options.sourceDirectory, 'electron-builder.config.cjs'), `module.exports = {
    appId: 'com.example.cove', productName: 'Original Product', executableName: 'original-product',
    extraMetadata: { coveChannel: process.env.ORIGINAL_PRODUCT_BUILD_CHANNEL }, mac: {}
  }`)
  const builderDirectory = join(options.sourceDirectory, 'node_modules', 'electron-builder')
  await mkdir(builderDirectory, { recursive: true })
  await writeFile(join(builderDirectory, 'cli.js'), `
    const config = require(process.argv[process.argv.indexOf('--config') + 1])
    require('node:fs').writeFileSync('received-config.json', JSON.stringify(config))
    require('node:fs').writeFileSync('received-signing-env.json', JSON.stringify({
      cscLinkPresent: Object.hasOwn(process.env, 'CSC_LINK'),
      cscPasswordPresent: Object.hasOwn(process.env, 'CSC_KEY_PASSWORD'),
      appleIdPresent: Object.hasOwn(process.env, 'APPLE_ID'),
      applePasswordPresent: Object.hasOwn(process.env, 'APPLE_APP_SPECIFIC_PASSWORD'),
      appleTeamPresent: Object.hasOwn(process.env, 'APPLE_TEAM_ID')
    }))
  `)
  const buildEnv = {
    ...process.env, BUILD_VERSION: version, BUILD_PLATFORM: 'macos', BUILD_ARCH: 'arm64', ORIGINAL_PRODUCT_BUILD_CHANNEL: 'unexpected',
    CSC_LINK: '', CSC_KEY_PASSWORD: '', APPLE_ID: '', APPLE_APP_SPECIFIC_PASSWORD: '', APPLE_TEAM_ID: ''
  }
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/package.mjs', import.meta.url)), options.sourceDirectory], {
    env: buildEnv,
    encoding: 'utf8'
  })
  assert.equal(result.status, 0, result.stderr)
  const config = JSON.parse(await readFile(join(options.sourceDirectory, 'received-config.json'), 'utf8'))
  assert.equal(config.extraMetadata.version, version)
  assert.equal(config.buildVersion, version)
  assert.equal(config.extraMetadata.coveChannel, 'stable')
  assert.equal(config.productName, 'Original Product')
  assert.equal(config.executableName, 'original-product')
  assert.equal(config.artifactName, '${name}-${version}-${os}-${arch}.${ext}')
  assert.equal(config.appId, 'com.example.cove')
  assert.equal(config.directories.output, 'release')
  assert.equal(config.publish, null)
  assert.equal(config.mac.identity, '-')
  assert.equal(config.mac.hardenedRuntime, false)
  assert.equal(config.mac.notarize, false)
  assert.deepEqual(JSON.parse(await readFile(join(options.sourceDirectory, 'received-signing-env.json'), 'utf8')), {
    cscLinkPresent: false, cscPasswordPresent: false, appleIdPresent: false, applePasswordPresent: false, appleTeamPresent: false
  })
  assert.equal(JSON.parse(await readFile(join(options.sourceDirectory, 'package.json'), 'utf8')).version, sourceVersion)

  const signed = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/package.mjs', import.meta.url)), options.sourceDirectory], {
    env: { ...buildEnv, CSC_LINK: 'fixture-certificate', CSC_KEY_PASSWORD: 'fixture-password' }, encoding: 'utf8'
  })
  assert.equal(signed.status, 0, signed.stderr)
  const signingEnv = JSON.parse(await readFile(join(options.sourceDirectory, 'received-signing-env.json'), 'utf8'))
  assert.equal(signingEnv.cscLinkPresent, true)
  assert.equal(signingEnv.cscPasswordPresent, true)
  assert.equal('identity' in JSON.parse(await readFile(join(options.sourceDirectory, 'received-config.json'), 'utf8')).mac, false)
})

async function writeInstallers(options, target) {
  const directory = join(options.sourceDirectory, 'release')
  await rm(directory, { recursive: true, force: true })
  await mkdir(directory, { recursive: true })
  for (const file of installerNames({ ...options, ...target })) await writeFile(join(directory, file), `installer: ${file}`)
  await writeFile(join(directory, 'builder-effective-config.yaml'), 'internal configuration')
  await writeFile(join(options.sourceDirectory, 'private-source.ts'), 'private source')
  return directory
}

async function completeRelease(t, platform = 'all') {
  const options = await fixture(t)
  await mkdir(options.outputDirectory)
  for (const target of selectTargets(platform)) {
    await writeInstallers(options, target)
    const destination = join(options.directory, `${target.platform}-${target.arch}`)
    await collectArtifacts({ ...options, ...target, outputDirectory: destination })
    for (const file of await readdir(destination)) await writeFile(join(options.outputDirectory, file), await readFile(join(destination, file)))
  }
  return { ...options, directory: options.outputDirectory, platform }
}

test('collection keeps source and release versions separate and omits private addresses', async t => {
  const options = await fixture(t)
  const target = TARGETS[0]
  await writeInstallers(options, target)
  const info = await collectArtifacts({ ...options, ...target })
  assert.equal(info.product, 'cove')
  assert.equal(info.installerPrefix, installerPrefix)
  assert.equal(info.channel, 'release')
  assert.equal(info.version, '0.1.42')
  assert.equal(info.source.version, '0.1.0')
  assert.deepEqual(Object.keys(info.source).sort(), ['commit', 'ref', 'version'])
  assert.equal(info.artifacts[0].sha256, await sha256(join(options.outputDirectory, info.artifacts[0].file)))
  assert.deepEqual((await readdir(options.outputDirectory)).sort(), [
    'BUILD-INFO-windows-x64.json', 'SHA256SUMS-windows-x64.txt', 'original-product-0.1.42-win-x64.exe'
  ])
})

test('collection rejects missing, stale and inconsistent builds', async t => {
  const options = await fixture(t)
  const target = TARGETS[2]
  const directory = await writeInstallers(options, target)
  await rm(join(directory, 'original-product-0.1.42-mac-x64.zip'))
  await assert.rejects(collectArtifacts({ ...options, ...target }), /Missing or unexpected installers/)
  await assert.rejects(collectArtifacts({ ...options, ...target, sourceSha }), /Source commit changed/)
  await assert.rejects(collectArtifacts({ ...options, ...target, sourceVersion: '9.0.0' }), /Source version changed/)
  await assert.rejects(collectArtifacts({ ...options, ...target, buildNumber: '43' }), /current build number/)
  await writeInstallers(options, target)
  await writeFile(join(directory, 'old.zip'), 'stale installer')
  await assert.rejects(collectArtifacts({ ...options, ...target }), /Missing or unexpected installers/)
})

test('release assembly verifies all six installers and writes address-free release notes', async t => {
  const options = await completeRelease(t)
  const release = await assembleRelease(options)
  assert.equal(release.builds.length, 4)
  assert.equal(release.artifacts.length, 6)
  const sums = await readFile(join(options.directory, 'SHA256SUMS.txt'), 'utf8')
  assert.equal(sums.trim().split('\n').length, 10)
  assert.equal(release.aliases.length, 4)
  for (const alias of release.aliases) {
    assert.equal(await sha256(join(options.directory, alias.file)), alias.sha256)
    assert.deepEqual(await readFile(join(options.directory, alias.file)), await readFile(join(options.directory, alias.sourceFile)))
    assert.ok(!alias.file.includes(version))
  }
  assert.equal((await readFile(join(options.directory, 'SHA256SUMS-latest.txt'), 'utf8')).trim().split('\n').length, 4)
  const info = JSON.parse(await readFile(join(options.directory, 'BUILD-INFO.json'), 'utf8'))
  assert.equal(info.version, version)
  assert.equal(info.buildNumber, '42')
  assert.equal(info.sourceSha, options.sourceSha)
  assert.doesNotMatch(await readFile(join(options.directory, 'RELEASE-NOTES.md'), 'utf8'), /https?:\/\//)
})

test('a selected platform can be published as a complete release', async t => {
  const options = await completeRelease(t, 'windows')
  const release = await assembleRelease(options)
  assert.equal(release.builds.length, 1)
  assert.equal(release.artifacts[0].file, 'original-product-0.1.42-win-x64.exe')
  assert.equal(release.aliases[0].file, 'original-product-win-x64.exe')
})

test('alias creation verifies original bytes and refuses to overwrite an existing download', async t => {
  const options = await completeRelease(t, 'windows')
  const info = JSON.parse(await readFile(join(options.directory, 'BUILD-INFO-windows-x64.json'), 'utf8'))
  const aliases = downloadAliases([info])
  const aliasPath = join(options.directory, aliases[0].file)
  await writeFile(aliasPath, 'already published bytes')
  await assert.rejects(writeDownloadAliases({ directory: options.directory, aliases }), /EEXIST/)
  assert.equal(await readFile(aliasPath, 'utf8'), 'already published bytes')
  await rm(aliasPath)
  const sourcePath = join(options.directory, aliases[0].sourceFile)
  const bytes = await readFile(sourcePath)
  bytes[0] ^= 1
  await writeFile(sourcePath, bytes)
  await assert.rejects(writeDownloadAliases({ directory: options.directory, aliases }), /checksum mismatch/)
  await assert.rejects(readFile(aliasPath), /ENOENT/)
  assert.throws(() => downloadAliases([info, info]), /Duplicate download alias/)
})

test('release assembly detects corruption even when file size is unchanged', async t => {
  const options = await completeRelease(t)
  const path = join(options.directory, 'original-product-0.1.42-win-x64.exe')
  const bytes = await readFile(path)
  bytes[0] ^= 1
  await writeFile(path, bytes)
  await assert.rejects(assembleRelease(options), /checksum mismatch/)
})

test('release assembly rejects other source commits, workflow runs and build numbers', async t => {
  const options = await completeRelease(t)
  await assert.rejects(assembleRelease({ ...options, sourceSha }), /Mismatched source commit/)
  await assert.rejects(assembleRelease({ ...options, runId: '999' }), /Mismatched workflow run/)
  await assert.rejects(assembleRelease({ ...options, buildNumber: '43' }), /current build number/)
})

test('release assembly rejects unexpected files and requires every selected target', async t => {
  const options = await completeRelease(t)
  const extra = join(options.directory, 'private-source.ts')
  await writeFile(extra, 'must not be uploaded')
  await assert.rejects(assembleRelease(options), /Unexpected files/)
  await rm(extra)
  const path = join(options.directory, 'BUILD-INFO-macos-arm64.json')
  const info = JSON.parse(await readFile(path, 'utf8'))
  await writeFile(path, JSON.stringify({ ...info, source: { ...info.source, repository: 'private' } }))
  await assert.rejects(assembleRelease(options), /must not include repository addresses/)
  await rm(path)
  await assert.rejects(assembleRelease(options), /ENOENT/)
})
