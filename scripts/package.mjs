import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { installerNames } from './build-plan.mjs'

const directory = resolve(process.argv[2] ?? 'source')
const { BUILD_PLATFORM: platform, BUILD_ARCH: arch, BUILD_VERSION: version } = process.env
const require = createRequire(join(directory, 'package.json'))
const manifest = require('./package.json')
installerNames({ platform, arch, version, installerPrefix: manifest.name })
const temporary = await mkdtemp(join(tmpdir(), 'cove-release-'))
const configPath = join(temporary, 'electron-builder.cjs')
// Select the upstream production profile without exposing upstream product identifiers here.
const channelKey = `${manifest.name.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}_BUILD_CHANNEL`
const env = { ...process.env, [channelKey]: 'stable' }
if (!env.CSC_LINK) env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
try {
  await writeFile(configPath, `
const base = require(${JSON.stringify(join(directory, 'electron-builder.config.cjs'))})
module.exports = {
  ...base,
  buildVersion: ${JSON.stringify(version)},
  extraMetadata: { ...base.extraMetadata, version: ${JSON.stringify(version)} },
  directories: { ...base.directories, output: 'release' },
  artifactName: ${JSON.stringify('${name}-${version}-${os}-${arch}.${ext}')},
  publish: null,
  mac: { ...base.mac${!env.CSC_LINK ? ", identity: '-', hardenedRuntime: false, notarize: false" : ''} }
}
`)
  const flag = { windows: 'win', macos: 'mac', linux: 'linux' }[platform]
  const result = spawnSync(process.execPath, [
    require.resolve('electron-builder/cli.js'), '--config', configPath, '--publish', 'never', `--${flag}`, `--${arch}`
  ], { cwd: directory, env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`electron-builder failed with status ${result.status}`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
