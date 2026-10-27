import { execFileSync } from 'node:child_process'
import { appendFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const TARGETS = [
  { platform: 'windows', arch: 'x64', runner: 'windows-2025' },
  { platform: 'linux', arch: 'x64', runner: 'ubuntu-24.04' },
  { platform: 'macos', arch: 'x64', runner: 'macos-15-intel' },
  { platform: 'macos', arch: 'arm64', runner: 'macos-15' }
]

export function validateVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version)
  if (!match || match[0] !== version || match[4]?.split('.').some(part => /^0\d+$/.test(part))) {
    throw new Error('Invalid package version')
  }
  return version
}

export function selectTargets(platform = 'all') {
  if (!['all', 'windows', 'macos', 'linux'].includes(platform)) throw new Error('Unsupported platform')
  return TARGETS.filter(target => platform === 'all' || target.platform === platform)
}

export function releaseVersion(baseVersion, runNumber) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(baseVersion)
  if (!match || match[0] !== baseVersion) throw new Error('Version series must be MAJOR.MINOR or vMAJOR.MINOR')
  const build = String(runNumber)
  if (!/^[1-9]\d*$/.test(build) || String(Number(build)) !== build || !Number.isSafeInteger(Number(build))) {
    throw new Error('Build number must be a positive safe integer')
  }
  return `${match[1]}.${match[2]}.${build}`
}

export function installerNames({ version, platform, arch, installerPrefix }) {
  validateVersion(version)
  const prefix = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.exec(installerPrefix)
  if (!prefix || prefix[0] !== installerPrefix) throw new Error('Invalid installer product name')
  if (!TARGETS.some(target => target.platform === platform && target.arch === arch)) {
    throw new Error('Unsupported build target')
  }
  const os = { windows: 'win', linux: 'linux', macos: 'mac' }[platform]
  const artifactArch = platform === 'linux' ? 'x86_64' : arch
  const extensions = { windows: ['exe'], linux: ['AppImage'], macos: ['dmg', 'zip'] }[platform]
  return extensions.map(extension => `${installerPrefix}-${version}-${os}-${artifactArch}.${extension}`)
}

export function createBuildPlan({ eventName, ref, sourceRef, sourceSha, sourceVersion, baseVersion, runNumber, platform = 'all' }) {
  validateVersion(sourceVersion)
  if (typeof sourceSha !== 'string' || sourceSha.length !== 40 || !/^[a-f0-9]{40}$/.test(sourceSha)) {
    throw new Error('Source commit must be a full SHA')
  }
  if (typeof sourceRef !== 'string' || !sourceRef || /[\x00-\x1f\x7f]/.test(sourceRef)) throw new Error('Invalid source ref')
  if (eventName === 'push' && ref?.startsWith('refs/tags/')) baseVersion = ref.slice('refs/tags/'.length)
  const base = baseVersion || sourceVersion.split('.').slice(0, 2).join('.')
  const version = releaseVersion(base, runNumber)
  return {
    source_sha: sourceSha,
    source_ref: sourceRef,
    source_version: sourceVersion,
    version,
    build_number: String(runNumber),
    platform,
    release_tag: `v${version}`,
    matrix: { include: selectTargets(platform) }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = resolve(process.argv[2] ?? 'source')
  const manifest = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'))
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim()
  const plan = createBuildPlan({
    eventName: process.env.GITHUB_EVENT_NAME,
    ref: process.env.GITHUB_REF,
    sourceRef: process.env.SOURCE_REF ?? 'main',
    sourceSha,
    sourceVersion: manifest.version,
    baseVersion: process.env.BASE_VERSION,
    runNumber: process.env.GITHUB_RUN_NUMBER,
    platform: process.env.REQUESTED_PLATFORM || 'all'
  })
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, Object.entries(plan).map(([key, value]) =>
      `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}\n`).join(''))
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY,
      `## cove ${plan.release_tag}\n\nBuild: **${plan.build_number}**\n\nSource commit: ${sourceSha}\n`)
  }
  console.log(JSON.stringify(plan, null, 2))
}
